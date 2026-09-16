/**
 * PLAN.md Phase 1, Item 27 — "Subscription-status gate middleware for
 * `/academy/*` (incl. grace period and closure blocking)."
 *
 * ---------------------------------------------------------------------
 * Why this is a plain server-side helper, not literal Next.js
 * middleware/proxy
 * ---------------------------------------------------------------------
 * This repo's AGENTS.md warns that this Next.js version has breaking
 * changes vs. training data and to read `node_modules/next/dist/docs/`
 * before writing code. Doing that here turned up two decisive facts:
 *
 * 1. `middleware.ts` is deprecated in Next.js 16 and renamed to
 *    `proxy.ts` (`node_modules/next/dist/docs/01-app/03-api-reference/
 *    03-file-conventions/middleware.md`: "The `middleware.js` file
 *    convention has been deprecated ... and renamed to `proxy.js`.").
 *    So even the "build literal middleware" option would mean writing
 *    `proxy.ts`, not `middleware.ts`, in this version.
 * 2. Proxy (`.../03-file-conventions/proxy.md`) now defaults to the
 *    Node.js runtime as of v16 ("Proxy defaults to using the Node.js
 *    runtime. The `runtime` config option is not available in Proxy
 *    files."), which sounds like it would remove the historical
 *    Edge-runtime blocker on using `pg` (this project's
 *    `lib/db` client is `drizzle-orm/node-postgres` over a `pg.Pool` —
 *    a persistent TCP connection pool, not Edge-compatible). But the
 *    getting-started guide (`01-app/01-getting-started/16-proxy.md`)
 *    explicitly narrows what Proxy is *for*, independent of runtime:
 *    "Proxy is _not_ intended for slow data fetching... it should not
 *    be used as a full session management or authorization solution."
 *    The API reference adds: "Proxy is meant to be invoked separately
 *    of your render code and in optimized cases deployed to your CDN
 *    for fast redirect/rewrite handling, you should not attempt
 *    relying on shared modules or globals." A module-level `pg.Pool`
 *    singleton (exactly what `lib/db/index.ts` is) is precisely the
 *    kind of shared-module/global state that warning is about, and a
 *    live Postgres query per request is precisely the "slow data
 *    fetching" it says not to do there.
 *
 * Given that explicit guidance, this gate is a regular async function
 * that a future `/academy/*` layout or page (Item 28+, out of scope
 * here) calls directly from a Server Component — the same pattern
 * every other permission check in this codebase already uses
 * (`hasPermission()` et al.), not a route-matched proxy file. It also
 * needs to return more than allow/deny: DESIGN.md's Past-Due-grace
 * state renders as full access *plus* a persistent banner
 * ("Past Due — 5 days remaining in grace period."), which is UI state
 * a layout renders, not something a redirect-only proxy can express
 * well.
 *
 * ---------------------------------------------------------------------
 * Status -> access-level mapping (PLAN.md Phase 1 §6 + DESIGN.md §11.1)
 * ---------------------------------------------------------------------
 * `academies.closed_at` set   -> blocked, "closed" — overrides every
 *                                 subscription status, checked first.
 * (no active membership)      -> blocked, "not_a_member".
 * (no subscription row at all)-> blocked, "no_subscription" (defensive;
 *                                 PLAN.md's onboarding flow shouldn't
 *                                 reach `/academy/*` without one).
 * `draft`                      -> blocked, "not_yet_active" (DESIGN.md:
 *                                 Draft = "none yet").
 * `trial`                      -> full.
 * `active`                     -> full.
 * `past_due`, within 7-day
 *   grace (computed)           -> full, with a persistent grace banner
 *                                 ("grace" level).
 * `past_due`, grace elapsed
 *   (computed as `suspended`)  -> blocked, "suspended".
 * `suspended`                  -> blocked, "suspended".
 * `expired`                    -> blocked, "expired".
 * `cancelled`                  -> blocked, "cancelled".
 *
 * The *effective* status always comes from
 * `computeLazySubscriptionStatus()` (lib/subscriptions/state-machine.ts,
 * Item 23), never the raw stored column — a stale `active`/`past_due`
 * row must be treated as whatever it's actually become by `now`. Per
 * that function's own doc comment, this gate is one of the two places
 * responsible for persisting the lazy flip back onto the row when the
 * effective status differs from what's stored ("the access gate (Item
 * 27) and every mutation (Items 26/30) call this to decide the
 * effective status for a read, and persist the result back onto the
 * row themselves when it differs from what's stored").
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies, academyMemberships, academySubscriptions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import {
  computeLazySubscriptionStatus,
  GRACE_PERIOD_DAYS,
  type SubscriptionStatus,
} from "@/lib/subscriptions/state-machine";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AcademyAccessLevel = "full" | "grace" | "blocked";

export type AcademyAccessDenyReason =
  | "not_authenticated"
  | "not_a_member"
  | "ambiguous_academy"
  | "closed"
  | "no_subscription"
  | "not_yet_active"
  | "suspended"
  | "expired"
  | "cancelled";

export interface AcademyAccessBlocked {
  level: "blocked";
  reason: AcademyAccessDenyReason;
  message: string;
}

export interface AcademyAccessAllowed {
  level: "full" | "grace";
  academyId: string;
  membershipRole: AcademyRole;
  subscriptionStatus: SubscriptionStatus;
  /** Only set at the "grace" level — the persistent banner copy (DESIGN.md §11.1). */
  message?: string;
  /** Only set at the "grace" level, when the subscription's `ends_at` is known. */
  graceDaysRemaining?: number;
}

export type AcademyAccessResult = AcademyAccessAllowed | AcademyAccessBlocked;

function blocked(reason: AcademyAccessDenyReason, message: string): AcademyAccessBlocked {
  return { level: "blocked", reason, message };
}

// Same generic-error convention as revokeSessionForUser (lib/auth/session.ts):
// "no membership row" and "membership belongs to someone else"/"academy
// doesn't exist" all produce the identical response, so a guessed academyId
// can't be used to distinguish "not a member" from "doesn't exist" (IDOR-class
// check, matching PLAN.md's cross-tenant-existence-never-leaks rule).
const NOT_A_MEMBER = blocked(
  "not_a_member",
  "You are not a member of this academy.",
);

function graceDaysRemaining(endsAt: Date | null, now: Date): number | null {
  if (!endsAt) return null;
  const graceDeadlineMs = endsAt.getTime() + GRACE_PERIOD_DAYS * DAY_MS;
  const msRemaining = graceDeadlineMs - now.getTime();
  return Math.max(0, Math.ceil(msRemaining / DAY_MS));
}

/**
 * Persists the lazy status flip (Trial->Expired, Active/PastDue->PastDue/
 * Suspended) back onto the row, per computeLazySubscriptionStatus's own
 * contract quoted above. The `status = before` clause in the WHERE guards
 * against a race with a concurrent mutation (e.g. renewSubscription)
 * already having moved the row on — if that happens this update simply
 * matches zero rows and is a no-op, which is correct: whatever that other
 * writer set is more current than this stale read.
 *
 * Audited (no actor — this is the one row-flip PLAN.md's table itself
 * marks as non-human-triggered, "computed at access-check time") so the
 * transition still leaves a trail, consistent with this codebase's
 * audit-everything convention elsewhere in Phase 1. PLAN.md doesn't
 * explicitly mandate an audit row for this specific lazy flip (its "every
 * transition writes an audit row" sentence reads as being about the
 * human-triggered rows in the same table), so this is a judgment call in
 * favor of leaving a trail rather than a documented requirement.
 */
async function persistLazyStatusFlip(
  subscriptionId: string,
  academyId: string,
  before: SubscriptionStatus,
  after: SubscriptionStatus,
): Promise<void> {
  const [updated] = await db
    .update(academySubscriptions)
    .set({ status: after })
    .where(
      and(
        eq(academySubscriptions.id, subscriptionId),
        eq(academySubscriptions.status, before),
      ),
    )
    .returning({ id: academySubscriptions.id });

  if (!updated) return;

  await recordAudit({
    academyId,
    action: "lazySubscriptionStatusFlip",
    entityType: "academy_subscription",
    entityId: subscriptionId,
    before: { status: before },
    after: { status: after },
    context: { trigger: "access-gate" },
  });
}

function resolveAccessForStatus(
  status: SubscriptionStatus,
  academyId: string,
  membershipRole: AcademyRole,
  endsAt: Date | null,
  now: Date,
): AcademyAccessResult {
  switch (status) {
    case "trial":
    case "active":
      return { level: "full", academyId, membershipRole, subscriptionStatus: status };

    case "past_due": {
      const daysRemaining = graceDaysRemaining(endsAt, now);
      const message =
        daysRemaining !== null
          ? `Past Due — ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining in grace period.`
          : "Past Due — your academy is in its grace period. Contact the platform owner to renew.";
      return {
        level: "grace",
        academyId,
        membershipRole,
        subscriptionStatus: status,
        graceDaysRemaining: daysRemaining ?? undefined,
        message,
      };
    }

    case "suspended":
      return blocked(
        "suspended",
        "Your academy's subscription is currently suspended. Contact the platform owner to reactivate.",
      );

    case "expired":
      return blocked(
        "expired",
        "Your academy's subscription has expired. Contact the platform owner to renew.",
      );

    case "cancelled":
      return blocked(
        "cancelled",
        "This academy's subscription has been cancelled. Contact the platform owner.",
      );

    case "draft":
    default:
      return blocked(
        "not_yet_active",
        "This academy's subscription has not been activated yet.",
      );
  }
}

/**
 * The gate itself. Resolves the caller's active academy membership,
 * applies closure (overrides everything), then the effective subscription
 * status, and returns the access level a future `/academy/*` layout should
 * render.
 *
 * `academyId` is optional because no `/academy/*` route in PLAN.md's
 * route list carries an `[academyId]` segment (unlike `/platform/
 * academies/[academyId]`) — the academy is meant to be implied by the
 * signed-in user's own membership. That only resolves unambiguously when
 * the user has exactly one active membership. PLAN.md/DESIGN.md never
 * discuss a user belonging to more than one academy (the identity model
 * bullet only distinguishes platform vs. academy membership, and every
 * onboarding path in Phase 1 creates exactly one membership row per
 * user), but the schema's unique constraint is `(user_id, academy_id)`,
 * not `(user_id)` — it does not itself forbid a second membership row for
 * a different academy. Rather than silently guessing (first row by
 * created_at, say) when that happens, this returns a distinct
 * "ambiguous_academy" block so a future caller can require an explicit
 * academyId instead of risking showing the wrong academy's data. This is
 * a genuine PLAN.md gap, flagged rather than resolved unilaterally.
 */
export async function checkAcademyAccess(
  userId: string,
  academyId?: string,
  now: Date = new Date(),
): Promise<AcademyAccessResult> {
  const membershipWhere = academyId
    ? and(
        eq(academyMemberships.userId, userId),
        eq(academyMemberships.academyId, academyId),
        eq(academyMemberships.status, "active"),
      )
    : and(eq(academyMemberships.userId, userId), eq(academyMemberships.status, "active"));

  const memberships = await db
    .select({
      academyId: academyMemberships.academyId,
      role: academyMemberships.role,
    })
    .from(academyMemberships)
    .where(membershipWhere);

  if (memberships.length === 0) {
    return NOT_A_MEMBER;
  }

  let membership: { academyId: string; role: AcademyRole };
  if (academyId) {
    membership = memberships[0];
  } else if (memberships.length === 1) {
    membership = memberships[0];
  } else {
    return blocked(
      "ambiguous_academy",
      "You belong to more than one academy — specify which one to access.",
    );
  }

  const resolvedAcademyId = membership.academyId;

  const [academy] = await db
    .select({ closedAt: academies.closedAt })
    .from(academies)
    .where(eq(academies.id, resolvedAcademyId))
    .limit(1);

  // Defensive: academyId is a real FK on academy_memberships, so this
  // should be unreachable, but never trust a lookup to short-circuit
  // authorization decisions.
  if (!academy) {
    return NOT_A_MEMBER;
  }

  // Closure overrides every subscription state, per PLAN.md Phase 1 §6
  // ("closeAcademy is a one-way, permanent action... every `/academy/*`
  // route becomes inaccessible to academy users") and DESIGN.md §11.1
  // ("overrides every other state") — checked before the subscription is
  // even loaded.
  if (academy.closedAt) {
    return blocked(
      "closed",
      "This academy has been permanently closed. Historical data is retained as read-only.",
    );
  }

  // "Current" subscription = the most recently started row for this
  // academy. There is no explicit "current"/"is_active" flag on
  // academy_subscriptions and no created_at column on that table (see
  // schema.ts's comment on it) — PLAN.md's Cancelled row is the only
  // documented case where an academy can accumulate more than one
  // subscription row over time ("resuming service requires a NEW
  // academy_subscriptions row"), so ordering by starts_at descending picks
  // the newest one, which is always the one created most recently by
  // createAcademySubscription. Judgment call: PLAN.md never states this
  // ordering rule explicitly because it never needed to name a "current
  // subscription" lookup before this item.
  const [subscription] = await db
    .select({
      id: academySubscriptions.id,
      status: academySubscriptions.status,
      trialEndsAt: academySubscriptions.trialEndsAt,
      endsAt: academySubscriptions.endsAt,
    })
    .from(academySubscriptions)
    .where(eq(academySubscriptions.academyId, resolvedAcademyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  if (!subscription) {
    return blocked(
      "no_subscription",
      "This academy has no subscription set up yet. Contact the platform owner.",
    );
  }

  const effectiveStatus = computeLazySubscriptionStatus(
    {
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      endsAt: subscription.endsAt,
    },
    now,
  );

  if (effectiveStatus !== subscription.status) {
    await persistLazyStatusFlip(
      subscription.id,
      resolvedAcademyId,
      subscription.status,
      effectiveStatus,
    );
  }

  return resolveAccessForStatus(
    effectiveStatus,
    resolvedAcademyId,
    membership.role,
    subscription.endsAt,
    now,
  );
}

/**
 * Convenience wrapper for the common call site: a future `/academy/*`
 * layout/page that already resolved `getAuthContext()`. Returns the
 * "not_authenticated" block for a null context (no valid session) rather
 * than making every caller re-check that first.
 */
export async function checkAcademyAccessForContext(
  authContext: AuthContext | null,
  academyId?: string,
): Promise<AcademyAccessResult> {
  if (!authContext) {
    return blocked("not_authenticated", "You must be signed in to access this academy.");
  }
  return checkAcademyAccess(authContext.userId, academyId);
}
