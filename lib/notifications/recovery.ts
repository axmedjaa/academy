import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { notificationJobId } from "@/lib/notifications/notifications";
import {
  NotificationQueueUnavailableError,
  addNotificationJob,
  getNotificationQueue,
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
 *
 * Before adding, the pass looks the job up:
 * - still waiting, delayed or active (a row stays `pending` through its
 *   retries) -> left alone and counted as `alreadyQueued`, not `requeued`;
 * - in BullMQ's failed set while the row is still `pending` (the job died
 *   without the worker recording it, e.g. a stalled job during a restart)
 *   -> the row is closed as `failed` with `job_failed: <reason>` instead of
 *   being "requeued" (a no-op) every pass for days. The failed job itself is
 *   kept.
 * Only rows with no job at all are queued.
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
  /** Rows whose job is still waiting, delayed or active. */
  alreadyQueued: number;
  /** Rows closed because their job had already failed. */
  closedFailed: number;
  /** True when Redis was unavailable and the pass stopped early. */
  stoppedEarly: boolean;
}

export type JobAdder = (name: NotificationJobName, data: NotificationJobData, opts: { jobId: string }) => Promise<void>;

export interface ExistingJob {
  state: string;
  failedReason?: string;
}

/** Returns null when no job with this id exists. */
export type JobLookup = (jobId: string) => Promise<ExistingJob | null>;

export const lookupNotificationJob: JobLookup = async (jobId) => {
  const job = await getNotificationQueue().getJob(jobId);
  if (!job) return null;
  return { state: await job.getState(), failedReason: job.failedReason };
};

/** States in which the job will still run (or is running): nothing to do. */
const LIVE_JOB_STATES = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children", "paused"]);

const MAX_REASON_LENGTH = 200;

export async function requeuePendingNotifications(
  options: RecoveryOptions = DEFAULT_RECOVERY_OPTIONS,
  deps: { add: JobAdder; executor: DbClient; now: Date; lookup?: JobLookup } = {
    add: addNotificationJob,
    executor: db,
    now: new Date(),
    lookup: lookupNotificationJob,
  },
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
  let alreadyQueued = 0;
  let closedFailed = 0;
  const stopped = (reason: string) => {
    logger.warn("notifications.recovery_stopped", { reason, requeued, remaining: rows.length - requeued - alreadyQueued - closedFailed });
    return { found: rows.length, requeued, alreadyQueued, closedFailed, stoppedEarly: true };
  };
  for (const row of rows) {
    const channel = row.channel === "sms" ? "sms" : "email";
    const jobId = notificationJobId(row.idempotencyKey, channel);
    try {
      const existing = deps.lookup ? await deps.lookup(jobId) : null;
      if (existing && LIVE_JOB_STATES.has(existing.state)) {
        alreadyQueued += 1;
        continue;
      }
      if (existing && existing.state === "failed") {
        const reason = (existing.failedReason || "unknown").slice(0, MAX_REASON_LENGTH);
        await deps.executor
          .update(notifications)
          .set({ status: "failed", lastError: `job_failed: ${reason}` })
          .where(and(eq(notifications.id, row.id), eq(notifications.status, "pending")));
        closedFailed += 1;
        logger.warn("notifications.recovery_closed_failed", { notificationId: row.id, reason });
        continue;
      }
    } catch (err) {
      // The lookup reads Redis: if it is unreachable, stop like a failed add.
      return stopped(err instanceof Error ? err.message : String(err));
    }
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
        { jobId },
      );
      requeued += 1;
    } catch (err) {
      if (err instanceof NotificationQueueUnavailableError) {
        return stopped(err.message);
      }
      logger.warn("notifications.recovery_row_failed", {
        notificationId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Logged only when the pass changed something, so a row that is simply
  // mid-retry no longer looks "requeued" every five minutes.
  if (requeued > 0 || closedFailed > 0) {
    logger.info("notifications.recovery_pass", { found: rows.length, requeued, alreadyQueued, closedFailed });
  }
  return { found: rows.length, requeued, alreadyQueued, closedFailed, stoppedEarly: false };
}
