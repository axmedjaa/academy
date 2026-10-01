import { hasPermission } from "@/lib/auth/permissions";
import { listAcademies, type AcademySummary } from "@/lib/academies/approve";
import { getPlatformReports, type ExpiringSubscriptionRow } from "@/lib/subscriptions/reports";
import { listAcademySubscriptionOptions, listSubscriptionPayments } from "@/lib/subscriptions/payments";
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

export interface PlatformDashboardData {
  pendingApprovals: PendingApprovalRow[] | null;
  expiringSubscriptions: ExpiringSubscriptionRow[] | null;
  recentPayments: RecentSubscriptionPaymentRow[] | null;
}

const PENDING_APPROVALS_CAPABILITY = "approveAcademy";
const RECENT_PAYMENTS_CAPABILITY = "recordSubscriptionPayment";
const RECENT_PAYMENTS_LIMIT = 5;

export async function getPlatformDashboardData(
  actorContext: AuthContext,
): Promise<PlatformDashboardData> {
  const [canSeeApprovals, canSeePayments] = await Promise.all([
    hasPermission(actorContext, PENDING_APPROVALS_CAPABILITY),
    hasPermission(actorContext, RECENT_PAYMENTS_CAPABILITY),
  ]);

  const [academiesList, reportsResult, paymentsData] = await Promise.all([
    canSeeApprovals ? listAcademies() : Promise.resolve(null),
    getPlatformReports(actorContext),
    canSeePayments
      ? Promise.all([listSubscriptionPayments(), listAcademySubscriptionOptions()])
      : Promise.resolve(null),
  ]);

  const pendingApprovals = academiesList
    ? academiesList
        .filter((academy: AcademySummary) => academy.status === "pending_approval")
        .map((academy) => ({
          id: academy.id,
          name: academy.name,
          createdAt: academy.createdAt,
          createdByEmail: academy.createdByEmail,
        }))
    : null;

  const expiringSubscriptions = reportsResult.ok ? reportsResult.data.expiringSubscriptions : null;

  let recentPayments: RecentSubscriptionPaymentRow[] | null = null;
  if (paymentsData) {
    const [allPayments, subscriptionOptions] = paymentsData;
    const academyNameBySubscriptionId = new Map(
      subscriptionOptions.map((option) => [option.subscriptionId, option.academyName]),
    );
    const sorted = [...allPayments].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    recentPayments = sorted.slice(0, RECENT_PAYMENTS_LIMIT).map((payment) => ({
      id: payment.id,
      academyName: academyNameBySubscriptionId.get(payment.subscriptionId) ?? null,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      receivedAt: payment.receivedAt,
    }));
  }

  return { pendingApprovals, expiringSubscriptions, recentPayments };
}
