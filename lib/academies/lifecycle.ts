import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, academySubscriptions, subscriptionPayments, subscriptionPlans } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { enqueueNotification } from "@/lib/notifications/notifications";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  GRACE_PERIOD_DAYS,
  transitionSubscriptionState,
  type SubscriptionStatus,
} from "@/lib/subscriptions/state-machine";

/**
 * PLAN.md Phase 1, Item 26: `activateAcademy`/`suspendAcademy`/
 * `reactivateAcademy`/`cancelAcademy`/`closeAcademy`. All five are
 * `platform_owner`-only (already in UNGRANTABLE_CAPABILITIES,
 * lib/auth/permissions.ts) — hasPermission() returns true for each of these
 * capability names only when the actor is platform_owner, no platform_admin
 * grant can ever satisfy them.
 *
 * File-split convention matches lib/academies/approve.ts: this file is the
 * pure, framework-agnostic logic (directly Vitest-testable against the real
 * local Postgres DB); lib/academies/lifecycle-actions.ts adds the thin
 * "use server" wrappers.
 *
 * --- Scope notes / deliberate omissions ---
 *
 * `getOnboardingChecklistStatus` as a standalone, separately-named,
 * separately-exported action is NOT built here — lib/academies/approve.ts's
 * own comment defers it to "Items 22-26, not yet built" without assigning it
 * to a specific one of them, and it is not one of this item's five assigned
 * action names. What IS built here, inline inside `activateAcademy` (because
 * PLAN.md's "Onboarding, end to end" step (8) is explicit that activation
 * "is blocked until step 7 is fully satisfied"), are the two checklist
 * preconditions that are unambiguous and mechanically checkable from what
 * previous items have already built: the academy must be `approveAcademy`-d
 * (`approved_at` set, Item 21), and — "payment verified where required" —
 * a plan with a nonzero price must have at least one `verified`
 * `subscription_payments` row for the subscription being activated (Item
 * 25's schema). The third checklist item PLAN.md names, "profile complete,"
 * is deliberately NOT enforced here: PLAN.md never defines which of the
 * academy profile's many optional fields (type/address/phone/email/website/
 * .../primaryContactPhone — see register.ts, all nullable) constitute
 * "complete," and inventing a specific required-field list here would be
 * guessing at a rule PLAN.md leaves to whichever item eventually builds
 * `getOnboardingChecklistStatus` as its own surfaced concept. This is a
 * known, reported gap (see this item's final report), not a silent omission.
 *
 * `suspendAcademy`/`reactivateAcademy` fire the `suspend`/`reactivate`
 * events added to lib/subscriptions/state-machine.ts by this same item —
 * see that file's top-of-file "Item 26 addition" comment for the full
 * reasoning on why the literal PLAN.md transition table doesn't name these
 * two events, and why they were added anyway.
 */

const ACTIVATE_CAPABILITY = "activateAcademy";
const SUSPEND_CAPABILITY = "suspendAcademy";
const REACTIVATE_CAPABILITY = "reactivateAcademy";
const CANCEL_CAPABILITY = "cancelAcademy";
const CLOSE_CAPABILITY = "closeAcademy";

export interface LifecycleActionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "academy_closed"
    | "already_closed"
    | "no_subscription"
    | "not_approved"
    | "payment_required"
    | "invalid_transition"
    | "payment_lapse"
    | "conflict";
  message: string;
}

function forbidden(message: string): LifecycleActionError {
  return { code: "forbidden", message };
}

const academyIdSchema = z.string().uuid("Invalid academy id.");
const reasonSchema = z
  .string()
  .trim()
  .min(1, "A reason is required.")
  .max(2000, "Reason must be 2000 characters or fewer.");

export interface SubscriptionLifecycleSummary {
  id: string;
  academyId: string;
  planId: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
  trialEndsAt: Date | null;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  cancelledAt: Date | null;
  renewedAt: Date | null;
  notes: string | null;
}

type SubscriptionRow = typeof academySubscriptions.$inferSelect;

function toSubscriptionSummary(row: SubscriptionRow): SubscriptionLifecycleSummary {
  return {
    id: row.id,
    academyId: row.academyId,
    planId: row.planId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    trialEndsAt: row.trialEndsAt,
    activatedAt: row.activatedAt,
    suspendedAt: row.suspendedAt,
    cancelledAt: row.cancelledAt,
    renewedAt: row.renewedAt,
    notes: row.notes,
  };
}

/**
 * The academy's current subscription row — the one every action in this
 * file reads and mutates. There is no explicit "current" flag on
 * academy_subscriptions (a cancelled subscription is superseded by a brand
 * new row per PLAN.md's renewSubscription rule: "resuming service means
 * creating a NEW academy_subscriptions row, never a transition out of
 * Cancelled"), so the most-recently-started row (`starts_at` desc — this
 * table has no created_at of its own, see schema.ts's comment) is always
 * the current one, whatever its status.
 */
async function getCurrentSubscription(
  tx: DbClient,
  academyId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(academySubscriptions)
    .where(eq(academySubscriptions.academyId, academyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);
  return row ?? null;
}

interface AcademyGuardRow {
  id: string;
  closedAt: Date | null;
  approvedAt: Date | null;
}

async function fetchAcademyGuardRow(
  tx: DbClient,
  academyId: string,
): Promise<AcademyGuardRow | null> {
  const [row] = await tx
    .select({
      id: academies.id,
      closedAt: academies.closedAt,
      approvedAt: academies.approvedAt,
    })
    .from(academies)
    .where(eq(academies.id, academyId))
    .limit(1);
  return row ?? null;
}

const ACADEMY_CLOSED_ERROR: LifecycleActionError = {
  code: "academy_closed",
  message:
    "This academy is permanently closed. Closure blocks all further writes academy-wide.",
};

const NO_SUBSCRIPTION_ERROR: LifecycleActionError = {
  code: "no_subscription",
  message: "This academy has no subscription to act on. Assign a plan first.",
};

// ---------------------------------------------------------------------------
// activateAcademy
// ---------------------------------------------------------------------------

export type ActivateAcademyResult =
  | { ok: true; subscription: SubscriptionLifecycleSummary }
  | { ok: false; error: LifecycleActionError };

/**
 * Moves the academy's subscription from Draft/Trial to Active — PLAN.md's
 * `activate` state-machine event (lib/subscriptions/state-machine.ts,
 * Item 23) — once the onboarding checklist's mechanically-checkable
 * preconditions are satisfied (see this file's top-of-file scope note):
 * the academy must already be `approveAcademy`-d, and if the assigned
 * plan's price is nonzero, a verified subscription payment must exist for
 * it. Distinct from `approveAcademy` (Item 21, sets approved_by/approved_at
 * on the academies row) — this action never touches that row, it only
 * transitions the subscription.
 */
export async function activateAcademy(
  actorContext: AuthContext,
  academyId: string,
): Promise<ActivateAcademyResult> {
  const allowed = await hasPermission(actorContext, ACTIVATE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: forbidden("You don't have permission to activate academies.") };
  }

  const parsed = academyIdSchema.safeParse(academyId);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }

  const result = await db.transaction(async (tx) => {
    const academy = await fetchAcademyGuardRow(tx, parsed.data);
    if (!academy) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }
    if (academy.closedAt) {
      return { ok: false, error: ACADEMY_CLOSED_ERROR } as const;
    }
    if (!academy.approvedAt) {
      return {
        ok: false,
        error: {
          code: "not_approved",
          message: "This academy must be approved (approveAcademy) before it can be activated.",
        },
      } as const;
    }

    const subscription = await getCurrentSubscription(tx, parsed.data);
    if (!subscription) {
      return { ok: false, error: NO_SUBSCRIPTION_ERROR } as const;
    }

    const transition = transitionSubscriptionState(subscription.status, "activate");
    if (!transition.ok) {
      return {
        ok: false,
        error: { code: "invalid_transition", message: transition.error.message },
      } as const;
    }

    const [plan] = await tx
      .select({ priceAmountCents: subscriptionPlans.priceAmountCents })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, subscription.planId))
      .limit(1);

    if (plan && plan.priceAmountCents > 0) {
      const [verifiedPayment] = await tx
        .select({ id: subscriptionPayments.id })
        .from(subscriptionPayments)
        .where(
          and(
            eq(subscriptionPayments.subscriptionId, subscription.id),
            eq(subscriptionPayments.status, "verified"),
          ),
        )
        .limit(1);

      if (!verifiedPayment) {
        return {
          ok: false,
          error: {
            code: "payment_required",
            message: "A verified payment is required before this plan can be activated.",
          },
        } as const;
      }
    }

    const [updated] = await tx
      .update(academySubscriptions)
      .set({ status: transition.status, activatedAt: new Date(), updatedBy: actorContext.userId })
      .where(
        and(
          eq(academySubscriptions.id, subscription.id),
          eq(academySubscriptions.status, subscription.status),
        ),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: { code: "conflict", message: "This subscription was changed by another request. Please retry." },
      } as const;
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: academy.id,
        action: "activateAcademy",
        entityType: "academy_subscription",
        entityId: updated.id,
        before: { status: subscription.status },
        after: { status: updated.status, activatedAt: updated.activatedAt },
      },
      tx,
    );

    return { ok: true, subscription: toSubscriptionSummary(updated) } as const;
  });

  // Phase 5 Item 58b: fired only after db.transaction above has committed
  // (never passed `tx`) — a notification-enqueue failure (e.g. Redis down)
  // must never roll back an already-successful activation. Caught and
  // logged, never rethrown.
  if (result.ok) {
    try {
      await enqueueNotification({
        eventType: "academy.activated",
        entityId: parsed.data,
        templateId: "academy.activation",
        academyId: parsed.data,
        userId: actorContext.userId,
      });
    } catch (err) {
      logger.error("notifications.enqueue_failed", {
        eventType: "academy.activated",
        academyId: parsed.data,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// suspendAcademy
// ---------------------------------------------------------------------------

export type SuspendAcademyResult =
  | { ok: true; subscription: SubscriptionLifecycleSummary }
  | { ok: false; error: LifecycleActionError };

/**
 * Administrative ("for cause") suspension — fires the `suspend` event added
 * to lib/subscriptions/state-machine.ts by this item. Distinct from the
 * lazy, computed Past Due -> Suspended grace-period flip: this is a
 * platform_owner clicking "Suspend" for a reason unrelated to non-payment
 * (see state-machine.ts's top-of-file "Item 26 addition" note). Requires a
 * reason, stored on the audit row (PLAN.md's general rule: "for
 * administrative actions — the required reason").
 */
export async function suspendAcademy(
  actorContext: AuthContext,
  academyId: string,
  reason: string,
): Promise<SuspendAcademyResult> {
  const allowed = await hasPermission(actorContext, SUSPEND_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: forbidden("You don't have permission to suspend academies.") };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return { ok: false, error: { code: "validation", message: parsedReason.error.issues[0]?.message ?? "A reason is required." } };
  }

  const result = await db.transaction(async (tx) => {
    const academy = await fetchAcademyGuardRow(tx, parsedId.data);
    if (!academy) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }
    if (academy.closedAt) {
      return { ok: false, error: ACADEMY_CLOSED_ERROR } as const;
    }

    const subscription = await getCurrentSubscription(tx, parsedId.data);
    if (!subscription) {
      return { ok: false, error: NO_SUBSCRIPTION_ERROR } as const;
    }

    const transition = transitionSubscriptionState(subscription.status, "suspend");
    if (!transition.ok) {
      return {
        ok: false,
        error: { code: "invalid_transition", message: transition.error.message },
      } as const;
    }

    const [updated] = await tx
      .update(academySubscriptions)
      .set({
        status: transition.status,
        suspendedAt: new Date(),
        updatedBy: actorContext.userId,
        notes: parsedReason.data,
      })
      .where(
        and(
          eq(academySubscriptions.id, subscription.id),
          eq(academySubscriptions.status, subscription.status),
        ),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: { code: "conflict", message: "This subscription was changed by another request. Please retry." },
      } as const;
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: academy.id,
        action: "suspendAcademy",
        entityType: "academy_subscription",
        entityId: updated.id,
        before: { status: subscription.status },
        after: { status: updated.status, suspendedAt: updated.suspendedAt },
        reason: parsedReason.data,
      },
      tx,
    );

    return { ok: true, subscription: toSubscriptionSummary(updated) } as const;
  });

  // Phase 5 Item 58b: MANDATORY template (academy.suspension) — fired only
  // after db.transaction above has committed (never passed `tx`), so a
  // notification-enqueue failure never rolls back an already-successful
  // suspension. Caught and logged, never rethrown. There is no preference
  // storage yet to gate this on (see templates.ts's own comment), so it
  // always fires unconditionally on success, matching "mandatory" as far as
  // this item can implement it.
  if (result.ok) {
    try {
      await enqueueNotification({
        eventType: "academy.suspended",
        entityId: parsedId.data,
        templateId: "academy.suspension",
        academyId: parsedId.data,
        userId: actorContext.userId,
      });
    } catch (err) {
      logger.error("notifications.enqueue_failed", {
        eventType: "academy.suspended",
        academyId: parsedId.data,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// reactivateAcademy
// ---------------------------------------------------------------------------

export type ReactivateAcademyResult =
  | { ok: true; subscription: SubscriptionLifecycleSummary }
  | { ok: false; error: LifecycleActionError };

const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Administrative counterpart to `suspendAcademy` — fires the `reactivate`
 * event added to lib/subscriptions/state-machine.ts by this item. Unlike
 * `renewSubscription` (Item 30, not built by this item), this does NOT
 * require a verified payment, because it exists only for the
 * administrative-suspension case: an academy suspended for cause, with no
 * payment ever being the blocker. To keep that boundary real rather than a
 * loophole around PLAN.md's "no verified payment, no renewal" rule, this
 * function independently re-derives whether the current Suspended status
 * would ALSO be explained by the lazy, payment-driven grace-period flip
 * (ends_at + the 7-day grace period already elapsed) and refuses to fire if
 * so — that case must go through renewSubscription with a verified payment
 * instead. A reason is optional here (unlike suspend/cancel/close): granting
 * back access is not a "consequential, access-reducing" action in the sense
 * PLAN.md's required-reason rule targets.
 */
export async function reactivateAcademy(
  actorContext: AuthContext,
  academyId: string,
  reason?: string,
): Promise<ReactivateAcademyResult> {
  const allowed = await hasPermission(actorContext, REACTIVATE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: forbidden("You don't have permission to reactivate academies.") };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }
  let normalizedReason: string | undefined;
  if (reason !== undefined && reason.trim().length > 0) {
    const parsedReason = reasonSchema.safeParse(reason);
    if (!parsedReason.success) {
      return { ok: false, error: { code: "validation", message: parsedReason.error.issues[0]?.message ?? "Invalid reason." } };
    }
    normalizedReason = parsedReason.data;
  }

  return db.transaction(async (tx) => {
    const academy = await fetchAcademyGuardRow(tx, parsedId.data);
    if (!academy) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }
    if (academy.closedAt) {
      return { ok: false, error: ACADEMY_CLOSED_ERROR } as const;
    }

    const subscription = await getCurrentSubscription(tx, parsedId.data);
    if (!subscription) {
      return { ok: false, error: NO_SUBSCRIPTION_ERROR } as const;
    }

    const transition = transitionSubscriptionState(subscription.status, "reactivate");
    if (!transition.ok) {
      return {
        ok: false,
        error: { code: "invalid_transition", message: transition.error.message },
      } as const;
    }

    const paymentLapsed =
      subscription.endsAt !== null &&
      Date.now() > subscription.endsAt.getTime() + GRACE_PERIOD_MS;
    if (paymentLapsed) {
      return {
        ok: false,
        error: {
          code: "payment_lapse",
          message:
            "This subscription is suspended for non-payment past its grace period. Use renewSubscription with a verified payment instead.",
        },
      } as const;
    }

    const [updated] = await tx
      .update(academySubscriptions)
      .set({
        status: transition.status,
        activatedAt: new Date(),
        updatedBy: actorContext.userId,
        ...(normalizedReason !== undefined ? { notes: normalizedReason } : {}),
      })
      .where(
        and(
          eq(academySubscriptions.id, subscription.id),
          eq(academySubscriptions.status, subscription.status),
        ),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: { code: "conflict", message: "This subscription was changed by another request. Please retry." },
      } as const;
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: academy.id,
        action: "reactivateAcademy",
        entityType: "academy_subscription",
        entityId: updated.id,
        before: { status: subscription.status },
        after: { status: updated.status, activatedAt: updated.activatedAt },
        reason: normalizedReason,
      },
      tx,
    );

    return { ok: true, subscription: toSubscriptionSummary(updated) };
  });
}

// ---------------------------------------------------------------------------
// cancelAcademy
// ---------------------------------------------------------------------------

export type CancelAcademyResult =
  | { ok: true; subscription: SubscriptionLifecycleSummary }
  | { ok: false; error: LifecycleActionError };

/**
 * Administrative cancellation — fires the state machine's existing `cancel`
 * event (Item 23) from any of Trial/Active/Past Due/Suspended/Expired. Also
 * doubles as PLAN.md's "required-reason rejection" path for an academy that
 * never gets approved (Phase 1 §4: "a required-reason rejection reuses the
 * existing cancelAcademy action rather than adding a separate
 * rejectAcademy"): when the current subscription is still Draft,
 * state-machine.ts's `cancel` event deliberately rejects it (Draft is not
 * one of the table's listed "any of" sources — see its own comment and the
 * dedicated test "specifically rejects cancelling a Draft subscription"),
 * so that one specific source status is handled directly here instead of
 * through the pure state machine.
 */
export async function cancelAcademy(
  actorContext: AuthContext,
  academyId: string,
  reason: string,
): Promise<CancelAcademyResult> {
  const allowed = await hasPermission(actorContext, CANCEL_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: forbidden("You don't have permission to cancel academies.") };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return { ok: false, error: { code: "validation", message: parsedReason.error.issues[0]?.message ?? "A reason is required." } };
  }

  return db.transaction(async (tx) => {
    const academy = await fetchAcademyGuardRow(tx, parsedId.data);
    if (!academy) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }
    if (academy.closedAt) {
      return { ok: false, error: ACADEMY_CLOSED_ERROR } as const;
    }

    const subscription = await getCurrentSubscription(tx, parsedId.data);
    if (!subscription) {
      return { ok: false, error: NO_SUBSCRIPTION_ERROR } as const;
    }

    let nextStatus: SubscriptionStatus;
    if (subscription.status === "draft") {
      // See this function's top-of-file comment: Draft is deliberately
      // excluded from the state machine's `cancel` event, yet PLAN.md
      // explicitly requires cancelAcademy to be usable on a
      // never-approved (still-Draft) academy as its rejection path.
      nextStatus = "cancelled";
    } else {
      const transition = transitionSubscriptionState(subscription.status, "cancel");
      if (!transition.ok) {
        return {
          ok: false,
          error: { code: "invalid_transition", message: transition.error.message },
        } as const;
      }
      nextStatus = transition.status;
    }

    const [updated] = await tx
      .update(academySubscriptions)
      .set({
        status: nextStatus,
        cancelledAt: new Date(),
        updatedBy: actorContext.userId,
        notes: parsedReason.data,
      })
      .where(
        and(
          eq(academySubscriptions.id, subscription.id),
          eq(academySubscriptions.status, subscription.status),
        ),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: { code: "conflict", message: "This subscription was changed by another request. Please retry." },
      } as const;
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: academy.id,
        action: "cancelAcademy",
        entityType: "academy_subscription",
        entityId: updated.id,
        before: { status: subscription.status },
        after: { status: updated.status, cancelledAt: updated.cancelledAt },
        reason: parsedReason.data,
      },
      tx,
    );

    return { ok: true, subscription: toSubscriptionSummary(updated) };
  });
}

// ---------------------------------------------------------------------------
// closeAcademy
// ---------------------------------------------------------------------------

export type CloseAcademyResult =
  | { ok: true; academy: { id: string; closedAt: Date } }
  | { ok: false; error: LifecycleActionError };

/**
 * One-way, permanent closure (PLAN.md §6): sets `academies.closed_at`,
 * "blocks all further writes academy-wide," and "overrides every
 * subscription state, independent of [the transition] table" — this
 * deliberately does NOT touch academy_subscriptions at all, matching
 * state-machine.ts's own top-of-file note that closeAcademy "sets
 * academies.closed_at ... and overrides subscription status entirely rather
 * than transitioning it." Requires a reason, "stored on the audit row"
 * (PLAN.md's literal wording) — not on any academy_subscriptions column.
 *
 * Deliberately NOT done here (out of this item's scope per the task brief —
 * belongs to Item 27's access-gate middleware): revoking the academy's
 * active sessions / blocking academy-console logins. PLAN.md describes that
 * as happening "at the next auth check," i.e. reactively, by the gate that
 * reads closed_at on every `/academy/*` request — not as a side effect this
 * action needs to perform proactively.
 */
export async function closeAcademy(
  actorContext: AuthContext,
  academyId: string,
  reason: string,
): Promise<CloseAcademyResult> {
  const allowed = await hasPermission(actorContext, CLOSE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: forbidden("You don't have permission to close academies.") };
  }

  const parsedId = academyIdSchema.safeParse(academyId);
  if (!parsedId.success) {
    return { ok: false, error: { code: "validation", message: parsedId.error.issues[0]?.message ?? "Invalid input." } };
  }
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return { ok: false, error: { code: "validation", message: parsedReason.error.issues[0]?.message ?? "A reason is required." } };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: academies.id, closedAt: academies.closedAt })
      .from(academies)
      .where(eq(academies.id, parsedId.data))
      .limit(1);

    if (!existing) {
      return { ok: false, error: { code: "not_found", message: "Academy not found." } } as const;
    }
    if (existing.closedAt) {
      return {
        ok: false,
        error: { code: "already_closed", message: "This academy is already closed." },
      } as const;
    }

    // The `closedAt IS NULL` clause here (not just the select above) closes
    // the race between two concurrent closeAcademy calls — same pattern as
    // approveAcademy's `approvedAt IS NULL` guard.
    const [updated] = await tx
      .update(academies)
      .set({ closedAt: new Date() })
      .where(and(eq(academies.id, parsedId.data), isNull(academies.closedAt)))
      .returning({ id: academies.id, closedAt: academies.closedAt });

    if (!updated) {
      return {
        ok: false,
        error: { code: "already_closed", message: "This academy is already closed." },
      } as const;
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: updated.id,
        action: "closeAcademy",
        entityType: "academy",
        entityId: updated.id,
        before: { closedAt: null },
        after: { closedAt: updated.closedAt },
        reason: parsedReason.data,
      },
      tx,
    );

    return { ok: true, academy: { id: updated.id, closedAt: updated.closedAt as Date } };
  });
}
