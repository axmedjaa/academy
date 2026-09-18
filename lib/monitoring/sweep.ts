import { logSink, type MonitoringSink } from "@/lib/monitoring/monitor";
import { checkQueueHealth, type QueueHealthReport } from "@/lib/monitoring/queue-health";
import {
  checkEmailHealth,
  checkSmsHealth,
  checkStorageHealth,
  type ProviderHealthResult,
} from "@/lib/monitoring/provider-health";

/**
 * PLAN.md Phase 5, Item 62/67 — a callable way to actually run the
 * monitoring checks. PLAN.md names no admin dashboard or UI for this
 * item, so — mirroring lib/subscriptions/expiry-reminder-job.ts's own
 * "provided but not yet invoked at process startup, documented as a
 * follow-up" pattern for its repeatable-job registration — this is a
 * plain, directly callable function: usable manually, from a test, or
 * later wired into a real scheduled job/cron entry point. Building that
 * scheduler invocation itself is explicitly out of scope for this item
 * (same reasoning as expiry-reminder-job.ts's own scope boundary); no
 * process-startup path calls this function anywhere in this codebase yet.
 */

export interface MonitoringSweepResult {
  queue: QueueHealthReport;
  storage: ProviderHealthResult;
  email: ProviderHealthResult;
  sms: ProviderHealthResult;
}

/**
 * Runs every health check this item defines (real BullMQ queue health,
 * plus the honest storage/email/SMS "not yet implemented" placeholders)
 * and reports a summary event through `sink` (the log-based `logSink` by
 * default — see monitor.ts's module comment on why). Individual checks
 * already report their own alert-level events via `checkThreshold`
 * (queue-health.ts); this function's own event is a single
 * sweep-completed summary, not a duplicate of those.
 */
export async function runMonitoringSweep(sink: MonitoringSink = logSink): Promise<MonitoringSweepResult> {
  const [queue, storage, email, sms] = await Promise.all([
    checkQueueHealth(sink),
    checkStorageHealth(),
    checkEmailHealth(),
    checkSmsHealth(),
  ]);

  sink.recordEvent({
    name: "sweep.completed",
    level: "info",
    message: "Monitoring sweep completed",
    context: {
      queueFailedCount: queue.failedCount,
      queueStuckCount: queue.stuckCount,
      queueDepthThresholdBreached: queue.queueDepthThresholdBreached,
      failedThresholdBreached: queue.failedThresholdBreached,
      storageStatus: storage.status,
      emailStatus: email.status,
      smsStatus: sms.status,
    },
  });

  return { queue, storage, email, sms };
}
