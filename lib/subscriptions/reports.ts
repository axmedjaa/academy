import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { toCsv } from "@/lib/export/csv";
import { exportLabel, exportMonth } from "@/lib/export/readable";
import {
  academies,
  academySubscriptions,
  staffProfiles,
  students,
  subscriptionPayments,
  subscriptionPlans,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { computeLazySubscriptionStatus, GRACE_PERIOD_DAYS, type SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { getAcademyStatusCounts, type AcademyStatusCounts } from "@/lib/academies/approve";
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

export type RevenueGroupBy = "month" | "plan" | "academy" | "method" | "billing_period";

export const REVENUE_GROUP_BY_OPTIONS: readonly RevenueGroupBy[] = [
  "month",
  "plan",
  "academy",
  "method",
  "billing_period",
] as const;

/** Owner-only academy lifecycle counts (approved / pending / closed) and
 * registrations — the same capability the platform dashboard already uses
 * to show its "Total academies" figure, so the reports page never shows an
 * academy total to an account the dashboard would hide it from. */
const ACADEMY_LIFECYCLE_CAPABILITY = "approveAcademy";

export interface RevenueBreakdownRow {
  groupKey: string;
  label: string;
  collectedCents: number;
  expectedCents: number;
}

export interface RevenueBreakdownResult {
  groupBy: RevenueGroupBy;
  /** Lower bound (inclusive) applied to both sides, or null for all time:
   * collected by `received_at`, expected by the term's `ends_at`. */
  since: Date | null;
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
  /** Effective status (state machine, lazy): "active", "trial" or "past_due". */
  status: "active" | "trial" | "past_due";
  /** When access ends: `trial_ends_at` for a trial, otherwise `ends_at`. */
  endsAt: Date;
  /** Negative when endsAt is already in the past (Past Due, inside the grace period). */
  daysUntilExpiry: number;
}

export interface ExpiringSubscriptions {
  /** Soonest/most-overdue first, capped at `EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT`. */
  rows: ExpiringSubscriptionRow[];
  /** Every matching subscription, before the cap. */
  totalCount: number;
}

export interface AcademiesByPlanRow {
  planId: string;
  planName: string;
  academyCount: number;
}

/**
 * Open academies counted by the *effective* status (state machine, lazy) of
 * their current subscription — the same "latest starts_at wins" row
 * getAcademiesByPlan uses. `none` counts open academies with no
 * subscription row at all.
 */
export interface SubscriptionStatusCounts {
  openAcademies: number;
  byStatus: Record<SubscriptionStatus | "none", number>;
}

/** Live platform-wide totals across open academies, counted exactly the
 * way lib/subscriptions/usage.ts's per-academy counters count them
 * (status = 'active'), never read from cached usage snapshots. */
export interface PlatformPopulationTotals {
  activeStudents: number;
  activeStaff: number;
}

export interface AcademyRegistrationPoint {
  /** "YYYY-MM", UTC. */
  month: string;
  registered: number;
}

export interface PlatformReportsResult {
  /** Months covered by the trend series (the page's date range). */
  trendMonths: number;
  /** Lower bound applied to revenue, or null for all time. */
  revenueSince: Date | null;
  activeAcademyTrend: ActiveAcademyTrendPoint[];
  expiringSubscriptions: ExpiringSubscriptions;
  /** Open (not closed) academies counted by their current plan. */
  academiesByPlan: AcademiesByPlanRow[];
  subscriptionStatus: SubscriptionStatusCounts;
  population: PlatformPopulationTotals;
  /** null unless the actor holds ACADEMY_LIFECYCLE_CAPABILITY (owner only). */
  academyLifecycle: AcademyStatusCounts | null;
  /** Academies registered per month over the trend window; null under the
   * same condition as `academyLifecycle`. */
  academyRegistrations: AcademyRegistrationPoint[] | null;
  /** Monthly collected/expected over the range; null whenever `revenue` is. */
  revenueTrend: RevenueBreakdownResult | null;
  /** Revenue per plan over the range; null whenever `revenue` is. */
  revenueByPlan: RevenueBreakdownResult | null;
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
  // Performance plan P7: one activation month per academy (its latest
  // activation among currently-"active" rows, same dedup as before),
  // counted per UTC month by the database instead of returning every row.
  const latestByAcademy = db
    .select({ activatedAt: sql<Date>`max(${academySubscriptions.activatedAt})`.as("activated_at") })
    .from(academySubscriptions)
    .where(
      and(
        eq(academySubscriptions.status, "active"),
        isNotNull(academySubscriptions.activatedAt),
      ),
    )
    .groupBy(academySubscriptions.academyId)
    .as("latest_activation");
  const monthRows = await db
    .select({
      month: sql<string>`to_char(${latestByAcademy.activatedAt} at time zone 'UTC', 'YYYY-MM')`,
      academies: sql<number>`count(*)::int`,
    })
    .from(latestByAcademy)
    .groupBy(sql`1`);

  return trailingMonthKeys(trendMonths).map((key) => ({
    month: key,
    newlyActivated: monthRows.filter((row) => row.month === key).reduce((n, row) => n + row.academies, 0),
    // "YYYY-MM" strings compare lexicographically the same as chronologically.
    cumulativeActive: monthRows.filter((row) => row.month <= key).reduce((n, row) => n + row.academies, 0),
  }));
}

/**
 * Open academies (closed_at is null) counted by the plan of their current
 * subscription — the most recently started row, the same "latest starts_at
 * wins" convention as lib/academies/approve.ts. Academies with no
 * subscription row are left out. Sorted by count, largest first.
 */
export async function getAcademiesByPlan(): Promise<AcademiesByPlanRow[]> {
  // Performance plan P7: "first row per academy by starts_at desc" is
  // DISTINCT ON in SQL, and the per-plan count is a GROUP BY — the database
  // returns one row per plan instead of every subscription.
  const current = db
    .selectDistinctOn([academySubscriptions.academyId], {
      academyId: academySubscriptions.academyId,
      planId: sql<string>`${subscriptionPlans.id}::text`.as("plan_id"),
      planName: sql<string>`${subscriptionPlans.name}`.as("plan_name"),
    })
    .from(academySubscriptions)
    .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
    .where(isNull(academies.closedAt))
    .orderBy(academySubscriptions.academyId, desc(academySubscriptions.startsAt))
    .as("current_subscription");
  const rows = await db
    .select({ planId: current.planId, planName: current.planName, academyCount: sql<number>`count(*)::int` })
    .from(current)
    .groupBy(current.planId, current.planName);

  return rows
    .map((row) => ({ planId: row.planId, planName: row.planName, academyCount: row.academyCount }))
    .sort((a, b) => b.academyCount - a.academyCount || a.planName.localeCompare(b.planName));
}

/**
 * Open academies by the effective status of their current subscription
 * (see `SubscriptionStatusCounts`). One row per open academy comes back
 * (DISTINCT ON, the same current-subscription rule as getAcademiesByPlan)
 * and is classified with the state machine's own
 * `computeLazySubscriptionStatus`, never the stored status alone: a stored
 * "active" row past its grace period counts as Suspended here, exactly as
 * the access gate treats it.
 */
export async function getSubscriptionStatusCounts(now: Date = new Date()): Promise<SubscriptionStatusCounts> {
  const [currentRows, [{ value: openAcademies }]] = await Promise.all([
    db
      .selectDistinctOn([academySubscriptions.academyId], {
        status: academySubscriptions.status,
        trialEndsAt: academySubscriptions.trialEndsAt,
        endsAt: academySubscriptions.endsAt,
      })
      .from(academySubscriptions)
      .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
      .where(isNull(academies.closedAt))
      .orderBy(academySubscriptions.academyId, desc(academySubscriptions.startsAt)),
    db.select({ value: count() }).from(academies).where(isNull(academies.closedAt)),
  ]);

  const byStatus: SubscriptionStatusCounts["byStatus"] = {
    draft: 0,
    trial: 0,
    active: 0,
    past_due: 0,
    suspended: 0,
    expired: 0,
    cancelled: 0,
    none: 0,
  };
  for (const row of currentRows) {
    byStatus[computeLazySubscriptionStatus(row, now)] += 1;
  }
  const open = Number(openAcademies);
  byStatus.none = Math.max(0, open - currentRows.length);
  return { openAcademies: open, byStatus };
}

/** See `PlatformPopulationTotals`. Two COUNT(*)s, open academies only. */
export async function getPlatformPopulationTotals(): Promise<PlatformPopulationTotals> {
  const [[studentRow], [staffRow]] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(students)
      .innerJoin(academies, eq(academies.id, students.academyId))
      .where(and(eq(students.status, "active"), isNull(academies.closedAt))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(staffProfiles)
      .innerJoin(academies, eq(academies.id, staffProfiles.academyId))
      .where(and(eq(staffProfiles.status, "active"), isNull(academies.closedAt))),
  ]);
  return { activeStudents: studentRow?.value ?? 0, activeStaff: staffRow?.value ?? 0 };
}

/** Academies registered (academies.created_at, UTC month) in each month of
 * the trailing window: every academy, whatever its later status. */
export async function getAcademyRegistrations(trendMonths = 12): Promise<AcademyRegistrationPoint[]> {
  const keys = trailingMonthKeys(trendMonths);
  const monthExpr = sql<string>`to_char(${academies.createdAt} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await db
    .select({ month: monthExpr, registered: sql<number>`count(*)::int` })
    .from(academies)
    .where(gte(academies.createdAt, trailingWindowStart(trendMonths)))
    .groupBy(monthExpr);
  const byMonth = new Map(rows.map((row) => [row.month, row.registered]));
  return keys.map((key) => ({ month: key, registered: byMonth.get(key) ?? 0 }));
}

/** First instant of the UTC month `months - 1` months before this one: the
 * start of a trailing `months`-month window that includes the current month
 * (the same months `trailingMonthKeys(months)` lists). */
export function trailingWindowStart(months: number, now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

/** Default cap on `getExpiringSubscriptions`'s row count — the date window
 * alone (`withinDays`) bounds this query correctly, but with no row cap a
 * platform with many academies expiring in the same window renders every
 * one of them in a single unpaginated table (this page has no pagination
 * control today). Soonest/most-overdue rows are kept — see the `orderBy`
 * below — so a cap never hides the most urgent ones. */
export const EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PLAN.md/DESIGN.md's "expiring-subscriptions list" (design P01/P09
 * `expRows`: effective status Active, Trial or Past Due, ending within
 * `withinDays`, soonest first). Classification uses the state machine's own
 * `computeLazySubscriptionStatus`, never the stored status alone: a stored
 * "active" row whose 7-day grace period has run out is effectively
 * Suspended and is not "expiring", and a stored "suspended", "expired",
 * "draft" or "cancelled" row never is. Past Due rows (ended, still inside
 * the grace period) are kept with a negative `daysUntilExpiry` so they
 * read as overdue. A trial ends at `trial_ends_at`. One row per
 * subscription (subscriptions are the FROM table; the joins are to-one).
 */
export async function getExpiringSubscriptions(
  withinDays = 30,
  limit = EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT,
): Promise<ExpiringSubscriptions> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + withinDays * DAY_MS);
  const graceStart = new Date(now.getTime() - GRACE_PERIOD_DAYS * DAY_MS);
  const accessEnd = sql<Date>`case when ${academySubscriptions.status} = 'trial' then ${academySubscriptions.trialEndsAt} else ${academySubscriptions.endsAt} end`;

  // Mirrors computeLazySubscriptionStatus: active/past_due rows count from
  // the start of the grace period, trial rows only until they lapse.
  const where = or(
    and(
      inArray(academySubscriptions.status, ["active", "past_due"]),
      gte(academySubscriptions.endsAt, graceStart),
      lte(academySubscriptions.endsAt, windowEnd),
    ),
    and(
      eq(academySubscriptions.status, "trial"),
      gte(academySubscriptions.trialEndsAt, now),
      lte(academySubscriptions.trialEndsAt, windowEnd),
    ),
  );

  const [rows, [{ value: totalCount }]] = await Promise.all([
    db
      .select({
        subscriptionId: academySubscriptions.id,
        academyId: academySubscriptions.academyId,
        academyName: academies.name,
        planName: subscriptionPlans.name,
        status: academySubscriptions.status,
        endsAt: academySubscriptions.endsAt,
        trialEndsAt: academySubscriptions.trialEndsAt,
      })
      .from(academySubscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
      .where(where)
      .orderBy(asc(accessEnd), asc(academySubscriptions.id))
      .limit(limit),
    db.select({ value: count() }).from(academySubscriptions).where(where),
  ]);

  const classified = rows.flatMap((row) => {
    const effective = computeLazySubscriptionStatus(
      { status: row.status, trialEndsAt: row.trialEndsAt, endsAt: row.endsAt },
      now,
    );
    if (effective !== "active" && effective !== "trial" && effective !== "past_due") return [];
    const endsAt = (effective === "trial" ? row.trialEndsAt : row.endsAt) as Date;
    const msLeft = endsAt.getTime() - now.getTime();
    return [
      {
        subscriptionId: row.subscriptionId,
        academyId: row.academyId,
        academyName: row.academyName,
        planName: row.planName,
        status: effective,
        endsAt,
        // Whole days left, rounded up ("1 day left" until it ends); whole
        // days overdue, rounded down ("0" never reads as overdue).
        daysUntilExpiry: msLeft >= 0 ? Math.ceil(msLeft / DAY_MS) : -Math.max(1, Math.floor(-msLeft / DAY_MS)),
      },
    ];
  });

  return { rows: classified, totalCount: Number(totalCount) };
}

const NOT_YET_PAID_KEY = "__not_yet_paid__";
const NOT_YET_PAID_LABEL = "Not yet paid (method unknown)";

/** Group key and label per dimension — months are UTC "YYYY-MM", the same
 * buckets `monthKey` produces. */
function paymentGroupColumns(dimension: RevenueGroupBy): { key: SQL<string>; label: SQL<string> } {
  switch (dimension) {
    case "month": {
      const month = sql<string>`to_char(${subscriptionPayments.receivedAt} at time zone 'UTC', 'YYYY-MM')`;
      return { key: month, label: month };
    }
    case "plan":
      return { key: sql<string>`${academySubscriptions.planId}::text`, label: sql<string>`${subscriptionPlans.name}` };
    case "academy":
      return { key: sql<string>`${subscriptionPayments.academyId}::text`, label: sql<string>`${academies.name}` };
    case "method":
      return {
        key: sql<string>`${subscriptionPayments.paymentMethod}::text`,
        label: sql<string>`${subscriptionPayments.paymentMethod}::text`,
      };
    case "billing_period":
      return { key: sql<string>`${subscriptionPlans.billingPeriod}::text`, label: sql<string>`${subscriptionPlans.billingPeriod}::text` };
  }
}

function subscriptionGroupColumns(dimension: RevenueGroupBy): { key: SQL<string>; label: SQL<string> } {
  switch (dimension) {
    case "month": {
      const month = sql<string>`to_char(${academySubscriptions.endsAt} at time zone 'UTC', 'YYYY-MM')`;
      return { key: month, label: month };
    }
    case "plan":
      return { key: sql<string>`${academySubscriptions.planId}::text`, label: sql<string>`${subscriptionPlans.name}` };
    case "academy":
      return { key: sql<string>`${academySubscriptions.academyId}::text`, label: sql<string>`${academies.name}` };
    case "method":
      return { key: sql<string>`${NOT_YET_PAID_KEY}::text`, label: sql<string>`${NOT_YET_PAID_LABEL}::text` };
    case "billing_period":
      return { key: sql<string>`${subscriptionPlans.billingPeriod}::text`, label: sql<string>`${subscriptionPlans.billingPeriod}::text` };
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
  { since = null }: { since?: Date | null } = {},
): Promise<RevenueBreakdownResult> {
  // Performance plan P7: the database groups and sums per dimension and
  // returns one row per group, instead of every verified payment and every
  // non-cancelled subscription being summed here. Same filters, same joins,
  // same keys and labels; groups are merged below exactly as before
  // (payments first, then subscriptions).
  const paymentCols = paymentGroupColumns(groupBy);
  const subscriptionCols = subscriptionGroupColumns(groupBy);
  const [paymentRows, subscriptionRows] = await Promise.all([
    db
      .select({
        key: paymentCols.key,
        label: paymentCols.label,
        cents: sql<string>`coalesce(sum(${subscriptionPayments.amountCents}), 0)::bigint`,
      })
      .from(subscriptionPayments)
      .innerJoin(
        academySubscriptions,
        eq(academySubscriptions.id, subscriptionPayments.subscriptionId),
      )
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .where(
        and(
          eq(subscriptionPayments.status, "verified"),
          since ? gte(subscriptionPayments.receivedAt, since) : undefined,
        ),
      )
      .groupBy(paymentCols.key, paymentCols.label),

    db
      .select({
        key: subscriptionCols.key,
        label: subscriptionCols.label,
        cents: sql<string>`coalesce(sum(${subscriptionPlans.priceAmountCents}), 0)::bigint`,
      })
      .from(academySubscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
      .where(
        and(
          ne(academySubscriptions.status, "cancelled"),
          isNotNull(academySubscriptions.endsAt),
          since ? gte(academySubscriptions.endsAt, since) : undefined,
        ),
      )
      .groupBy(subscriptionCols.key, subscriptionCols.label),
  ]);

  const groups = new Map<string, { label: string; collectedCents: number; expectedCents: number }>();

  for (const row of paymentRows) {
    const entry = groups.get(row.key) ?? { label: row.label, collectedCents: 0, expectedCents: 0 };
    entry.collectedCents += Number(row.cents);
    groups.set(row.key, entry);
  }

  for (const row of subscriptionRows) {
    const entry = groups.get(row.key) ?? { label: row.label, collectedCents: 0, expectedCents: 0 };
    entry.expectedCents += Number(row.cents);
    groups.set(row.key, entry);
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

  return { groupBy, since, rows, totals };
}

export interface GetPlatformReportsParams {
  groupBy?: RevenueGroupBy;
  trendMonths?: number;
  expiringWithinDays?: number;
  /**
   * The page's date range, in trailing months including the current one.
   * Drives the trend windows (unless `trendMonths` is given) and limits
   * revenue to that window. null = all time: revenue unbounded, trends over
   * ALL_TIME_TREND_MONTHS. Omitted = the previous behavior (all-time
   * revenue, 12-month trend), so existing callers such as the dashboard
   * are unchanged.
   */
  rangeMonths?: number | null;
}

/** Trend length shown for the "All time" range. */
export const ALL_TIME_TREND_MONTHS = 24;

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
  const rangeMonths = params.rangeMonths;
  const trendMonths = params.trendMonths ?? (rangeMonths === undefined ? 12 : (rangeMonths ?? ALL_TIME_TREND_MONTHS));
  const expiringWithinDays = params.expiringWithinDays ?? 30;
  const revenueSince = rangeMonths ? trailingWindowStart(rangeMonths) : null;

  // Permission lookups are cheap; resolving them first lets every real
  // read below run together in one Promise.all (previously the revenue
  // read waited on the others before it could start).
  const [canViewRevenue, canViewLifecycle] = await Promise.all([
    hasPermission(actorContext, REVENUE_VIEW_CAPABILITY),
    hasPermission(actorContext, ACADEMY_LIFECYCLE_CAPABILITY),
  ]);

  // The selected breakdown reuses the month or plan series when it is one
  // of them, so no grouping is queried twice in one call.
  const revenueOptions = { since: revenueSince };
  const revenueTrendPromise = canViewRevenue ? getRevenueBreakdown("month", revenueOptions) : Promise.resolve(null);
  const revenueByPlanPromise = canViewRevenue ? getRevenueBreakdown("plan", revenueOptions) : Promise.resolve(null);
  const revenuePromise = !canViewRevenue
    ? Promise.resolve(null)
    : groupBy === "month"
      ? revenueTrendPromise
      : groupBy === "plan"
        ? revenueByPlanPromise
        : getRevenueBreakdown(groupBy, revenueOptions);

  const [
    activeAcademyTrend,
    expiringSubscriptions,
    academiesByPlan,
    subscriptionStatus,
    population,
    academyLifecycle,
    academyRegistrations,
    revenue,
    revenueTrend,
    revenueByPlan,
  ] = await Promise.all([
    getActiveAcademyTrend(trendMonths),
    getExpiringSubscriptions(expiringWithinDays),
    getAcademiesByPlan(),
    getSubscriptionStatusCounts(),
    getPlatformPopulationTotals(),
    canViewLifecycle ? getAcademyStatusCounts() : Promise.resolve(null),
    canViewLifecycle ? getAcademyRegistrations(trendMonths) : Promise.resolve(null),
    revenuePromise,
    revenueTrendPromise,
    revenueByPlanPromise,
  ]);

  return {
    ok: true,
    data: {
      trendMonths,
      revenueSince,
      activeAcademyTrend,
      expiringSubscriptions,
      academiesByPlan,
      subscriptionStatus,
      population,
      academyLifecycle,
      academyRegistrations,
      revenue,
      revenueTrend,
      revenueByPlan,
    },
  };
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
  // Readable export (lib/export/readable.ts): the group column is named for
  // what it groups by, and raw codes/months read as words ("Mobile Money",
  // "Oct 2026"). Written through the shared CSV writer for its quoting and
  // spreadsheet formula-injection guard.
  const heading = REVENUE_GROUP_HEADINGS[result.groupBy];
  const label = (row: RevenueBreakdownRow) =>
    result.groupBy === "month"
      ? exportMonth(row.label)
      : result.groupBy === "method" || result.groupBy === "billing_period"
        ? exportLabel(row.label)
        : row.label;
  const amount = (cents: number) => (cents / 100).toFixed(2);
  const rows = [
    ...result.rows.map((row) => ({ [heading]: label(row), Collected: amount(row.collectedCents), Expected: amount(row.expectedCents) })),
    { [heading]: "Total", Collected: amount(result.totals.collectedCents), Expected: amount(result.totals.expectedCents) },
  ];
  return toCsv(rows, [heading, "Collected", "Expected"]);
}

const REVENUE_GROUP_HEADINGS: Record<RevenueGroupBy, string> = {
  month: "Month",
  plan: "Plan",
  academy: "Academy",
  method: "Payment Method",
  billing_period: "Billing Period",
};
