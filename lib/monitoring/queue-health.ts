import { NOTIFICATION_QUEUE_NAME, notificationQueue, notificationQueueConnection } from "@/lib/notifications/queue";
import { checkThreshold, logSink, type MonitoringSink } from "@/lib/monitoring/monitor";

/**
 * PLAN.md Phase 5, Item 62/67 — the one genuinely real check in this item.
 * `lib/notifications/queue.ts`'s `notificationQueue` (BullMQ) and
 * `lib/notifications/worker.ts` actually exist and run, unlike
 * storage/email/SMS (see provider-health.ts). This module is read-only
 * against `notificationQueue` and `notificationQueueConnection` — it never
 * imports or modifies queue.ts's/worker.ts's own internals.
 *
 * ---------------------------------------------------------------------
 * Thresholds — PLAN.md's Observability Requirements, and where this
 * implementation deliberately simplifies them
 * ---------------------------------------------------------------------
 * PLAN.md states two concrete thresholds: "3 consecutive background-job
 * failures for the same job type" and "queue depth exceeding 100 for more
 * than 5 minutes." Both are approximated here, documented rather than
 * silently reinterpreted:
 *
 * - "3 consecutive failures for the same job type": nothing in this
 *   codebase tracks *consecutive* failures per job type (BullMQ's failed
 *   list records that jobs failed, not a per-type consecutive-failure
 *   streak, and `notifications.attempt_count` is per-row, not per job
 *   type). The practical proxy available from the Queue API alone is the
 *   total count of currently-failed jobs sitting on the queue (these stay
 *   there because `removeOnFail: false`, per queue.ts's own comment) —
 *   used here as `failedJobAlertThreshold`.
 * - "queue depth exceeding 100 for more than 5 minutes": this module's
 *   checks are stateless, point-in-time sweeps — no prior-sweep history is
 *   persisted anywhere in this item — so the "for more than 5 minutes"
 *   sustained-duration component cannot be evaluated from a single call.
 *   Only the instantaneous "depth exceeds 100 right now" condition is
 *   checked. A scheduled caller invoking this repeatedly and alerting
 *   only after several consecutive breaches would restore the durational
 *   semantics; that scheduling is explicitly out of scope here (see this
 *   module's `checkQueueHealth`/sweep.ts doc comments).
 */
export const QUEUE_HEALTH_THRESHOLDS = {
  failedJobAlertThreshold: 3,
  queueDepthAlertThreshold: 100,
  /**
   * A delayed job is considered "stuck" once it's this far past the
   * instant it was actually due to run (job.timestamp + job.delay). 15
   * minutes is a reasonable grace period given the notification job
   * backoff schedule's own shortest delay is 1 minute (queue.ts) — a job
   * still sitting delayed 15 minutes past its due time indicates the
   * worker isn't picking jobs up, not just normal backoff scheduling.
   */
  stuckJobGraceMs: 15 * 60 * 1000,
} as const;

export interface QueueHealthReport {
  queueName: string;
  failedCount: number;
  waitingCount: number;
  activeCount: number;
  delayedCount: number;
  /** Delayed jobs whose due time has already passed by more than `stuckJobGraceMs`. */
  stuckCount: number;
  /**
   * Number of live BullMQ `Worker` client connections visible to Redis
   * right now (`Queue#getWorkersCount`) — the closest thing to "worker
   * liveness" determinable from the `Queue` object alone. BullMQ does not
   * expose a way to reach a specific remote `Worker` instance's own
   * health from a `Queue`; see this file's module comment / the item
   * brief for why a full `Worker`-side liveness check isn't attempted
   * here.
   */
  workersConnected: number;
  /** ioredis connection status string (e.g. "ready", "connecting", "end") for the queue's own Redis connection. */
  redisConnectionStatus: string;
  failedThresholdBreached: boolean;
  queueDepthThresholdBreached: boolean;
}

/**
 * Reports real BullMQ queue health for `notificationQueue`: failed-job
 * count, stuck-delayed-job count, worker connectivity, and Redis
 * connection status — and runs both PLAN.md alert thresholds (failed-job
 * count, queue depth) through `checkThreshold`, which emits an
 * alert-level event via `sink` whenever either is breached.
 */
export async function checkQueueHealth(
  sink: MonitoringSink = logSink,
  now: Date = new Date(),
): Promise<QueueHealthReport> {
  const [counts, workersConnected, delayedJobs] = await Promise.all([
    notificationQueue.getJobCounts("failed", "waiting", "active", "delayed"),
    notificationQueue.getWorkersCount(),
    notificationQueue.getJobs(["delayed"], 0, -1),
  ]);

  const failedCount = counts.failed ?? 0;
  const waitingCount = counts.waiting ?? 0;
  const activeCount = counts.active ?? 0;
  const delayedCount = counts.delayed ?? 0;

  const stuckCount = delayedJobs.filter((job) => {
    const dueAt = job.timestamp + (job.delay ?? 0);
    return now.getTime() - dueAt > QUEUE_HEALTH_THRESHOLDS.stuckJobGraceMs;
  }).length;

  const failedResult = checkThreshold({
    name: "queue.failed_jobs",
    value: failedCount,
    threshold: QUEUE_HEALTH_THRESHOLDS.failedJobAlertThreshold,
    context: { queueName: NOTIFICATION_QUEUE_NAME },
    sink,
  });

  const depth = waitingCount + activeCount + delayedCount;
  const depthResult = checkThreshold({
    name: "queue.depth",
    value: depth,
    threshold: QUEUE_HEALTH_THRESHOLDS.queueDepthAlertThreshold,
    context: { queueName: NOTIFICATION_QUEUE_NAME },
    sink,
  });

  return {
    queueName: NOTIFICATION_QUEUE_NAME,
    failedCount,
    waitingCount,
    activeCount,
    delayedCount,
    stuckCount,
    workersConnected,
    redisConnectionStatus: notificationQueueConnection.status,
    failedThresholdBreached: failedResult.breached,
    queueDepthThresholdBreached: depthResult.breached,
  };
}
