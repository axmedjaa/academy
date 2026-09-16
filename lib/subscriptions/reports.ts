import { and, asc, eq, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  subscriptionPayments,
  subscriptionPlans,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md line 807 / Phase 1 Item 32b: "getPlatformReports (revenue
 * breakdowns) + /platform/reports". DESIGN.md's route table (verbatim):
 * "/platform/reports | — (custom) | Revenue view with group-by (Month/Plan/
 * Academy/Method) and an explicit visual split between Collected (verified
 * payments) and Expected/Pending (upcoming renewals not yet paid) revenue;
 * active-academy trend; expiring-subscriptions list. Export button. Entirely
 * absent for platform_admin unless individually granted (and the revenue
 * sub-view specifically is never grantable — §5)."
 *
 * -----------------------------------------------------------------------
 * The two-tier capability split (both read from lib/auth/permissions.ts and
 * lib/platform-staff/capabilities.ts — neither file is modified here)
 * -----------------------------------------------------------------------
 * - REPORTS_VIEW_CAPABILITY ("getPlatformReports") is in GRANTABLE_CAPABILITIES
 *   — it gates the page as a whole (a platform_admin can be granted it) but,
 *   per DESIGN.md, only ever exposes the *non-revenue* sections: the
 *   active-academy trend and the expiring-subscriptions list.
 * - REVENUE_VIEW_CAPABILITY ("platform.revenue.view") is in
 *   UNGRANTABLE_CAPABILITIES — hasPermission() can only ever return true for
 *   it when the actor is platform_owner, regardless of any grant row that
 *   might exist. getPlatformReports() below checks it independently of the
 *   outer capability and sets `revenue: null` (not merely hidden/greyed out)
 *   whenever it's false, so the page/UI layer has nothing to accidentally
 *   render for an ungranted platform_admin — there is no revenue payload to
 *   leak in the first place.
 *
 * -----------------------------------------------------------------------
 * Judgment call — "Expected/Pending" revenue derivation
 * -----------------------------------------------------------------------
 * Neither PLAN.md nor DESIGN.md defines an exact formula for "upcoming
 * renewals not yet paid" — there is no expected_amount column anywhere.
 * This is my own derivation, not a literal spec: for every
 * academySubscriptions row that is not "cancelled" (a terminal state with no
 * future renewal expected) and has a known endsAt, the expected renewal
 * amount is that subscription's *current* plan's priceAmountCents — the
 * exact amount renewSubscription (lib/subscriptions/renew*.ts, a different
 * item, not touched here) would charge, since its date math is
 * "max(current ends_at, now) + plan.billing_period" for "plan.priceAmountCents"
 * (Phase 1 §6). Draft/Trial subscriptions are naturally excluded because
 * they have no endsAt yet (see lib/db/schema.ts's comment on
 * academySubscriptions.endsAt).
 *
 * -----------------------------------------------------------------------
 * Judgment call — "active-academy trend"
 * -----------------------------------------------------------------------
 * There is no historical snapshot table recording academy/subscription
 * counts over time, so a literal point-in-time trend can't be reconstructed.
 * The closest derivable signal from current data is academySubscriptions'
 * own `activatedAt` timestamp on every row whose status is currently
 * "active": bucketing those by month gives a monthly "newly activated"
 * count, and a running total across months gives a cumulative
 * "how many of today's active academies became active by this point"
 * growth curve. This is NOT a true historical trend (an academy that was
 * active in March and got suspended in April would not show up in either
 * month's count once its status is no longer "active" today) — documented
 * here as a deliberate simplification given the absence of snapshot data.
 *
 * -----------------------------------------------------------------------
 * Judgment call — Export button
 * -----------------------------------------------------------------------
 * PLAN.md's Cross-Cutting Decisions never describe a file-generation/
 * download mechanism for this phase. `revenueBreakdownToCsv` below is a
 * pure, dependency-free formatter of data already computed by
 * getRevenueBreakdown — no new storage/file infrastructure. The
 * "use server" wrapper in reports-actions.ts hands the resulting CSV string
 * back to the client, which triggers a browser download via a Blob URL
 * (app/platform/reports/reports-manager.tsx) — no new route or file storage.
 */
export const REPORTS_VIEW_CAPABILITY = "getPlatformReports";
export const REVENUE_VIEW_CAPABILITY = "platform.revenue.view";

export type RevenueGroupBy = "month" | "plan" | "academy" | "method";

export const REVENUE_GROUP_BY_OPTIONS: readonly RevenueGroupBy[] = [
  "month",
  "plan",
  "academy",
  "method",
] as const;

export interface RevenueBreakdownRow {
  groupKey: string;
  label: string;
  collectedCents: number;
  expectedCents: number;
}

export interface RevenueBreakdownResult {
  groupBy: RevenueGroupBy;
  rows: RevenueBreakdownRow[];
  totals: { collectedCents: number; expectedCents: number };
}

export interface ActiveAcademyTrendPoint {
  /** "YYYY-MM", UTC. */
  month: string;
  newlyActivated: number;
  cumulativeActive: number;
}

export interface ExpiringSubscriptionRow {
  subscriptionId: string;
  academyId: string;
  academyName: string;
  planName: string;
  status: string;
  endsAt: Date;
  /** Negative when endsAt is already in the past (overdue, not yet renewed). */
  daysUntilExpiry: number;
}

export interface PlatformReportsResult {
  activeAcademyTrend: ActiveAcademyTrendPoint[];
  expiringSubscriptions: ExpiringSubscriptionRow[];
  /**
   * null whenever the actor lacks REVENUE_VIEW_CAPABILITY — the section is
   * meant to be entirely absent, not merely hidden, so there is no payload
   * for the UI layer to accidentally render.
   */
  revenue: RevenueBreakdownResult | null;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Trailing `count` month keys (chronological), ending with the current month. */
function trailingMonthKeys(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(monthKey(d));
  }
  return keys;
}

/**
 * PLAN.md/DESIGN.md's "active-academy trend" — see the module-level comment
 * above for the derivation and its limits. `trendMonths` defaults to a
 * trailing 12-month window; the cumulative count at each month reflects the
 * academy's full activation history up to and including that month, not
 * just activations within the displayed window.
 */
export async function getActiveAcademyTrend(
  trendMonths = 12,
): Promise<ActiveAcademyTrendPoint[]> {
  const rows = await db
    .select({
      academyId: academySubscriptions.academyId,
      activatedAt: academySubscriptions.activatedAt,
    })
    .from(academySubscriptions)
    .where(
      and(
        eq(academySubscriptions.status, "active"),
        isNotNull(academySubscriptions.activatedAt),
      ),
    );

  // Dedup to one activation date per academy (keep the latest), guarding
  // against an academy somehow carrying more than one currently-"active" row.
  const latestByAcademy = new Map<string, Date>();
  for (const row of rows) {
    if (!row.activatedAt) continue;
    const existing = latestByAcademy.get(row.academyId);
    if (!existing || row.activatedAt > existing) {
      latestByAcademy.set(row.academyId, row.activatedAt);
    }
  }
  const activationDates = [...latestByAcademy.values()];
  const activationMonthKeys = activationDates.map(monthKey);

  return trailingMonthKeys(trendMonths).map((key) => ({
    month: key,
    newlyActivated: activationMonthKeys.filter((k) => k === key).length,
    // "YYYY-MM" strings compare lexicographically the same as chronologically.
    cumulativeActive: activationMonthKeys.filter((k) => k <= key).length,
  }));
}

/**
 * PLAN.md/DESIGN.md's "expiring-subscriptions list". Includes every
 * non-cancelled subscription with a known endsAt on or before `withinDays`
 * from now — deliberately no lower bound, so a subscription whose endsAt has
 * already passed (overdue, not yet renewed) is included too, with a
 * negative daysUntilExpiry, since that is exactly the kind of row a platform
 * operator needs to see on an "expiring" list. Sorted soonest/most-overdue
 * first.
 */
export async function getExpiringSubscriptions(
  withinDays = 30,
): Promise<ExpiringSubscriptionRow[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      subscriptionId: academySubscriptions.id,
      academyId: academySubscriptions.academyId,
      academyName: academies.name,
      planName: subscriptionPlans.name,
      status: academySubscriptions.status,
      endsAt: academySubscriptions.endsAt,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
    .where(
      and(
        ne(academySubscriptions.status, "cancelled"),
        isNotNull(academySubscriptions.endsAt),
        lte(academySubscriptions.endsAt, windowEnd),
      ),
    )
    .orderBy(asc(academySubscriptions.endsAt));

  return rows.map((row) => {
    const endsAt = row.endsAt as Date;
    return {
      ...row,
      endsAt,
      daysUntilExpiry: Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    };
  });
}

interface PaymentGroupSource {
  receivedAt: Date;
  paymentMethod: string;
  academyId: string;
  academyName: string;
  planId: string;
  planName: string;
}

interface SubscriptionGroupSource {
  endsAt: Date;
  academyId: string;
  academyName: string;
  planId: string;
  planName: string;
}

const NOT_YET_PAID_KEY = "__not_yet_paid__";
const NOT_YET_PAID_LABEL = "Not yet paid (method unknown)";

function paymentGroupKeyLabel(
  dimension: RevenueGroupBy,
  row: PaymentGroupSource,
): { key: string; label: string } {
  switch (dimension) {
    case "month": {
      const key = monthKey(row.receivedAt);
      return { key, label: key };
    }
    case "plan":
      return { key: row.planId, label: row.planName };
    case "academy":
      return { key: row.academyId, label: row.academyName };
    case "method":
      return { key: row.paymentMethod, label: row.paymentMethod };
  }
}

// Expected/pending revenue has no payment method yet (it hasn't been paid),
// so the "method" dimension can't attribute it to a real method — every
// expected-revenue row collapses into one synthetic "not yet paid" bucket
// for that dimension only, kept separate from the real per-method collected
// rows (documented in the module-level comment above).
function subscriptionGroupKeyLabel(
  dimension: RevenueGroupBy,
  row: SubscriptionGroupSource,
): { key: string; label: string } {
  switch (dimension) {
    case "month": {
      const key = monthKey(row.endsAt);
      return { key, label: key };
    }
    case "plan":
      return { key: row.planId, label: row.planName };
    case "academy":
      return { key: row.academyId, label: row.academyName };
    case "method":
      return { key: NOT_YET_PAID_KEY, label: NOT_YET_PAID_LABEL };
  }
}

/**
 * The revenue breakdown itself — Collected (sum of verified
 * subscription_payments.amount_cents) vs. Expected/Pending (see the
 * module-level derivation comment), grouped by the requested dimension.
 * Callers must have already checked hasPermission(context,
 * "platform.revenue.view") themselves (getPlatformReports below does this) —
 * this function performs no authorization of its own, matching this
 * codebase's list*()/get*Overview() convention (e.g.
 * lib/subscriptions/usage.ts's listAcademyUsageOverview).
 */
export async function getRevenueBreakdown(
  groupBy: RevenueGroupBy = "month",
): Promise<RevenueBreakdownResult> {
  const [paymentRows, subscriptionRows] = await Promise.all([
    db
      .select({
        amountCents: subscriptionPayments.amountCents,
        receivedAt: subscriptionPayments.receivedAt,
        paymentMethod: subscriptionPayments.paymentMethod,
        academyId: subscriptionPayments.academyId,
        academyName: academies.name,
        planId: academySubscriptions.planId,
        planName: subscriptionPlans.name,
      })
      .from(subscriptionPayments)
      .innerJoin(
        academySubscriptions,
        eq(academySubscriptions.id, subscriptionPayments.subscriptionId),
      )
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .where(eq(subscriptionPayments.status, "verified")),

    db
      .select({
        academyId: academySubscriptions.academyId,
        academyName: academies.name,
        planId: academySubscriptions.planId,
        planName: subscriptionPlans.name,
        priceAmountCents: subscriptionPlans.priceAmountCents,
        endsAt: academySubscriptions.endsAt,
      })
      .from(academySubscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
      .where(
        and(
          ne(academySubscriptions.status, "cancelled"),
          isNotNull(academySubscriptions.endsAt),
        ),
      ),
  ]);

  const groups = new Map<string, { label: string; collectedCents: number; expectedCents: number }>();

  for (const row of paymentRows) {
    const { key, label } = paymentGroupKeyLabel(groupBy, row);
    const entry = groups.get(key) ?? { label, collectedCents: 0, expectedCents: 0 };
    entry.collectedCents += row.amountCents;
    groups.set(key, entry);
  }

  for (const row of subscriptionRows) {
    const { key, label } = subscriptionGroupKeyLabel(groupBy, {
      ...row,
      endsAt: row.endsAt as Date,
    });
    const entry = groups.get(key) ?? { label, collectedCents: 0, expectedCents: 0 };
    entry.expectedCents += row.priceAmountCents;
    groups.set(key, entry);
  }

  const rows: RevenueBreakdownRow[] = [...groups.entries()]
    .map(([key, value]) => ({ groupKey: key, ...value }))
    .sort((a, b) => a.groupKey.localeCompare(b.groupKey));

  const totals = rows.reduce(
    (acc, row) => ({
      collectedCents: acc.collectedCents + row.collectedCents,
      expectedCents: acc.expectedCents + row.expectedCents,
    }),
    { collectedCents: 0, expectedCents: 0 },
  );

  return { groupBy, rows, totals };
}

export interface GetPlatformReportsParams {
  groupBy?: RevenueGroupBy;
  trendMonths?: number;
  expiringWithinDays?: number;
}

export interface PlatformReportsError {
  code: "forbidden";
  message: string;
}

export type GetPlatformReportsOutcome =
  | { ok: true; data: PlatformReportsResult }
  | { ok: false; error: PlatformReportsError };

/**
 * The `getPlatformReports` server action's underlying logic (PLAN.md's own
 * name for this — "getPlatformReports (with breakdown params)"). Takes the
 * actor's AuthContext directly (like lib/subscriptions/usage.ts's
 * recalculateUsage) rather than assuming the caller already gated, because
 * the two-tier capability split is itself the core logic this function is
 * responsible for enforcing:
 *
 * 1. REPORTS_VIEW_CAPABILITY gates the whole call — a platform_admin
 *    without this grant gets `{ok:false}` and no data at all.
 * 2. REVENUE_VIEW_CAPABILITY is then checked independently; when false
 *    (always true for any platform_admin, since it's ungrantable),
 *    `revenue` comes back null rather than merely omitted-in-the-UI.
 */
export async function getPlatformReports(
  actorContext: AuthContext,
  params: GetPlatformReportsParams = {},
): Promise<GetPlatformReportsOutcome> {
  const allowed = await hasPermission(actorContext, REPORTS_VIEW_CAPABILITY);
  if (!allowed) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "You don't have permission to view platform reports.",
      },
    };
  }

  const groupBy = params.groupBy ?? "month";
  const trendMonths = params.trendMonths ?? 12;
  const expiringWithinDays = params.expiringWithinDays ?? 30;

  const [activeAcademyTrend, expiringSubscriptions, canViewRevenue] = await Promise.all([
    getActiveAcademyTrend(trendMonths),
    getExpiringSubscriptions(expiringWithinDays),
    hasPermission(actorContext, REVENUE_VIEW_CAPABILITY),
  ]);

  const revenue = canViewRevenue ? await getRevenueBreakdown(groupBy) : null;

  return { ok: true, data: { activeAcademyTrend, expiringSubscriptions, revenue } };
}

/**
 * Pure CSV formatter for the Export button (see the module-level comment
 * above for why this is the export mechanism, judgment call and all).
 * Cents are rendered as fixed-point decimal (no currency symbol, since
 * subscription_payments.currency/subscription_plans.currency are free-text
 * per-row fields this codebase never reconciles across a mixed-currency
 * deployment — same simplification already implicit everywhere else
 * amount_cents is summed in this codebase, e.g. lib/subscriptions/usage.ts).
 */
export function revenueBreakdownToCsv(result: RevenueBreakdownResult): string {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const header = ["Group", "Collected", "Expected"].join(",");
  const lines = result.rows.map((row) =>
    [escape(row.label), (row.collectedCents / 100).toFixed(2), (row.expectedCents / 100).toFixed(2)].join(","),
  );
  const totalsLine = [
    "Total",
    (result.totals.collectedCents / 100).toFixed(2),
    (result.totals.expectedCents / 100).toFixed(2),
  ].join(",");

  return [header, ...lines, totalsLine].join("\n");
}
