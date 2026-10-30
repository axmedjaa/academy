import { hasPermission } from "@/lib/auth/permissions";
import { getAcademyStatusCounts, listPendingApprovalAcademies } from "@/lib/academies/approve";
import {
  getPlatformReports,
  type ActiveAcademyTrendPoint,
  type ExpiringSubscriptions,
  type RevenueBreakdownResult,
} from "@/lib/subscriptions/reports";
import { listSubscriptionPayments } from "@/lib/subscriptions/payments";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Navigation-audit Phase 3 — `/platform/dashboard`'s data. Every number here
 * comes from an existing, already-gated read (listAcademies /
 * getPlatformReports / listSubscriptionPayments + listAcademySubscriptionOptions)
 * — nothing new is computed, mirroring lib/academies/dashboard.ts's own
 * "don't invent metrics" discipline for the academy side.
 *
 * Each of the three sections is independently capability-gated and comes
 * back `null` rather than failing the whole page when the actor lacks that
 * capability — the same per-section-visibility pattern getPlatformReports()
 * itself already uses internally for `revenue` (see that file's module
 * comment). A platform_admin granted only "recordSubscriptionPayment", say,
 * still gets a useful dashboard with just the Recent Payments section.
 */
export interface PendingApprovalRow {
  id: string;
  name: string;
  createdAt: Date;
  createdByEmail: string | null;
}

export interface RecentSubscriptionPaymentRow {
  id: string;
  academyName: string | null;
  amountCents: number;
  currency: string;
  status: "pending" | "verified" | "rejected" | "reversed";
  receivedAt: Date;
}

export interface AcademyCounts {
  total: number;
  /** Per-status breakdown, keyed by the academy's own `status` string
   * (e.g. "approved", "pending_approval", "closed") — no hardcoded status
   * list here, so this stays correct if that enum ever changes. */
  byStatus: Record<string, number>;
}

export interface PlatformDashboardData {
  pendingApprovals: PendingApprovalRow[] | null;
  expiringSubscriptions: ExpiringSubscriptions | null;
  recentPayments: RecentSubscriptionPaymentRow[] | null;
  /** Same `listAcademies()` call already made for `pendingApprovals` above,
   * just also summarized into counts — no second query. Null under the
   * same condition `pendingApprovals` is null (actor lacks visibility into
   * the academies list at all). */
  academyCounts: AcademyCounts | null;
  /** Same `getPlatformReports` call already made for `expiringSubscriptions`
   * below — threaded through here too rather than fetched again, so the
   * dashboard's active-academies chart and revenue stat cost nothing extra.
   * `revenue` independently null per `getPlatformReports`'s own two-tier
   * capability split (see that function's module comment) even when
   * `activeAcademyTrend` itself is present. */
  activeAcademyTrend: ActiveAcademyTrendPoint[] | null;
  revenue: RevenueBreakdownResult | null;
  /** Whether the actor may act on the rows shown (open an academy to
   * approve it, renew a subscription). Purely presentational — every target
   * page re-checks its own capability server-side. */
  canOpenAcademies: boolean;
  canRenewSubscriptions: boolean;
}

const PENDING_APPROVALS_CAPABILITY = "approveAcademy";
/** Dashboard preview cap — a platform with many pending academies all
 * waiting at once previously rendered every one of them inline; the full
 * set is still one click away via the panel's own "View all academies"
 * link to `/platform/academies`. `academyCounts`'s own total/byStatus
 * numbers (from the separate `getAcademyStatusCounts` query) are
 * unaffected by this cap — they're never derived from this list. */
const PENDING_APPROVALS_PREVIEW_LIMIT = 5;
const RECENT_PAYMENTS_CAPABILITY = "recordSubscriptionPayment";
const RENEW_SUBSCRIPTIONS_CAPABILITY = "renewSubscription";
/** Previously fetched every subscription payment the platform has ever
 * recorded and sorted/sliced to 5 in JS; now pushed down to a DB-level
 * ORDER BY/LIMIT via `listSubscriptionPayments`'s own `limit` argument. */
const RECENT_PAYMENTS_LIMIT = 4;
export async function getPlatformDashboardData(
  actorContext: AuthContext,
): Promise<PlatformDashboardData> {
  const [canSeeApprovals, canSeePayments, canRenewSubscriptions] = await Promise.all([
    hasPermission(actorContext, PENDING_APPROVALS_CAPABILITY),
    hasPermission(actorContext, RECENT_PAYMENTS_CAPABILITY),
    hasPermission(actorContext, RENEW_SUBSCRIPTIONS_CAPABILITY),
  ]);

  const [pendingApprovalAcademies, academyStatusCounts, reportsResult, recentPaymentRows] = await Promise.all([
    // Both previously came from `listAcademies()` — every academy
    // platform-wide, plus a per-academy subscription-summary and
    // branch-count join neither of these needs — filtered/reduced in JS
    // afterward. Two small, purpose-built reads instead (see their own
    // comments in lib/academies/approve.ts).
    canSeeApprovals ? listPendingApprovalAcademies(PENDING_APPROVALS_PREVIEW_LIMIT) : Promise.resolve(null),
    canSeeApprovals ? getAcademyStatusCounts() : Promise.resolve(null),
    getPlatformReports(actorContext),
    // The `limit` path joins `academies` directly (subscription_payments
    // carries its own academyId — see that function's own comment), so
    // `academyName` arrives on each row in this one query — no second
    // lookup query needed.
    canSeePayments ? listSubscriptionPayments(RECENT_PAYMENTS_LIMIT) : Promise.resolve(null),
  ]);

  const pendingApprovals = pendingApprovalAcademies;

  const academyCounts: AcademyCounts | null = academyStatusCounts;

  const expiringSubscriptions = reportsResult.ok ? reportsResult.data.expiringSubscriptions : null;
  const activeAcademyTrend = reportsResult.ok ? reportsResult.data.activeAcademyTrend : null;
  const revenue = reportsResult.ok ? reportsResult.data.revenue : null;

  let recentPayments: RecentSubscriptionPaymentRow[] | null = null;
  if (recentPaymentRows) {
    // Already the most recent RECENT_PAYMENTS_LIMIT rows, newest first, each
    // already carrying its own real `academyName` from the join above —
    // no JS sort/slice or second lookup query needed anymore.
    recentPayments = recentPaymentRows.map((payment) => ({
      id: payment.id,
      academyName: payment.academyName,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      receivedAt: payment.receivedAt,
    }));
  }

  return {
    pendingApprovals,
    expiringSubscriptions,
    recentPayments,
    academyCounts,
    activeAcademyTrend,
    revenue,
    canOpenAcademies: canSeeApprovals,
    canRenewSubscriptions,
  };
}
