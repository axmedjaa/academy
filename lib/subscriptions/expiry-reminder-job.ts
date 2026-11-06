import type { Queue } from "bullmq";
import { logger } from "@/lib/logger";
import { enqueueNotification } from "@/lib/notifications/notifications";
import { getMaintenanceQueue, getNotificationQueue } from "@/lib/notifications/queue";
import { listPlatformSubscriptions } from "@/lib/subscriptions/renew";

/**
 * PLAN.md Phase 5, Item 58b — subscription-expiry-reminder scan, the second
 * (repeatable-job) half of wiring `enqueueNotification` into the
 * subscriptions module. Distinct from `renewSubscription`'s own
 * `subscription.renewed` enqueue (lib/subscriptions/renew.ts): this file is
 * a periodic *scan* over every academy's current subscription, not a
 * reaction to a single mutation.
 *
 * ---------------------------------------------------------------------
 * Reusing listPlatformSubscriptions's own "expiring soon" computation
 * ---------------------------------------------------------------------
 * `listPlatformSubscriptions` (lib/subscriptions/renew.ts) already computes
 * `expiringSoon` per row: `effectiveStatus === "active" && msUntilEnd > 0 &&
 * msUntilEnd <= EXPIRING_SOON_WINDOW_DAYS * DAY_MS`. Rather than
 * reimplementing that window/effective-status logic against
 * academySubscriptions/subscriptionPlans directly (which would be a second,
 * independently-maintained copy of the exact same rule), this scan simply
 * calls listPlatformSubscriptions() and filters for `expiringSoon === true`.
 * listPlatformSubscriptions lists full history (every academy_subscriptions
 * row ever created, not just "current" ones) but a non-current row can never
 * be `status: "active"` with a still-future `ends_at` at the same time as a
 * newer row exists for the same academy in practice — the filter is exactly
 * as correct as the read model it reuses, and this scan is an infrequent
 * (daily) background job, not a hot path, so the extra full-table read is an
 * acceptable, already-established tradeoff (see that function's own "not a
 * tenant-facing hot path" comment).
 *
 * ---------------------------------------------------------------------
 * entityId design — why NOT just the subscription id
 * ---------------------------------------------------------------------
 * enqueueNotification is idempotent on `(eventType, entityId)` (see
 * notifications.ts's own module comment): re-running this scan daily must
 * NOT re-notify for a subscription that's still sitting in the same
 * "expiring soon" window it was already flagged for — that's the whole
 * point of the idempotency guarantee, and is exactly what a *static*
 * entityId (e.g. just the subscription id) would give for free.
 *
 * But a static subscription id would ALSO permanently suppress every FUTURE
 * reminder for that same subscription once it's renewed and, months later,
 * approaches expiry again — the (eventType, entityId) pair would already
 * exist from the first cycle and every later enqueue call would silently
 * no-op forever. PLAN.md's renewal rule extends `ends_at` in place on the
 * SAME academy_subscriptions row (never creating a new row for an ordinary
 * renewal — see renew.ts's own module comment), so the subscription id alone
 * can never distinguish "expiring cycle #1" from "expiring cycle #2."
 *
 * The fix: fold the row's current `endsAt` (the exact instant this
 * particular expiry cycle ends) into entityId as
 * `${subscriptionId}_${endsAt.getTime()}`. A renewal changes `endsAt`, which
 * changes entityId, which lets a later cycle's reminder fire again — while
 * repeated daily scans against the SAME still-unrenewed `endsAt` keep
 * producing the same entityId and stay deduped, exactly as intended.
 *
 * Separator is `_`, not `:` — enqueueNotification's own BullMQ jobId is
 * `${eventType}:${entityId}:${channel}` (notifications.ts), and BullMQ's
 * Job.validateOptions rejects any custom jobId containing `:` unless it
 * splits into exactly 3 segments (node_modules/bullmq/dist/esm/classes/
 * job.js) — a colon inside entityId itself would push that count to 4+ and
 * throw "Custom Id cannot contain :". Verified directly against the
 * installed package after hitting this at test time.
 */

export interface ExpiryReminderScanResult {
  /** Subscriptions found within the expiring-soon window this scan. */
  scanned: number;
  /** Of those, how many successfully enqueued (or already-enqueued, per idempotency) without error. */
  enqueued: number;
  /** Of those, how many raised and were caught/logged rather than propagated. */
  failed: number;
}

/**
 * Scans every academy's current subscription for one now within
 * `EXPIRING_SOON_WINDOW_DAYS` of its `ends_at`, and enqueues one
 * `subscription.expiry_reminder` notification per match. Safe to call
 * repeatedly (e.g. once a day via a scheduler) — see this file's top-of-file
 * comment on the entityId design that makes that idempotent per expiry
 * cycle.
 *
 * Each academy's enqueue call is individually wrapped so one failure (e.g.
 * a transient Redis hiccup while enqueuing academy #7 of 50) never aborts
 * the scan for the remaining academies — matching this item's broader rule
 * that a notification failure is never allowed to break the underlying
 * business process, here "the scan" rather than a single mutation.
 */
export async function scanForExpiringSubscriptions(
  now: Date = new Date(),
): Promise<ExpiryReminderScanResult> {
  const rows = await listPlatformSubscriptions(now);
  const expiring = rows.filter(
    (row): row is typeof row & { endsAt: Date } => row.expiringSoon && row.endsAt !== null,
  );

  let enqueued = 0;
  let failed = 0;

  for (const row of expiring) {
    const entityId = `${row.subscriptionId}_${row.endsAt.getTime()}`;
    try {
      await enqueueNotification({
        eventType: "subscription.expiring_soon",
        entityId,
        templateId: "subscription.expiry_reminder",
        academyId: row.academyId,
      });
      enqueued += 1;
    } catch (err) {
      failed += 1;
      logger.error("notifications.enqueue_failed", {
        eventType: "subscription.expiring_soon",
        academyId: row.academyId,
        subscriptionId: row.subscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: expiring.length, enqueued, failed };
}

// ---------------------------------------------------------------------------
// BullMQ repeatable-job registration (not invoked at module load)
// ---------------------------------------------------------------------------

/**
 * A daily 06:00 UTC cron pattern — PLAN.md gives no exact time-of-day for
 * this scan (only the 14-day advance-notice window, EXPIRING_SOON_WINDOW_DAYS
 * in renew.ts), so an early-morning daily cadence is a reasonable default:
 * frequent enough that no academy's reminder is ever more than a day late,
 * infrequent enough not to be wasteful given the scan itself is a full read
 * of every subscription.
 */
export const EXPIRY_REMINDER_CRON_PATTERN = "0 6 * * *";

/** Stable id for the BullMQ job scheduler (`Queue#upsertJobScheduler`'s first argument). */
export const EXPIRY_REMINDER_JOB_SCHEDULER_ID = "subscription-expiry-reminder-scan";

/** Distinct job name so a real consumer can tell this apart from `sendEmail`/`sendSms`. */
export const EXPIRY_REMINDER_JOB_NAME = "scanExpiringSubscriptions";

/** Retries for a failed scan (e.g. the database was briefly unreachable). */
export const EXPIRY_REMINDER_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 200,
};

/**
 * Registers (or updates) the daily expiry-scan schedule on the dedicated
 * MAINTENANCE queue, consumed by the worker process (scripts/worker.ts,
 * lib/workers/maintenance.ts). `upsertJobScheduler` keyed by a fixed id is
 * idempotent: calling this on every worker start never creates a second
 * schedule. Duplicate reminders are prevented separately by
 * `enqueueNotification`'s idempotency key (one per subscription term).
 *
 * Deployment readiness Step 2: this used to target the `notifications`
 * queue, whose worker only handles `sendEmail`/`sendSms` and would have
 * failed every scan job. It now has its own queue and a real consumer.
 */
export function registerExpiryReminderRepeatableJob(queue: Queue = getMaintenanceQueue()): Promise<unknown> {
  return queue.upsertJobScheduler(
    EXPIRY_REMINDER_JOB_SCHEDULER_ID,
    { pattern: EXPIRY_REMINDER_CRON_PATTERN },
    { name: EXPIRY_REMINDER_JOB_NAME, data: {}, opts: EXPIRY_REMINDER_JOB_OPTIONS },
  );
}

/** Removes the schedule registered by `registerExpiryReminderRepeatableJob`, if any. */
export function unregisterExpiryReminderRepeatableJob(queue: Queue = getMaintenanceQueue()): Promise<boolean> {
  return queue.removeJobScheduler(EXPIRY_REMINDER_JOB_SCHEDULER_ID);
}

/**
 * Removes a schedule left on the `notifications` queue by the earlier
 * registration code, so the notification worker never receives a scan job.
 * Harmless when none exists.
 */
export function removeLegacyExpiryReminderSchedule(queue: Queue = getNotificationQueue() as unknown as Queue): Promise<boolean> {
  return queue.removeJobScheduler(EXPIRY_REMINDER_JOB_SCHEDULER_ID);
}
