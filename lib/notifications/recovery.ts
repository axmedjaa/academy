import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { notificationJobId } from "@/lib/notifications/notifications";
import {
  NotificationQueueUnavailableError,
  addNotificationJob,
  type NotificationJobData,
  type NotificationJobName,
} from "@/lib/notifications/queue";

/**
 * Outbox recovery (deployment readiness R1). A notification row is written
 * to Postgres before its delivery job is queued; if Redis was unavailable
 * at that moment the row stays `pending` with no job. The worker runs this
 * pass at startup and periodically to queue such rows.
 *
 * Safe to repeat: each row is queued under its original job id, and BullMQ
 * ignores an add whose job id already exists (waiting, delayed, active or
 * retained failed). The worker also re-checks the row's status before
 * sending, so a row that was sent in the meantime is never sent twice.
 */

export interface RecoveryOptions {
  /** Leave very recent rows alone: their own enqueue may still be in flight. */
  olderThanMs: number;
  /** Don't resurrect ancient rows (e.g. after a long misconfiguration). */
  maxAgeMs: number;
  batchSize: number;
}

export const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  olderThanMs: 2 * 60_000,
  maxAgeMs: 7 * 24 * 60 * 60_000,
  batchSize: 200,
};

export interface RecoveryResult {
  found: number;
  requeued: number;
  /** True when Redis was unavailable and the pass stopped early. */
  stoppedEarly: boolean;
}

export type JobAdder = (name: NotificationJobName, data: NotificationJobData, opts: { jobId: string }) => Promise<void>;

export async function requeuePendingNotifications(
  options: RecoveryOptions = DEFAULT_RECOVERY_OPTIONS,
  deps: { add: JobAdder; executor: DbClient; now: Date } = { add: addNotificationJob, executor: db, now: new Date() },
): Promise<RecoveryResult> {
  const now = deps.now.getTime();
  const rows = await deps.executor
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "pending"),
        inArray(notifications.channel, ["email", "sms"]),
        lte(notifications.createdAt, new Date(now - options.olderThanMs)),
        gte(notifications.createdAt, new Date(now - options.maxAgeMs)),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(options.batchSize);

  let requeued = 0;
  for (const row of rows) {
    const channel = row.channel === "sms" ? "sms" : "email";
    try {
      await deps.add(
        channel === "email" ? "sendEmail" : "sendSms",
        {
          notificationId: row.id,
          academyId: row.academyId,
          userId: row.userId,
          eventType: row.eventType,
          templateId: row.templateId,
          payload: row.payload,
        },
        { jobId: notificationJobId(row.idempotencyKey, channel) },
      );
      requeued += 1;
    } catch (err) {
      if (err instanceof NotificationQueueUnavailableError) {
        logger.warn("notifications.recovery_stopped", { reason: err.message, requeued, remaining: rows.length - requeued });
        return { found: rows.length, requeued, stoppedEarly: true };
      }
      logger.warn("notifications.recovery_row_failed", {
        notificationId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (rows.length > 0) logger.info("notifications.recovery_pass", { found: rows.length, requeued });
  return { found: rows.length, requeued, stoppedEarly: false };
}
