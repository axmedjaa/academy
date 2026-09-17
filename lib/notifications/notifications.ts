import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academySubscriptions,
  notificationChannelEnum,
  notifications,
  subscriptionPlans,
} from "@/lib/db/schema";
import { redact } from "@/lib/redact";
import { NOTIFICATION_TEMPLATE_IDS, type NotificationTemplateId } from "@/lib/notifications/templates";
import { notificationQueue, type NotificationJobData } from "@/lib/notifications/queue";

/**
 * PLAN.md Phase 5, Item 58a — the core `enqueueNotification` entry point.
 * Wiring this into any Phase 0-4/Wave-1 trigger point (academy onboarding,
 * result publish, certificate issue, suspicious-login, ...) is explicitly
 * OUT of scope for this item — that's Item 58b, a separate later wave.
 *
 * ---------------------------------------------------------------------
 * Idempotency key derivation — translating PLAN.md's conceptual key into
 * this table's literal column
 * ---------------------------------------------------------------------
 * PLAN.md: "Every job's idempotency key is `(event_type, entity_id)` (e.g.
 * `("result.published", exam_result_id)`)." The `notifications` table's own
 * column list, however, only has a single `idempotency_key text` column
 * plus a `unique (idempotency_key, channel)` constraint — there is no
 * literal `entity_id` column. So `entityId` is a parameter of this function
 * (never persisted as its own column) purely so the composite key can be
 * derived, and `idempotencyKey` is computed here as the deterministic
 * string `` `${eventType}:${entityId}` `` before being written to the
 * table's `idempotency_key` column. The DB's `(idempotency_key, channel)`
 * uniqueness then does exactly what PLAN.md's conceptual
 * "(event_type, entity_id)" key describes *per channel* — one event fans
 * out to up to three rows (in_app/email/sms), each independently
 * deduplicated against a re-enqueue of that same event.
 *
 * ---------------------------------------------------------------------
 * Channel selection (PLAN.md Phase 5 security considerations, "Channels
 * and priority")
 * ---------------------------------------------------------------------
 * "Email is always attempted; SMS is attempted only if the academy's plan
 * has `sms_enabled`; an in-app `notifications` row is always created
 * regardless of email/SMS outcome." So: in_app is unconditional, email is
 * unconditional, and sms is gated on `subscription_plans.sms_enabled` (the
 * exact column name already used in this schema — see
 * `lib/db/schema.ts`'s `subscriptionPlans.smsEnabled`, no adaptation
 * needed) for the academy's *current* subscription, resolved the same way
 * `lib/academies/settings.ts` resolves "the current plan" elsewhere in
 * this codebase: the most recent `academy_subscriptions` row by
 * `starts_at`, joined to `subscription_plans`. A notification with no
 * `academyId` (a platform-level event) never gets an SMS row — there is no
 * plan to check.
 *
 * ---------------------------------------------------------------------
 * Redaction
 * ---------------------------------------------------------------------
 * PLAN.md: "`payload` jsonb nullable (redacted per the same rule as
 * `audit_logs`)." Reuses `lib/redact.ts` directly (the same helper
 * `lib/audit.ts` uses) rather than reimplementing anything.
 *
 * ---------------------------------------------------------------------
 * Duplicate enqueue = success, not an error
 * ---------------------------------------------------------------------
 * A caught unique-violation (23505) on `(idempotency_key, channel)` means
 * this exact event+entity+channel was already enqueued — treated as a
 * successful no-op (`alreadyEnqueued: true` on that channel's result), per
 * PLAN.md: "retrying or duplicate-enqueuing an event never produces a
 * duplicate critical notification." No BullMQ job is added for a channel
 * that was already enqueued (its job either already ran or is already
 * queued).
 *
 * ---------------------------------------------------------------------
 * Database-Level Tenant Protection
 * ---------------------------------------------------------------------
 * "Background jobs (BullMQ) carry academy_id explicitly in their job
 * payload — a worker never infers tenant context from ambient state."
 * `academyId` (possibly `null`, for a platform-level event) is placed
 * directly on every enqueued job's data, never looked up by the worker.
 */
export const enqueueNotificationInputSchema = z.object({
  eventType: z.string().trim().min(1).max(200),
  // Drives idempotency-key derivation only — never persisted as its own
  // column (see module comment above).
  entityId: z.string().trim().min(1).max(200),
  templateId: z.enum(NOTIFICATION_TEMPLATE_IDS),
  academyId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  payload: z.unknown().optional(),
});

export type EnqueueNotificationInput = z.infer<typeof enqueueNotificationInputSchema>;

export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];

export interface EnqueuedNotificationChannelResult {
  channel: NotificationChannel;
  notificationId: string;
  /** true when this exact (idempotencyKey, channel) row already existed. */
  alreadyEnqueued: boolean;
}

/**
 * Postgres unique_violation (23505) detection — same double-wrapped-error
 * shape as every other `isUniqueViolation` in this codebase (drizzle-orm
 * wraps the raw `pg` DatabaseError in its own `DrizzleQueryError`, so
 * `code` lives on `err.cause`, not `err` itself). Recreated locally per
 * this codebase's own per-file convention (see lib/academies/branches.ts,
 * lib/academies/certificates.ts, ...).
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

async function isSmsEnabledForAcademy(academyId: string, executor: DbClient): Promise<boolean> {
  const [row] = await executor
    .select({ smsEnabled: subscriptionPlans.smsEnabled })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(academySubscriptions.planId, subscriptionPlans.id))
    .where(eq(academySubscriptions.academyId, academyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);
  return row?.smsEnabled ?? false;
}

interface InsertChannelRowParams {
  academyId: string | null;
  userId: string | null;
  eventType: string;
  channel: NotificationChannel;
  templateId: NotificationTemplateId;
  payload: unknown;
  idempotencyKey: string;
}

async function insertNotificationRow(
  params: InsertChannelRowParams,
  executor: DbClient,
): Promise<EnqueuedNotificationChannelResult> {
  try {
    const [row] = await executor
      .insert(notifications)
      .values({
        academyId: params.academyId,
        userId: params.userId,
        eventType: params.eventType,
        channel: params.channel,
        templateId: params.templateId,
        payload: params.payload,
        idempotencyKey: params.idempotencyKey,
      })
      .returning({ id: notifications.id });
    return { channel: params.channel, notificationId: row.id, alreadyEnqueued: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Already enqueued by a prior call — treat as a successful no-op
    // (PLAN.md: duplicate-enqueuing an event never produces a duplicate
    // notification) rather than surfacing the DB error to the caller.
    const [existing] = await executor
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.idempotencyKey, params.idempotencyKey),
          eq(notifications.channel, params.channel),
        ),
      )
      .limit(1);
    if (!existing) throw err;
    return { channel: params.channel, notificationId: existing.id, alreadyEnqueued: true };
  }
}

export async function enqueueNotification(
  rawInput: EnqueueNotificationInput,
  executor: DbClient = db,
): Promise<EnqueuedNotificationChannelResult[]> {
  const input = enqueueNotificationInputSchema.parse(rawInput);
  const academyId = input.academyId ?? null;
  const userId = input.userId ?? null;
  const idempotencyKey = `${input.eventType}:${input.entityId}`;
  const redactedPayload = input.payload !== undefined ? redact(input.payload) : null;

  const channels: NotificationChannel[] = ["in_app", "email"];
  if (academyId && (await isSmsEnabledForAcademy(academyId, executor))) {
    channels.push("sms");
  }

  const results: EnqueuedNotificationChannelResult[] = [];
  for (const channel of channels) {
    const result = await insertNotificationRow(
      {
        academyId,
        userId,
        eventType: input.eventType,
        channel,
        templateId: input.templateId,
        payload: redactedPayload,
        idempotencyKey,
      },
      executor,
    );
    results.push(result);

    // in_app has nothing further to "send" — the row itself is the
    // delivered notification (surfaced by Item 59's /academy/notifications
    // list, a later wave). Only email/sms have a BullMQ job to run, and
    // only when this call is the one that actually created the row (a
    // no-op duplicate must never re-enqueue a second send).
    if (result.alreadyEnqueued || channel === "in_app") continue;

    const jobData: NotificationJobData = {
      notificationId: result.notificationId,
      academyId,
      userId,
      eventType: input.eventType,
      templateId: input.templateId,
      payload: redactedPayload,
    };
    await notificationQueue.add(channel === "email" ? "sendEmail" : "sendSms", jobData, {
      // Defense in depth alongside the DB's own uniqueness: a duplicate
      // jobId is silently not re-added by BullMQ.
      jobId: `${idempotencyKey}:${channel}`,
    });
  }

  return results;
}
