import { UnrecoverableError, Worker, type WorkerOptions } from "bullmq";
import type Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, notificationPreferences, notifications, users } from "@/lib/db/schema";
import { sendEmail as sendEmailViaProvider, type SendEmailInput, type SendEmailOptions, type SendEmailResult } from "@/lib/email/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { notificationEmailContent } from "@/lib/notifications/email-content";
import {
  NOTIFICATION_JOB_ATTEMPTS,
  NOTIFICATION_QUEUE_NAME,
  notificationBackoffStrategy,
  type NotificationJobData,
  type NotificationJobName,
} from "@/lib/notifications/queue";
import { MANDATORY_NOTIFICATION_TEMPLATE_IDS, isNotificationTemplateId } from "@/lib/notifications/templates";
import { withTimeout } from "@/lib/with-timeout";

/**
 * Notification delivery (PLAN.md Phase 5 Item 58a; deployment readiness
 * Step 2). Runs only in the dedicated worker process (scripts/worker.ts).
 *
 * Email: real delivery through the existing Resend client. One recipient
 * per notification — the row's `user_id`. The `notifications` row is the
 * source of truth: a job for a row already `sent` does nothing, and every
 * send carries the row id as Resend's idempotency key, so a retry after a
 * crash between "sent" and "recorded" is not delivered twice.
 *
 * Outcomes:
 * - sent                       -> row `sent`
 * - transient failure          -> rethrown; BullMQ retries on PLAN.md's
 *                                 1m/5m/15m/1h/6h schedule, row stays
 *                                 `pending` until the final attempt
 * - not deliverable by design  -> row `failed` with a `skipped: <reason>`
 *   (SMS has no provider, no     note; the job completes (no retries, no
 *   individual recipient,        noise in the failed-job count)
 *   recipient opted out or
 *   inactive)
 * - programming error          -> UnrecoverableError; row `failed`
 *   (unknown template)
 *
 * Logs carry ids, template and outcome only — never addresses, content or
 * tokens.
 */

export const EMAIL_DELIVERY_TIMEOUT_MS = 20_000;

export type EmailSender = (input: SendEmailInput, options: SendEmailOptions) => Promise<SendEmailResult>;

/** Test runs must never reach the email provider. */
const defaultEmailSender: EmailSender = (input, options) =>
  env.NODE_ENV === "test"
    ? Promise.resolve({ ok: false, error: "Email delivery is disabled in tests." })
    : sendEmailViaProvider(input, options);

export interface NotificationDeliveryDeps {
  sendEmail: EmailSender;
  appUrl: string | undefined;
  deliveryTimeoutMs: number;
}

function defaultDeps(): NotificationDeliveryDeps {
  return { sendEmail: defaultEmailSender, appUrl: env.APP_URL, deliveryTimeoutMs: EMAIL_DELIVERY_TIMEOUT_MS };
}

type DeliveryOutcome = { kind: "sent" } | { kind: "skipped"; reason: string };

type NotificationRow = typeof notifications.$inferSelect;

const recipientSchema = z.string().trim().email().max(320);
const subjectSchema = z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value));
const bodySchema = z.string().trim().min(1).max(50_000);

async function deliverEmail(row: NotificationRow, executor: DbClient, deps: NotificationDeliveryDeps): Promise<DeliveryOutcome> {
  if (!isNotificationTemplateId(row.templateId)) {
    throw new UnrecoverableError("unknown_template");
  }
  // Shared academy-wide rows (no user_id) have no individual email recipient.
  if (!row.userId) return { kind: "skipped", reason: "no_individual_recipient" };

  const [user] = await executor
    .select({ email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user) return { kind: "skipped", reason: "recipient_missing" };
  if (user.status !== "active") return { kind: "skipped", reason: "recipient_inactive" };

  // Opt-outs apply to academy notifications; security and suspension
  // notices are mandatory (lib/notifications/templates.ts).
  if (row.academyId && !MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(row.templateId)) {
    const [preference] = await executor
      .select({ enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, row.userId),
          eq(notificationPreferences.academyId, row.academyId),
          eq(notificationPreferences.templateId, row.templateId),
        ),
      )
      .limit(1);
    if (preference && !preference.enabled) return { kind: "skipped", reason: "recipient_opted_out" };
  }

  let academyName: string | null = null;
  if (row.academyId) {
    const [academy] = await executor.select({ name: academies.name }).from(academies).where(eq(academies.id, row.academyId)).limit(1);
    academyName = academy?.name ?? null;
  }

  const content = notificationEmailContent(row.templateId, { academyName, appUrl: deps.appUrl });
  const to = recipientSchema.safeParse(user.email);
  if (!to.success) return { kind: "skipped", reason: "recipient_invalid" };
  if (!subjectSchema.safeParse(content.subject).success || !bodySchema.safeParse(content.text).success || !bodySchema.safeParse(content.html).success) {
    throw new UnrecoverableError("invalid_email_content");
  }

  const result = await withTimeout(
    deps.sendEmail(
      { to: to.data, subject: content.subject, html: content.html, text: content.text },
      { idempotencyKey: `notification-${row.id}` },
    ),
    deps.deliveryTimeoutMs,
    "email delivery",
  );
  if (!result.ok) throw new Error(`email_delivery_failed: ${result.error}`);
  return { kind: "sent" };
}

async function markSent(notificationId: string, executor: DbClient): Promise<void> {
  await executor.update(notifications).set({ status: "sent", sentAt: new Date() }).where(eq(notifications.id, notificationId));
}

async function markSkipped(notificationId: string, reason: string, executor: DbClient): Promise<void> {
  await executor
    .update(notifications)
    .set({ status: "failed", lastError: `skipped: ${reason}` })
    .where(eq(notifications.id, notificationId));
}

async function markFailedAttempt(
  notificationId: string,
  attemptCount: number,
  lastError: string,
  permanent: boolean,
  executor: DbClient,
): Promise<void> {
  await executor
    .update(notifications)
    .set({ attemptCount, lastError, status: permanent ? "failed" : "pending" })
    .where(eq(notifications.id, notificationId));
}

/**
 * The minimal shape `processNotificationJob` needs from a BullMQ `Job` —
 * lets tests drive it without a live queue.
 */
export interface MinimalNotificationJob {
  name: NotificationJobName;
  data: NotificationJobData;
  attemptsMade: number;
  opts?: { attempts?: number };
}

export async function processNotificationJob(
  job: MinimalNotificationJob,
  executor: DbClient = db,
  deps: NotificationDeliveryDeps = defaultDeps(),
): Promise<void> {
  const { data } = job;
  const [row] = await executor.select().from(notifications).where(eq(notifications.id, data.notificationId)).limit(1);
  if (!row) {
    // Removed since it was queued (e.g. its academy was deleted).
    logger.info("notification.job_skipped", { notificationId: data.notificationId, reason: "row_missing" });
    return;
  }
  if (row.status !== "pending") {
    // Already sent (duplicate job) or already terminal.
    logger.info("notification.job_skipped", { notificationId: row.id, reason: `status_${row.status}` });
    return;
  }

  try {
    let outcome: DeliveryOutcome;
    if (job.name === "sendEmail") {
      outcome = await deliverEmail(row, executor, deps);
    } else if (job.name === "sendSms") {
      // No SMS provider is configured; never pretend a message was sent.
      outcome = { kind: "skipped", reason: "sms_not_configured" };
    } else {
      throw new Error(`Unknown notification job name: ${String(job.name)}`);
    }

    if (outcome.kind === "sent") {
      await markSent(row.id, executor);
      logger.info("notification.delivered", { notificationId: row.id, channel: row.channel, templateId: row.templateId });
    } else {
      await markSkipped(row.id, outcome.reason, executor);
      logger.info("notification.not_delivered", { notificationId: row.id, channel: row.channel, templateId: row.templateId, reason: outcome.reason });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attemptNumber = job.attemptsMade + 1;
    const maxAttempts = job.opts?.attempts ?? NOTIFICATION_JOB_ATTEMPTS;
    const permanent = err instanceof UnrecoverableError || attemptNumber >= maxAttempts;
    await markFailedAttempt(row.id, attemptNumber, message, permanent, executor);
    logger.warn("notification.delivery_failed", { notificationId: row.id, templateId: row.templateId, attempt: attemptNumber, permanent, error: message });
    throw err;
  }
}

/** Email sends must finish well inside the job lock, so a slow provider never looks like a stalled job. */
export const NOTIFICATION_WORKER_OPTIONS: Pick<WorkerOptions, "concurrency" | "lockDuration" | "stalledInterval" | "maxStalledCount"> = {
  concurrency: 5,
  lockDuration: 60_000,
  stalledInterval: 30_000,
  maxStalledCount: 1,
};

/**
 * Builds (does not start on import) the BullMQ Worker for notifications.
 * Requires a worker connection (`createWorkerRedisConnection`) — never the
 * request-path producer connection.
 */
export function createNotificationWorker(connection: Redis): Worker<NotificationJobData, void, NotificationJobName> {
  return new Worker<NotificationJobData, void, NotificationJobName>(NOTIFICATION_QUEUE_NAME, (job) => processNotificationJob(job), {
    connection,
    settings: { backoffStrategy: notificationBackoffStrategy },
    ...NOTIFICATION_WORKER_OPTIONS,
  });
}
