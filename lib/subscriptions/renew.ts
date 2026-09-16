import { and, asc, desc, eq, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  subscriptionPaymentConsumptions,
  subscriptionPayments,
  subscriptionPlans,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  computeLazySubscriptionStatus,
  GRACE_PERIOD_DAYS,
  transitionSubscriptionState,
  type SubscriptionStatus,
} from "@/lib/subscriptions/state-machine";
import type { BillingPeriod } from "@/lib/subscriptions/plans";

/**
 * PLAN.md Phase 1, Item 30 — "`subscription_payment_consumptions` migration +
 * `renewSubscription` ... + a `/platform/subscriptions` page."
 *
 * PLAN.md §6, verbatim algorithm this file implements:
 *
 *   "renewSubscription — exact rule. Valid only from Active, Past Due,
 *   Suspended, or Expired. Rejected outright from Draft, Trial (those
 *   convert via activateAcademy, not renewal), or Cancelled (a cancelled
 *   subscription is final — resuming service means creating a new
 *   subscription via createAcademySubscription, not renewing the old
 *   one). A hard precondition for every call regardless of source state:
 *   there must be at least one subscription_payments row with status =
 *   Verified for this subscription that hasn't already been consumed by a
 *   prior renewal — no verified payment, no renewal, full stop. This is
 *   enforced as a real transaction: (1) open a DB transaction and lock the
 *   candidate subscription_payments row (SELECT ... FOR UPDATE); (2)
 *   verify it is status = Verified and not reversed; (3) verify no
 *   subscription_payment_consumptions row already references it (the
 *   table's unique constraint on subscription_payment_id makes a
 *   double-spend impossible even under a race — the second concurrent
 *   transaction's insert simply fails); (4) insert the consumption row
 *   (subscription_payment_id, academy_subscription_id, consumed_at,
 *   consumed_by); (5) update academy_subscriptions.ends_at/renewed_at/
 *   renewed_by/status; (6) write the audit row; (7) commit atomically.
 *   Effect on dates: starts_at is never changed by renewal; ends_at
 *   becomes max(current ends_at, now) + plan.billing_period. Effect on
 *   status: if the source state is Past Due, Suspended, or Expired,
 *   renewSubscription also reactivates in the same call — sets status =
 *   Active itself, no separate manual reactivate click required. If the
 *   source state is already Active, status is simply left as Active
 *   (renewal is a no-op on status, only ends_at moves). Every renewal is
 *   audit-logged with before/after status and ends_at, plus the verified
 *   payment reference it relied on."
 *
 * -----------------------------------------------------------------------
 * How the 7 steps map onto this file's `renewSubscription` transaction
 * -----------------------------------------------------------------------
 * PLAN's step (1) locks the *payment* row. This implementation locks the
 * *academy_subscriptions* row first (`SELECT ... FOR UPDATE`), then the
 * candidate payment row, in that fixed order every call — a judgment call
 * beyond PLAN's literal text, for two reasons: (a) it additionally
 * serializes two concurrent renewals against *different* verified
 * payments on the *same* subscription, closing a lost-update race on
 * `ends_at`/`status` that PLAN's algorithm doesn't call out but that a
 * naive read-then-write on that row would still be exposed to; (b) a
 * fixed lock order (subscription, then payment) on every call rules out a
 * deadlock between two concurrent renewals. It doesn't weaken PLAN's own
 * guarantee: the double-spend-by-unique-constraint backstop (step 3/the
 * schema's `UNIQUE(subscription_payment_id)`) is still in place exactly
 * as specified, it just becomes a defense-in-depth layer that (given this
 * extra locking) should never actually need to fire in practice — the
 * concurrent-renewal test below asserts the *outcome* PLAN cares about
 * (exactly one renewal succeeds, exactly one consumption row exists),
 * not the specific code path that produced it.
 *
 * The candidate payment for a subscription with more than one eligible
 * (Verified, unconsumed) row is chosen oldest-`received_at`-first (FIFO) —
 * PLAN.md never states an ordering rule for this case (a subscription
 * that has accumulated more than one verified-but-unconsumed payment,
 * e.g. an academy that pays two renewal cycles in advance before either
 * is spent), so the most defensible default is applied: consume in the
 * order payments were actually received, same as ordinary accounting
 * practice, rather than e.g. newest-first or largest-first.
 */

const RENEW_CAPABILITY = "renewSubscription";

// PLAN.md's state-transition table lists exactly these four as valid
// renewSubscription sources (`transitionSubscriptionState`'s own `renew`
// event map already encodes this — see lib/subscriptions/state-machine.ts
// — this constant exists only to phrase the "Draft/Trial/Cancelled
// rejected outright" half of the rule in a readable one-liner below,
// nothing more; the actual accept/reject decision is
// `transitionSubscriptionState`'s, not this list's).
const RENEWABLE_SOURCE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "active",
  "past_due",
  "suspended",
  "expired",
]);

export interface RenewSubscriptionError {
  code:
    | "forbidden"
    | "validation"
    | "not_found"
    | "invalid_transition"
    | "no_verified_payment";
  message: string;
}

export interface RenewSubscriptionSuccess {
  subscriptionId: string;
  academyId: string;
  statusBefore: SubscriptionStatus;
  status: SubscriptionStatus;
  endsAtBefore: Date | null;
  endsAt: Date;
  renewedAt: Date;
  renewedBy: string;
  consumedPaymentId: string;
}

export type RenewSubscriptionResult =
  | { ok: true; subscription: RenewSubscriptionSuccess }
  | { ok: false; error: RenewSubscriptionError };

const renewSubscriptionInputSchema = z.object({
  subscriptionId: z.string().uuid("A valid subscription is required"),
});

export type RenewSubscriptionInput = z.input<typeof renewSubscriptionInputSchema>;

function billingPeriodToInterval(period: BillingPeriod): { months?: number; years?: number } {
  switch (period) {
    case "monthly":
      return { months: 1 };
    case "quarterly":
      return { months: 3 };
    case "annual":
      return { years: 1 };
  }
}

/**
 * `ends_at` arithmetic for a renewal: calendar-month/year addition (via
 * UTC setters, since `ends_at` is a `timestamptz` column and every other
 * date computation in this codebase — e.g. `createAcademySubscription`'s
 * `trialEndsAt` — anchors to the stored instant rather than a server-local
 * wall clock) rather than a fixed-days approximation, so a monthly plan
 * renewed every cycle lands on the same day-of-month indefinitely instead
 * of drifting.
 */
function addBillingPeriod(base: Date, period: BillingPeriod): Date {
  const { months, years } = billingPeriodToInterval(period);
  const result = new Date(base.getTime());
  if (months) result.setUTCMonth(result.getUTCMonth() + months);
  if (years) result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

/**
 * PLAN.md §4/§5: `renewSubscription`, platform_owner-only (`renewSubscription`
 * is in `UNGRANTABLE_CAPABILITIES`, lib/auth/permissions.ts — never
 * grantable to a `platform_admin`, no matter what they've been granted).
 *
 * Runs the full algorithm in one `db.transaction`, per PLAN.md's own
 * "enforced as a real transaction, not just an application check" framing
 * — see the module comment above for the exact step-by-step mapping and
 * the documented deviation (locking the subscription row ahead of the
 * payment row).
 */
export async function renewSubscription(
  actorContext: AuthContext,
  input: RenewSubscriptionInput,
): Promise<RenewSubscriptionResult> {
  const allowed = await hasPermission(actorContext, RENEW_CAPABILITY);
  if (!allowed) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "Only the platform owner can renew a subscription.",
      },
    };
  }

  const parsed = renewSubscriptionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const { subscriptionId } = parsed.data;

  const result = await db.transaction(async (tx) => {
    // Step (1)-adjacent: lock the academy_subscriptions row first (see
    // module comment for why this is locked ahead of the payment row).
    const [subscription] = await tx
      .select()
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId))
      .for("update");

    if (!subscription) {
      return { outcome: "not_found" as const };
    }

    const now = new Date();
    const rawStatus = subscription.status as SubscriptionStatus;

    // The *effective* status governs eligibility, not necessarily the raw
    // stored value — a Trial row whose trial_ends_at has silently lapsed
    // (nobody has visited /academy/* to trigger access-gate.ts's lazy
    // flip yet) is really an Expired subscription and PLAN.md lists
    // Expired, not Trial, as a valid renewSubscription source. Reusing
    // computeLazySubscriptionStatus here (never reimplemented) is the
    // same pattern lib/academies/access-gate.ts already establishes for
    // "every mutation" needing the true current status, not the possibly
    // stale stored one.
    const effectiveStatus = computeLazySubscriptionStatus(
      {
        status: rawStatus,
        trialEndsAt: subscription.trialEndsAt,
        endsAt: subscription.endsAt,
      },
      now,
    );

    const transition = transitionSubscriptionState(effectiveStatus, "renew");
    if (!transition.ok) {
      // Not in RENEWABLE_SOURCE_STATUSES, by construction — the `renew`
      // event's transition map (lib/subscriptions/state-machine.ts) only
      // ever accepts Active/Past Due/Suspended/Expired, so !transition.ok
      // here always means the effective status is Draft, Trial, or
      // Cancelled.
      return {
        outcome: "invalid_transition" as const,
        message: `Cannot renew a subscription in status "${effectiveStatus}". Renewal is only valid from Active, Past Due, Suspended, or Expired.`,
      };
    }

    // Step (1): lock the candidate subscription_payments row. "Candidate"
    // = Verified, for this subscription, with no subscription_payment_
    // consumptions row referencing it yet (steps 2 and 3 folded into this
    // same query's WHERE clause; the explicit re-checks immediately below
    // still apply the rule literally, matching PLAN's numbered steps one
    // for one instead of relying solely on the query filter).
    const [candidatePayment] = await tx
      .select()
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.subscriptionId, subscriptionId),
          eq(subscriptionPayments.status, "verified"),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(subscriptionPaymentConsumptions)
              .where(
                eq(
                  subscriptionPaymentConsumptions.subscriptionPaymentId,
                  subscriptionPayments.id,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(subscriptionPayments.receivedAt))
      .limit(1)
      .for("update");

    if (!candidatePayment) {
      return {
        outcome: "no_verified_payment" as const,
        message:
          "No verified, unconsumed payment is available to fund a renewal for this subscription.",
      };
    }

    // Step (2): verify it is status = Verified and not reversed. The
    // query above already filters on status = "verified", and this
    // table's status is a single enum column (a row can never be both
    // "verified" and "reversed" simultaneously), so this is a defensive
    // re-check rather than a distinct code path — kept to mirror PLAN's
    // numbered steps literally.
    if (candidatePayment.status !== "verified") {
      return {
        outcome: "no_verified_payment" as const,
        message:
          "No verified, unconsumed payment is available to fund a renewal for this subscription.",
      };
    }

    // Step (3): verify no subscription_payment_consumptions row already
    // references it. Defensive re-check beyond the query's own notExists
    // filter (belt-and-suspenders, cheap inside an already-open
    // transaction) — the schema's UNIQUE(subscription_payment_id)
    // constraint is the actual backstop if this ever raced anyway.
    const [existingConsumption] = await tx
      .select({ id: subscriptionPaymentConsumptions.id })
      .from(subscriptionPaymentConsumptions)
      .where(
        eq(
          subscriptionPaymentConsumptions.subscriptionPaymentId,
          candidatePayment.id,
        ),
      )
      .limit(1);

    if (existingConsumption) {
      return {
        outcome: "no_verified_payment" as const,
        message: "This payment has already been consumed by a prior renewal.",
      };
    }

    const [plan] = await tx
      .select({ billingPeriod: subscriptionPlans.billingPeriod })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, subscription.planId))
      .limit(1);

    if (!plan) {
      // Defensive: subscription.planId is a real FK, so this should be
      // unreachable in practice.
      return {
        outcome: "no_verified_payment" as const,
        message: "This subscription's plan could not be found.",
      };
    }

    // Effect on dates: "starts_at is never changed by renewal; ends_at
    // becomes max(current ends_at, now) + plan.billing_period."
    const baseline =
      subscription.endsAt && subscription.endsAt.getTime() > now.getTime()
        ? subscription.endsAt
        : now;
    const newEndsAt = addBillingPeriod(
      baseline,
      plan.billingPeriod as BillingPeriod,
    );

    // Step (4): insert the consumption row.
    await tx.insert(subscriptionPaymentConsumptions).values({
      subscriptionPaymentId: candidatePayment.id,
      academySubscriptionId: subscriptionId,
      consumedBy: actorContext.userId,
    });

    // Step (5): update academy_subscriptions.ends_at/renewed_at/
    // renewed_by/status. transition.status is always "active" for every
    // legal source (Active/Past Due/Suspended/Expired all map to Active
    // via the `renew` event) — "if the source state is already Active,
    // status is simply left as Active" falls out naturally since it's a
    // no-op write of the same value.
    const [updated] = await tx
      .update(academySubscriptions)
      .set({
        endsAt: newEndsAt,
        renewedAt: now,
        renewedBy: actorContext.userId,
        status: transition.status,
        updatedBy: actorContext.userId,
      })
      .where(eq(academySubscriptions.id, subscriptionId))
      .returning();

    // Step (6): write the audit row, "with before/after status and
    // ends_at, plus the verified payment reference it relied on."
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: subscription.academyId,
        action: "renewSubscription",
        entityType: "academy_subscription",
        entityId: subscriptionId,
        before: {
          status: rawStatus,
          endsAt: subscription.endsAt,
        },
        after: {
          status: transition.status,
          endsAt: newEndsAt,
        },
        context: {
          consumedSubscriptionPaymentId: candidatePayment.id,
          // Recorded only when the raw stored status differed from the
          // effective one this renewal actually acted on (see the
          // computeLazySubscriptionStatus comment above) — an audit trail
          // for the lazy flip that this call folds into its own update
          // rather than issuing a separate persistLazyStatusFlip-style
          // write (lib/academies/access-gate.ts's pattern), since both
          // ultimately land on the same final row state in the same
          // transaction.
          ...(rawStatus !== effectiveStatus
            ? { lazyStatusBeforeRenewal: rawStatus, effectiveStatusAtRenewal: effectiveStatus }
            : {}),
        },
      },
      tx,
    );

    // Step (7): commit atomically — implicit on returning from
    // db.transaction's callback without throwing.
    return {
      outcome: "ok" as const,
      subscription: updated,
      statusBefore: rawStatus,
      endsAtBefore: subscription.endsAt,
      consumedPaymentId: candidatePayment.id,
    };
  });

  if (result.outcome === "not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "Subscription not found." },
    };
  }
  if (result.outcome === "invalid_transition") {
    return {
      ok: false,
      error: { code: "invalid_transition", message: result.message },
    };
  }
  if (result.outcome === "no_verified_payment") {
    return {
      ok: false,
      error: { code: "no_verified_payment", message: result.message },
    };
  }

  const { subscription, statusBefore, endsAtBefore, consumedPaymentId } = result;
  return {
    ok: true,
    subscription: {
      subscriptionId: subscription.id,
      academyId: subscription.academyId,
      statusBefore,
      status: subscription.status as SubscriptionStatus,
      endsAtBefore,
      // endsAt is guaranteed non-null post-renewal (we just set it).
      endsAt: subscription.endsAt as Date,
      renewedAt: subscription.renewedAt as Date,
      renewedBy: subscription.renewedBy as string,
      consumedPaymentId,
    },
  };
}

// ---------------------------------------------------------------------
// /platform/subscriptions read model
// ---------------------------------------------------------------------

/**
 * Judgment call (PLAN.md doesn't give an exact day count for this
 * indicator, unlike the 7-day Past-Due grace period, `GRACE_PERIOD_DAYS`
 * in lib/subscriptions/state-machine.ts, which is a different, already-
 * built concept — a subscription can be "expiring soon" while still
 * perfectly Active, well before it would ever become Past Due). 14 days
 * is chosen as a reasonable advance-notice window for a platform owner to
 * follow up with an academy before its subscription lapses — long enough
 * to act on, short enough to stay meaningful ("soon").
 */
export const EXPIRING_SOON_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlatformSubscriptionRow {
  subscriptionId: string;
  academyId: string;
  academyName: string;
  planName: string;
  billingPeriod: BillingPeriod;
  status: SubscriptionStatus;
  effectiveStatus: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
  trialEndsAt: Date | null;
  renewedAt: Date | null;
  /** Only set when effectiveStatus === "past_due". */
  graceDaysRemaining: number | null;
  /** DESIGN.md §7 / §11.5's "Expiring in N days" amber flag. */
  expiringSoon: boolean;
  expiringSoonDaysRemaining: number | null;
  /** Whether there is at least one Verified, unconsumed payment to renew with. */
  hasEligiblePayment: boolean;
  /** Whether the Renew action should be offered at all for this row. */
  canRenew: boolean;
  /** Reason the Renew action is unavailable, for a disabled-button tooltip (DESIGN.md §11.5). */
  renewDisabledReason: string | null;
}

function graceDaysRemaining(endsAt: Date | null, now: Date): number | null {
  if (!endsAt) return null;
  const graceDeadlineMs = endsAt.getTime() + GRACE_PERIOD_DAYS * DAY_MS;
  const msRemaining = graceDeadlineMs - now.getTime();
  return Math.max(0, Math.ceil(msRemaining / DAY_MS));
}

const CANCELLED_TOOLTIP =
  "Cancelled subscriptions can't be renewed — register a new subscription instead.";
const NOT_YET_ACTIVE_TOOLTIP =
  "Not yet active — use Activate, not Renew, for a Draft or Trial subscription.";
const NO_PAYMENT_TOOLTIP =
  "No verified payment exists for this subscription yet.";

/**
 * Read model for the `/platform/subscriptions` list (DESIGN.md §8's row).
 * Lists every academy_subscriptions row ever created (an academy can
 * accumulate more than one over time — see the Cancelled row in PLAN.md's
 * state table), newest-`starts_at`-first, matching this codebase's other
 * full-history list views (e.g. `listSubscriptionPayments`,
 * lib/subscriptions/payments.ts). Callers must already have checked
 * `hasPermission(context, "renewSubscription")` themselves — this helper
 * does not re-check, matching every other `list*` helper's convention in
 * this codebase.
 */
export async function listPlatformSubscriptions(
  now: Date = new Date(),
): Promise<PlatformSubscriptionRow[]> {
  const rows = await db
    .select({
      subscriptionId: academySubscriptions.id,
      academyId: academySubscriptions.academyId,
      academyName: academies.name,
      planName: subscriptionPlans.name,
      billingPeriod: subscriptionPlans.billingPeriod,
      status: academySubscriptions.status,
      startsAt: academySubscriptions.startsAt,
      endsAt: academySubscriptions.endsAt,
      trialEndsAt: academySubscriptions.trialEndsAt,
      renewedAt: academySubscriptions.renewedAt,
    })
    .from(academySubscriptions)
    .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .orderBy(desc(academySubscriptions.startsAt));

  if (rows.length === 0) return [];

  // Eligible-payment lookup, batched (one query for every subscription
  // rather than N) — same reasoning as lib/subscriptions/usage.ts's
  // listAcademyUsageOverview comment: "not a tenant-facing hot path", fine
  // to reduce in memory rather than chase a single clean query builder
  // expression for "latest per group" style joins.
  const eligiblePaymentRows = await db
    .select({ subscriptionId: subscriptionPayments.subscriptionId })
    .from(subscriptionPayments)
    .where(
      and(
        eq(subscriptionPayments.status, "verified"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(subscriptionPaymentConsumptions)
            .where(
              eq(
                subscriptionPaymentConsumptions.subscriptionPaymentId,
                subscriptionPayments.id,
              ),
            ),
        ),
      ),
    );
  const eligibleSubscriptionIds = new Set(
    eligiblePaymentRows.map((row) => row.subscriptionId),
  );

  return rows.map((row) => {
    const rawStatus = row.status as SubscriptionStatus;
    const effectiveStatus = computeLazySubscriptionStatus(
      { status: rawStatus, trialEndsAt: row.trialEndsAt, endsAt: row.endsAt },
      now,
    );
    const hasEligiblePayment = eligibleSubscriptionIds.has(row.subscriptionId);

    const msUntilEnd = row.endsAt ? row.endsAt.getTime() - now.getTime() : null;
    // "Expiring soon" is deliberately narrower than Past Due/grace (a
    // different, already-computed state): only a still-fully-Active
    // subscription whose ends_at is coming up counts — once it's actually
    // lapsed into Past Due/Suspended/Expired, the status badge itself is
    // the more urgent signal, not this amber flag.
    const expiringSoon =
      effectiveStatus === "active" &&
      msUntilEnd !== null &&
      msUntilEnd > 0 &&
      msUntilEnd <= EXPIRING_SOON_WINDOW_DAYS * DAY_MS;
    const expiringSoonDaysRemaining = expiringSoon
      ? Math.ceil((msUntilEnd as number) / DAY_MS)
      : null;

    let canRenew = false;
    let renewDisabledReason: string | null = null;
    if (rawStatus === "cancelled" || effectiveStatus === "cancelled") {
      renewDisabledReason = CANCELLED_TOOLTIP;
    } else if (!RENEWABLE_SOURCE_STATUSES.has(effectiveStatus)) {
      renewDisabledReason = NOT_YET_ACTIVE_TOOLTIP;
    } else if (!hasEligiblePayment) {
      renewDisabledReason = NO_PAYMENT_TOOLTIP;
    } else {
      canRenew = true;
    }

    return {
      subscriptionId: row.subscriptionId,
      academyId: row.academyId,
      academyName: row.academyName,
      planName: row.planName,
      billingPeriod: row.billingPeriod as BillingPeriod,
      status: rawStatus,
      effectiveStatus,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      trialEndsAt: row.trialEndsAt,
      renewedAt: row.renewedAt,
      graceDaysRemaining:
        effectiveStatus === "past_due" ? graceDaysRemaining(row.endsAt, now) : null,
      expiringSoon,
      expiringSoonDaysRemaining,
      hasEligiblePayment,
      canRenew,
      renewDisabledReason,
    };
  });
}
