/**
 * Pure, framework-agnostic subscription state machine — PLAN.md Phase 1,
 * Item 23 ("academy_subscriptions migration + full state-transition-table
 * implementation incl. 7-day grace computation and Trial -> Expired lazy
 * flip + unit tests per transition").
 *
 * This file has no DB dependency on purpose: Items 24-30 (createAcademySubscription,
 * payments, activate/suspend/reactivate/cancel/close, the access gate, usage
 * tracking, renewal) each wrap one or more of these functions with
 * permission checks, Zod validation, a DB transaction, and an audit write —
 * none of which belongs here. This module only answers "is this transition
 * legal, and what does it produce."
 *
 * PLAN.md Phase 1 §6 — "Subscription state machine — exact transition
 * table":
 *
 *   | From                                            | To          | Trigger                                            | Actor           |
 *   |--------------------------------------------------|-------------|-----------------------------------------------------|-----------------|
 *   | Draft                                             | Trial       | Plan assigned, trial period starts                   | platform_owner (via createAcademySubscription) |
 *   | Draft                                             | Active      | Plan assigned with no trial + activateAcademy        | platform_owner |
 *   | Trial                                              | Active      | activateAcademy (checklist satisfied)                | platform_owner |
 *   | Trial                                              | Expired     | trial_ends_at passes without activation              | computed at access-check time (lazy, no job) |
 *   | Trial                                              | Cancelled   | Administrative cancellation                          | platform_owner |
 *   | Active                                             | Past Due    | ends_at passes without a renewal                     | computed at access-check time (lazy, no job) |
 *   | Past Due                                           | Active      | renewSubscription (verified payment)                 | platform_owner |
 *   | Past Due                                           | Suspended   | 7-day grace period elapses                           | computed at access-check time (lazy, no job) |
 *   | Suspended                                          | Active      | renewSubscription (verified payment) — reactivates in the same call | platform_owner |
 *   | Expired                                            | Active      | renewSubscription (verified payment)                 | platform_owner |
 *   | any of Active/Trial/Past Due/Suspended/Expired     | Cancelled   | Administrative cancellation                          | platform_owner |
 *   | Cancelled                                          | (none)      | Terminal — resuming service requires a NEW academy_subscriptions row via createAcademySubscription, never a transition out of Cancelled | - |
 *   | any state                                          | (academy closed_at set) | closeAcademy | platform_owner — permanent, overrides every subscription state, independent of this table |
 *
 * "Every transition is one of these; anything not listed is rejected
 * server-side regardless of what the UI sends." The closeAcademy row is
 * deliberately NOT modeled by this state machine — it sets academies.closed_at
 * (a column on a different table, owned by a different item) and overrides
 * subscription status entirely rather than transitioning it; it belongs to
 * closeAcademy (Item 26), not here.
 *
 * --- Item 26 addition: `suspend` / `reactivate` events ---
 *
 * The literal table above has exactly one path into Suspended (the lazy,
 * computed Past Due -> Suspended grace-period flip) and exactly one path out
 * (renewSubscription's verified-payment-gated reactivation). It has no row
 * for a manual, administrative "suspend this academy right now, for a reason
 * unrelated to non-payment" action, or a manual reactivation that doesn't
 * require a payment. Item 26 (lib/academies/lifecycle.ts) still has to build
 * standalone `suspendAcademy`/`reactivateAcademy` server actions per PLAN.md
 * Phase 1 §4's action list and item 26's checklist entry, and DESIGN.md
 * (§8's `/platform/academies/[id]` action row, §11.1's Suspended-state copy
 * "contact the platform owner to reactivate") depicts Suspend/Reactivate as
 * standalone buttons distinct from the payment-driven Renew action on
 * `/platform/subscriptions`. Two new events are added here — additively,
 * nothing above is changed — to give those actions a real transition rather
 * than duplicating transition logic outside this module:
 *
 *   - `suspend`: active/trial/past_due -> suspended. An administrative,
 *     "for cause" suspension (e.g. a policy violation), orthogonal to
 *     non-payment. Excluded sources: draft (nothing running to suspend),
 *     suspended (no-op), expired/cancelled (already not serving traffic).
 *   - `reactivate`: suspended -> active. The administrative counterpart.
 *     This function only answers "is this transition legal in the abstract"
 *     — it has no way to know *why* a given row is currently Suspended.
 *     lib/academies/lifecycle.ts's reactivateAcademy adds the business-rule
 *     guard this module deliberately doesn't encode: it refuses to fire this
 *     event when the subscription's lapse is payment-driven (i.e. when
 *     computeLazySubscriptionStatus would independently already call it
 *     Suspended purely from ends_at + the grace period), directing the
 *     caller to renewSubscription instead — preserving PLAN.md's hard "no
 *     verified payment, no renewal" rule. This event exists only for the
 *     administrative-suspension case `suspend` produces.
 */

export const SUBSCRIPTION_STATUSES = [
  "draft",
  "trial",
  "active",
  "past_due",
  "suspended",
  "expired",
  "cancelled",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Every actor/human-triggered transition in the table above, named after
 * PLAN.md's own vocabulary for the action that fires it. The two lazily
 * computed rows (Trial->Expired, Active->PastDue, PastDue->Suspended) are
 * NOT events here — see computeLazySubscriptionStatus below, the only path
 * that ever produces those statuses, matching PLAN.md's "computed at
 * access-check time (lazy, no job)" — there is no scheduled job anywhere in
 * this state machine.
 */
export type SubscriptionTransitionEvent =
  | "start_trial"
  | "activate"
  | "renew"
  | "cancel"
  // Item 26 addition — see the top-of-file "Item 26 addition" note above.
  | "suspend"
  | "reactivate";

export interface SubscriptionTransitionError {
  code: "invalid_transition";
  message: string;
}

export type SubscriptionTransitionResult =
  | { ok: true; status: SubscriptionStatus }
  | { ok: false; error: SubscriptionTransitionError };

// Table-driven, matching the literal rows quoted above. `Partial` because
// most events are only legal from a subset of statuses; a missing entry
// means "not listed" -> rejected, per PLAN.md's own instruction.
const ALLOWED_TRANSITIONS: Record<
  SubscriptionTransitionEvent,
  Partial<Record<SubscriptionStatus, SubscriptionStatus>>
> = {
  // Draft -> Trial: "Plan assigned, trial period starts", via
  // createAcademySubscription (Item 24).
  start_trial: {
    draft: "trial",
  },
  // Draft -> Active: "Plan assigned with no trial + activateAcademy".
  // Trial -> Active: "activateAcademy (checklist satisfied)".
  activate: {
    draft: "active",
    trial: "active",
  },
  // Past Due/Suspended/Expired -> Active via renewSubscription (verified
  // payment). Active -> Active is an explicit no-op on status, per PLAN.md
  // §6's renewSubscription rule: "If the source state is already Active,
  // status is simply left as Active (renewal is a no-op on status, only
  // ends_at moves)" — included here so callers can always route a renewal
  // through this same function regardless of source state.
  renew: {
    active: "active",
    past_due: "active",
    suspended: "active",
    expired: "active",
  },
  // Administrative cancellation, from any of Active/Trial/Past
  // Due/Suspended/Expired. Draft is deliberately excluded: the table's "any
  // of" row lists exactly those five statuses, not Draft — a still-Draft
  // subscription is not a listed source for this transition, so cancelling
  // it via this event is rejected (a Draft academy_subscriptions row that
  // needs to go away is an academy-level concern, e.g. cancelAcademy acting
  // on the academy itself, not a transition this table defines).
  cancel: {
    trial: "cancelled",
    active: "cancelled",
    past_due: "cancelled",
    suspended: "cancelled",
    expired: "cancelled",
  },
  // Item 26 addition — administrative ("for cause") suspension, distinct
  // from the lazy Past Due -> Suspended flip. See the top-of-file
  // "Item 26 addition" note for why this isn't in PLAN.md's literal table.
  suspend: {
    active: "suspended",
    trial: "suspended",
    past_due: "suspended",
  },
  // Item 26 addition — the administrative counterpart to `suspend`. The
  // payment-lapse guard (refusing to reactivate a Suspended subscription
  // that lapsed for non-payment) is enforced by the caller
  // (lib/academies/lifecycle.ts), not here — see the top-of-file note.
  reactivate: {
    suspended: "active",
  },
};

/**
 * Validates and resolves one actor-triggered transition. Returns the
 * resulting status on success, or a rejection describing exactly why —
 * callers (Items 24/26/30's server actions) are responsible for the
 * permission check, Zod validation, DB transaction, timestamp field updates
 * (activated_at/suspended_at/cancelled_at/renewed_at etc.), and audit write
 * around this pure decision.
 */
export function transitionSubscriptionState(
  current: SubscriptionStatus,
  event: SubscriptionTransitionEvent,
): SubscriptionTransitionResult {
  const nextStatus = ALLOWED_TRANSITIONS[event][current];
  if (!nextStatus) {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `Cannot apply "${event}" to a subscription in status "${current}".`,
      },
    };
  }
  return { ok: true, status: nextStatus };
}

/** The 7-day grace period PLAN.md's table names for Past Due -> Suspended. */
export const GRACE_PERIOD_DAYS = 7;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export interface LazySubscriptionStatusInput {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  endsAt: Date | null;
}

/**
 * Computes the subscription's *effective* status at `now`, applying the
 * table's three lazy, no-job transitions:
 *   - Trial -> Expired: "trial_ends_at passes without activation"
 *   - Active -> Past Due: "ends_at passes without a renewal"
 *   - Past Due -> Suspended: "7-day grace period elapses"
 *
 * Every other stored status (Draft, Suspended, Expired, Cancelled) is
 * time-invariant here — PLAN.md's table gives Suspended/Expired/Cancelled no
 * further lazy transition; they only ever change via an explicit renew or
 * cancel event (or, for Cancelled, a brand-new subscription row).
 *
 * Pure function — it never reads or writes the database. PLAN.md: "the gate
 * treats access as Suspended immediately (computed, not stored), and the
 * stored status value is lazily flipped to Suspended the next time that
 * subscription row is read or written by any action" — the access gate
 * (Item 27) and every mutation (Items 26/30) call this to decide the
 * *effective* status for a read, and persist the result back onto the row
 * themselves when it differs from what's stored; this function does not
 * perform that persistence.
 */
export function computeLazySubscriptionStatus(
  input: LazySubscriptionStatusInput,
  now: Date = new Date(),
): SubscriptionStatus {
  const { status, trialEndsAt, endsAt } = input;

  if (status === "trial") {
    if (trialEndsAt && now.getTime() > trialEndsAt.getTime()) {
      return "expired";
    }
    return "trial";
  }

  // Active and Past Due share one computation: both are entirely a function
  // of how far past ends_at "now" is, regardless of which of the two the
  // row currently has stored — a long-dormant row (no read/write since
  // lapsing) jumps straight from stored "active" to effective "suspended"
  // without ever having been persisted as "past_due" in between, matching
  // PLAN.md's "treats access as Suspended immediately" language.
  if (status === "active" || status === "past_due") {
    if (!endsAt) return status;
    if (now.getTime() <= endsAt.getTime()) {
      return "active";
    }
    const graceDeadline = endsAt.getTime() + GRACE_PERIOD_MS;
    if (now.getTime() <= graceDeadline) {
      return "past_due";
    }
    return "suspended";
  }

  return status;
}

export interface InitialSubscriptionStatusInput {
  /** Null/undefined when the plan/call has no trial period. */
  trialEndsAt: Date | null | undefined;
}

/**
 * The status a brand-new academy_subscriptions row is created in —
 * createAcademySubscription's own status choice (Item 24, not built yet).
 * Per the Draft->Trial row, assigning a plan with a trial period starts the
 * subscription straight in Trial; otherwise it stays Draft until a
 * subsequent, separate activateAcademy call moves it to Active (the
 * Draft->Active row) — creation itself never produces Active directly.
 */
export function initialSubscriptionStatus(
  input: InitialSubscriptionStatusInput,
): SubscriptionStatus {
  return input.trialEndsAt ? "trial" : "draft";
}

/** Cancelled is the table's only terminal state — see the Cancelled row. */
export function isTerminalSubscriptionStatus(
  status: SubscriptionStatus,
): boolean {
  return status === "cancelled";
}
