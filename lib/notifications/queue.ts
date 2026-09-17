import Redis from "ioredis";
import { Queue } from "bullmq";
import { env } from "@/lib/env";

/**
 * PLAN.md Phase 5, Item 58a — "BullMQ (same Redis) is wired in Phase 0 but
 * its first real queue/worker is built in Phase 5 for notifications."
 *
 * ---------------------------------------------------------------------
 * Why this is a SECOND, separate ioredis connection (not lib/redis.ts)
 * ---------------------------------------------------------------------
 * lib/redis.ts's `redis` client is deliberately configured to fail fast
 * (`maxRetriesPerRequest: 1`, a bounded `retryStrategy`) so a login-flow
 * rate-limit check never hangs during a Redis outage — see that file's own
 * comment. BullMQ, however, *requires* `maxRetriesPerRequest: null` on any
 * connection it's given, because its blocking commands (BRPOPLPUSH-style
 * job waiting) must not time out mid-block; passing a finite value throws
 * at Queue/Worker construction time. These two requirements are mutually
 * exclusive on one ioredis instance, so this module creates its own
 * connection instead of importing/sharing `lib/redis.ts`'s. Never point
 * this at the same client as lib/rate-limit.ts, and never loosen
 * lib/redis.ts's own retry settings to accommodate BullMQ.
 */
export const notificationQueueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const NOTIFICATION_QUEUE_NAME = "notifications";

/**
 * PLAN.md Phase 5 security considerations: "Retry policy: 5 attempts,
 * exponential backoff (1m, 5m, 15m, 1h, 6h), then marked failed."
 *
 * Judgment call on "5 attempts" vs. 5 listed delays: BullMQ's own
 * `attempts` job option counts the *total* number of tries including the
 * first (successful-or-not) one — it is not a "number of retries" count.
 * Read literally, "5 attempts" with 5 backoff delays between them would
 * need 6 total tries (a delay only ever separates two attempts), leaving
 * one of the five listed delays (the trailing 6h) never actually used.
 * Since PLAN.md lists five concrete delay values, this implementation
 * treats "5 attempts" as "5 retries after the initial try" (6 total BullMQ
 * `attempts`), so every one of the five listed delays is meaningful:
 * initial try -> fail -> wait 1m -> retry 1 -> fail -> wait 5m -> retry 2
 * -> fail -> wait 15m -> retry 3 -> fail -> wait 1h -> retry 4 -> fail ->
 * wait 6h -> retry 5 -> fail -> permanently `failed` (no further retry).
 * This is a deliberate, documented reading of an otherwise-ambiguous spec
 * line, not a literal "attempts: 5".
 */
export const RETRY_BACKOFF_DELAYS_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  21_600_000, // 6h
] as const;

export const NOTIFICATION_JOB_ATTEMPTS = RETRY_BACKOFF_DELAYS_MS.length + 1;

/**
 * BullMQ's exact 2^n multiplier ("exponential" builtin strategy) does not
 * produce PLAN.md's literal 1m/5m/15m/1h/6h sequence (that's not a constant
 * ratio), so a `type: "custom"` backoff is used with this lookup-table
 * strategy instead, per PLAN.md's own instruction ("use a custom backoff
 * strategy function if needed"). `attemptsMade` here is 1-based — BullMQ
 * passes `job.attemptsMade + 1` (i.e. "the attempt number that just
 * failed") — see node_modules/bullmq/dist/esm/classes/job.js's
 * `shouldRetryJob`, verified against the installed package rather than
 * assumed.
 */
export function notificationBackoffStrategy(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), RETRY_BACKOFF_DELAYS_MS.length) - 1;
  return RETRY_BACKOFF_DELAYS_MS[index];
}

export type NotificationJobName = "sendEmail" | "sendSms";

/**
 * Database-Level Tenant Protection: "Background jobs (BullMQ) carry
 * academy_id explicitly in their job payload — a worker never infers
 * tenant context from ambient state." `academyId` is included (and may be
 * `null` for a platform-level notification with no academy, per the
 * `notifications` table's own nullable `academy_id` column) rather than
 * omitted, so the worker never has to look it up or assume one.
 */
export interface NotificationJobData {
  notificationId: string;
  academyId: string | null;
  userId: string | null;
  eventType: string;
  templateId: string;
  payload: unknown;
}

export const notificationQueue = new Queue<NotificationJobData, void, NotificationJobName>(
  NOTIFICATION_QUEUE_NAME,
  {
    connection: notificationQueueConnection,
    defaultJobOptions: {
      attempts: NOTIFICATION_JOB_ATTEMPTS,
      backoff: { type: "custom" },
      // Failed jobs stay visible for the worker's own row (status='failed')
      // and for platform monitoring (PLAN.md: "visible... to platform
      // monitoring, not silently dropped") rather than being purged.
      removeOnFail: false,
      removeOnComplete: true,
    },
  },
);
