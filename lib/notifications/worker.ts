import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  NOTIFICATION_JOB_ATTEMPTS,
  NOTIFICATION_QUEUE_NAME,
  notificationBackoffStrategy,
  notificationQueueConnection,
  type NotificationJobData,
  type NotificationJobName,
} from "@/lib/notifications/queue";

/**
 * PLAN.md Phase 5, Item 58a — "the BullMQ notification worker
 * (`sendEmail`/`sendSms`, fixed templates per event)."
 *
 * ---------------------------------------------------------------------
 * No real email/SMS provider yet — documented judgment call
 * ---------------------------------------------------------------------
 * PLAN.md's Cross-Cutting Architecture Decisions name `lib/email` and
 * `lib/sms` as the eventual provider-interface module paths ("file storage
 * and email/SMS providers are built behind small interfaces (`lib/storage`,
 * `lib/email`, `lib/sms`)"), but neither directory exists anywhere in this
 * repo yet (confirmed by listing `lib/` before writing this file) — no
 * earlier phase created them. Building a real provider integration is
 * explicitly not this item's job ("infrastructure only"; see this module's
 * and notifications.ts's own scope-boundary comments), so `sendEmail`/
 * `sendSms` below are minimal stubs: they log the send via `lib/logger.ts`
 * (which already redacts sensitive fields) and return successfully. A
 * later item that adds real `lib/email`/`lib/sms` provider modules should
 * replace only the bodies of these two functions — every other piece here
 * (status transitions, retry/backoff bookkeeping, job shape) is meant to
 * stay put.
 *
 * ---------------------------------------------------------------------
 * Why `processNotificationJob` takes a minimal shape, not a real BullMQ Job
 * ---------------------------------------------------------------------
 * Exported separately from the `Worker` itself so it's directly unit
 * testable (per this item's own test brief: "test the stub sendEmail/
 * sendSms handlers directly, and that a successful call updates the row to
 * status='sent'/sent_at set") without needing a live Redis-backed Job
 * instance. `createNotificationWorker()` wires this same function into a
 * real `Worker` for actual use.
 *
 * ---------------------------------------------------------------------
 * Backoff — see lib/notifications/queue.ts's own comment for the literal
 * 1m/5m/15m/1h/6h sequence and the "5 attempts = 5 retries after the
 * initial try (6 total)" reading of PLAN.md's spec.
 * ---------------------------------------------------------------------
 * On success: `status='sent'`, `sent_at=now()`. On failure: `attempt_count`
 * is set to the attempt number that just failed and `last_error` is
 * recorded; if this was the final allowed attempt (no further BullMQ retry
 * will occur), `status` is set to `failed` permanently — otherwise it's
 * left `pending` so the row reflects "still retrying," and BullMQ's own
 * retry/backoff mechanism (configured on the queue/worker, not here)
 * re-queues the job. The error is always rethrown after updating the row
 * so BullMQ's own attempt/backoff bookkeeping still runs unchanged.
 */
export async function sendEmail(data: NotificationJobData): Promise<void> {
  logger.info("notification.email.send", {
    notificationId: data.notificationId,
    academyId: data.academyId,
    eventType: data.eventType,
    templateId: data.templateId,
  });
}

export async function sendSms(data: NotificationJobData): Promise<void> {
  logger.info("notification.sms.send", {
    notificationId: data.notificationId,
    academyId: data.academyId,
    eventType: data.eventType,
    templateId: data.templateId,
  });
}

async function markSent(notificationId: string, executor: DbClient): Promise<void> {
  await executor
    .update(notifications)
    .set({ status: "sent", sentAt: new Date() })
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
    .set({
      attemptCount,
      lastError,
      status: permanent ? "failed" : "pending",
    })
    .where(eq(notifications.id, notificationId));
}

/** The minimal shape `processNotificationJob` needs from a BullMQ `Job`. */
export interface MinimalNotificationJob {
  name: NotificationJobName;
  data: NotificationJobData;
  attemptsMade: number;
  opts?: { attempts?: number };
}

export async function processNotificationJob(
  job: MinimalNotificationJob,
  executor: DbClient = db,
): Promise<void> {
  const { data } = job;
  try {
    if (job.name === "sendEmail") {
      await sendEmail(data);
    } else if (job.name === "sendSms") {
      await sendSms(data);
    } else {
      throw new Error(`Unknown notification job name: ${String(job.name)}`);
    }
    await markSent(data.notificationId, executor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attemptNumber = job.attemptsMade + 1;
    const maxAttempts = job.opts?.attempts ?? NOTIFICATION_JOB_ATTEMPTS;
    const isFinalAttempt = attemptNumber >= maxAttempts;
    await markFailedAttempt(data.notificationId, attemptNumber, message, isFinalAttempt, executor);
    // Rethrow so BullMQ's own retry/backoff scheduling (configured via
    // notificationBackoffStrategy) still runs — this function only keeps
    // the `notifications` row in sync, it never overrides BullMQ's retry
    // decision.
    throw err;
  }
}

/**
 * Constructs (but does not start eagerly on module import) a live BullMQ
 * `Worker`. Kept as a factory rather than a top-level singleton so
 * importing this module for its testable pieces (`sendEmail`, `sendSms`,
 * `processNotificationJob`) never has the side effect of opening a Redis
 * connection or consuming queued jobs — callers that actually want to run
 * the worker (a dedicated worker process/script, not built in this item)
 * call this explicitly.
 */
export function createNotificationWorker(): Worker<NotificationJobData, void, NotificationJobName> {
  return new Worker<NotificationJobData, void, NotificationJobName>(
    NOTIFICATION_QUEUE_NAME,
    (job) => processNotificationJob(job),
    {
      connection: notificationQueueConnection,
      settings: { backoffStrategy: notificationBackoffStrategy },
    },
  );
}
