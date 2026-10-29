import Link from "next/link";
import type { ReactNode } from "react";
import type { PlatformDashboardData } from "@/lib/platform/dashboard";
import { formatMoneyHeadline } from "@/lib/ui/money";
import { buildMonthlyWindow } from "@/lib/ui/monthly-window";
import { Icon } from "@/app/academy/_shell/icons";
import { DashboardTrendChart } from "@/app/academy/_shell/dashboard-trend-chart";
import { Badge, EmptyState } from "@/app/academy/_shell/ui";
import { EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT } from "@/lib/subscriptions/reports";
import { ExpiringList } from "../_shared/expiring-list";

/**
 * `/platform/dashboard` — Screen Inventory P01, built from the active
 * `Platform Console.dc.html` `isDashboard` block (HANDOFF.md: the single
 * authoritative design source). Deliberately its own composition, not the
 * academy bento — 12px cards, a platform-wide headline:
 *
 *   1. Page header.
 *   2. KPI row, 1.15fr / 1fr: hero "Total academies" (gold accent bar, 64px
 *      figure, Approved / Awaiting approval footer) beside three stacked
 *      KPI rows — Pending approvals, Expiring subscriptions (14 days),
 *      Total collected (verified payments).
 *   3. Active academies trend | Pending approvals list.
 *   4. Expiring subscriptions | Recent payments.
 *
 * Every section is gated by its own capability (B11: each section shown or
 * permission-denied on its own). A section the account cannot use keeps
 * its card and says so — never a zero that looks like data.
 */

const CARD = "dd-lift rounded-card border border-border bg-surface p-5 shadow-card";
const EXPIRING_WINDOW_DAYS = 14;
function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Subscription payment/plan currency is a free-text per-row field never
 * reconciled across currencies, so platform totals are shown as plain
 * amounts, exactly as on /platform/reports. */
function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}


const PAYMENT_BADGE: Record<string, { label: string; tone: "amber" | "green" | "red" | "slate" }> = {
  pending: { label: "Pending", tone: "amber" },
  verified: { label: "Verified", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  reversed: { label: "Reversed", tone: "slate" },
};

function AccessDenied({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 border-t border-border py-4 text-sm text-muted">
      <Icon name="lock" width={16} height={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function KpiRow({ label, value, hint, icon, href }: { label: string; value: string; hint?: string; icon: string; href?: string }) {
  const body = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-brand-tint text-brand">
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-muted">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <span className="text-[28px] font-bold leading-none tabular-nums text-ink">{value}</span>
    </>
  );
  const className = `${CARD} flex items-center gap-4 px-5 py-4 text-ink no-underline hover:no-underline`;
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Pure render of P01 from already-authorized data — kept separate from the
 * data fetch so the layout can be exercised without a session. */
export function PlatformDashboardView({ data }: { data: PlatformDashboardData }) {
  const counts = data.academyCounts;
  const pendingCount = counts ? (counts.byStatus.pending_approval ?? 0) : null;
  const expiring = data.expiringSubscriptions
    ? data.expiringSubscriptions.rows.filter((row) => row.daysUntilExpiry <= EXPIRING_WINDOW_DAYS)
    : null;
  // Rows arrive soonest first and capped, so the 14-day count is exact
  // unless the cap cut the list off while still inside those 14 days.
  const expiringRows = data.expiringSubscriptions?.rows ?? [];
  const expiringTotal =
    data.expiringSubscriptions === null || expiring === null
      ? null
      : data.expiringSubscriptions.totalCount <= expiringRows.length ||
          (expiringRows.at(-1)?.daysUntilExpiry ?? 0) > EXPIRING_WINDOW_DAYS
        ? expiring.length
        : null;
  const trend = data.activeAcademyTrend
    ? buildMonthlyWindow(data.activeAcademyTrend.map((p) => ({ period: p.month, count: p.newlyActivated })), {
        cumulative: true,
      })
    : null;
  const priorMonth = trend && trend.length > 1 ? trend[trend.length - 2].label : null;
  const zeroGrants =
    counts === null && data.activeAcademyTrend === null && data.recentPayments === null && data.revenue === null;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-muted">Academies, subscriptions and payments across the platform.</p>
        {zeroGrants && <p className="mt-2 text-[#374151]">No platform tools are available for your account yet.</p>}
      </div>

      <div className="@container">
        <div className="dd-grid mb-6 grid grid-cols-1 items-stretch gap-6 @[720px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="relative flex min-h-[220px] flex-col justify-between gap-6 overflow-hidden rounded-card border border-border bg-[linear-gradient(135deg,#F9E8EC_0%,#E9C3CC_100%)] p-7 text-ink shadow-card">
            <span aria-hidden="true" className="absolute left-0 top-7 h-10 w-1 rounded-r bg-accent-gold" />
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium text-[#374151]">Total academies</span>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white text-brand">
                <Icon name="apartment" />
              </span>
            </div>
            <div>
              {counts ? (
                <Link
                  href="/platform/academies"
                  className="block text-[56px] font-bold leading-none tracking-[-0.02em] !text-brand tabular-nums no-underline hover:no-underline sm:text-[64px]"
                >
                  {counts.total.toLocaleString()}
                </Link>
              ) : (
                <div className="text-[56px] font-bold leading-none text-brand sm:text-[64px]" aria-label="Not available">
                  —
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-4 border-t border-brand pt-4">
                {counts ? (
                  <>
                    <span className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-brand">
                        <Icon name="fact_check" width={18} height={18} />
                      </span>
                      <span className="flex items-baseline gap-2">
                        <span className="text-xl font-semibold tabular-nums">{(counts.byStatus.approved ?? 0).toLocaleString()}</span>
                        <span className="text-[13px] text-[#374151]">Approved</span>
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-brand">
                        <Icon name="pending" width={18} height={18} />
                      </span>
                      <span className="flex items-baseline gap-2">
                        <span className="text-xl font-semibold tabular-nums">{(pendingCount ?? 0).toLocaleString()}</span>
                        <span className="text-[13px] text-[#374151]">Awaiting approval</span>
                      </span>
                    </span>
                  </>
                ) : (
                  <span className="text-[13px] text-[#374151]">Academy totals are available to Platform Owner accounts only.</span>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 @[720px]:grid-rows-3">
            <KpiRow
              label="Pending approvals"
              value={pendingCount !== null ? pendingCount.toLocaleString() : "—"}
              hint={pendingCount !== null ? "Academies waiting for review" : "Owner only"}
              icon="pending"
              href={pendingCount !== null ? "/platform/academies" : undefined}
            />
            <KpiRow
              label="Expiring subscriptions"
              value={expiring ? (expiringTotal === null ? `${expiring.length}+` : expiringTotal.toLocaleString()) : "—"}
              hint={expiring ? `Within ${EXPIRING_WINDOW_DAYS} days, or overdue` : "Not available for your account"}
              icon="warning"
              href={expiring ? (data.canRenewSubscriptions ? "/platform/subscriptions" : "/platform/reports") : undefined}
            />
            <KpiRow
              label="Total collected"
              value={data.revenue ? formatAmount(data.revenue.totals.collectedCents) : "—"}
              hint={data.revenue ? "Verified payments" : "Owner only"}
              icon="payments"
              href={data.revenue ? "/platform/reports" : undefined}
            />
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 items-start gap-6 @[700px]:grid-cols-2">
          <section className={CARD}>
            {trend ? (
              <DashboardTrendChart
                title="Active academies"
                subtitle="Currently active, by month activated"
                points={trend}
                noun="active academies"
                unit="academies"
                deltaSuffix={priorMonth ? `vs ${priorMonth}` : undefined}
                legend="Active academies"
              />
            ) : (
              <>
                <h2 className="mb-2 font-semibold text-ink">Active academies</h2>
                <AccessDenied>Access denied. Platform reports are not granted to this account.</AccessDenied>
              </>
            )}
          </section>

          <section className={CARD} aria-labelledby="dash-pending">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 id="dash-pending" className="font-semibold text-ink">
                Pending approvals
              </h2>
              {data.pendingApprovals && data.pendingApprovals.length > 0 && (
                <Link href="/platform/academies" className="text-[13px] !text-brand hover:underline">
                  View all
                </Link>
              )}
            </div>
            {data.pendingApprovals === null ? (
              <AccessDenied>Access denied. Academy approvals are available to Platform Owner accounts only.</AccessDenied>
            ) : data.pendingApprovals.length === 0 ? (
              <EmptyState message="No academies are waiting for approval." icon={<Icon name="check_circle" />} />
            ) : (
              <ul>
                {data.pendingApprovals.map((academy) => (
                  <li key={academy.id} className="border-t border-border">
                    <Link
                      href={`/platform/academies/${academy.id}`}
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-xs font-semibold text-brand">
                        {getInitials(academy.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{academy.name}</span>
                        <span className="block truncate text-xs text-muted">
                          {academy.createdByEmail ? `${academy.createdByEmail} · ` : ""}registered {formatDate(academy.createdAt)}
                        </span>
                      </span>
                      <span className="hidden shrink-0 sm:inline-flex">
                        <Badge label="Pending approval" tone="amber" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 @[700px]:grid-cols-2">
          <section className={CARD} aria-labelledby="dash-expiring">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 id="dash-expiring" className="font-semibold text-ink">
                  Expiring subscriptions
                </h2>
                <p className="text-xs text-muted">Within {EXPIRING_WINDOW_DAYS} days, including past due</p>
              </div>
              {expiring && expiring.length > 0 && (
                <Link
                  href={data.canRenewSubscriptions ? "/platform/subscriptions" : "/platform/reports"}
                  className="shrink-0 text-[13px] !text-brand hover:underline"
                >
                  {data.canRenewSubscriptions ? "Renew" : "Reports"}
                </Link>
              )}
            </div>
            {expiring === null ? (
              <AccessDenied>Access denied. Subscriptions are not available to this account.</AccessDenied>
            ) : expiring.length === 0 ? (
              <EmptyState message={`No subscriptions end in the next ${EXPIRING_WINDOW_DAYS} days.`} icon={<Icon name="autorenew" />} />
            ) : (
              <ExpiringList
                variant="preview"
                viewAllHref="/platform/reports"
                rows={expiring}
                totalCount={expiringTotal}
                cap={EXPIRING_SUBSCRIPTIONS_DEFAULT_LIMIT}
                linkAcademies={data.canOpenAcademies}
                emptyMessage={`No subscriptions end in the next ${EXPIRING_WINDOW_DAYS} days.`}
              />
            )}
          </section>

          <section className={CARD} aria-labelledby="dash-payments">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 id="dash-payments" className="font-semibold text-ink">
                Recent payments
              </h2>
              {data.recentPayments && (
                <Link href="/platform/payments" className="text-[13px] !text-brand hover:underline">
                  View all
                </Link>
              )}
            </div>
            {data.recentPayments === null ? (
              <AccessDenied>Access denied. Recording payments is not granted to this account.</AccessDenied>
            ) : data.recentPayments.length === 0 ? (
              <EmptyState message="No subscription payments recorded yet." icon={<Icon name="payments" />} />
            ) : (
              <ul>
                {data.recentPayments.map((payment) => {
                  const badge = PAYMENT_BADGE[payment.status] ?? { label: payment.status, tone: "slate" as const };
                  return (
                    <li key={payment.id} className="flex items-center gap-3 border-t border-border py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{payment.academyName ?? "—"}</span>
                        <span className="block text-xs text-muted">{formatDate(payment.receivedAt)}</span>
                      </span>
                      <span className="shrink-0 text-right font-medium tabular-nums text-ink">
                        {formatMoneyHeadline(payment.amountCents, payment.currency)}
                      </span>
                      <Badge label={badge.label} tone={badge.tone} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
