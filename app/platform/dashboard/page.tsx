import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getPlatformDashboardData } from "@/lib/platform/dashboard";
import { formatMoney } from "@/lib/ui/money";
import { Icon } from "@/app/academy/_shell/icons";
import { TrendAreaChart } from "@/app/academy/_shell/charts";
import {
  Badge,
  EmptyState,
  LinkButton,
  PAGE_WRAP,
  PageHeader,
  Section,
  StatCard,
  TableWrap,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(date));
}

/** Same currency-agnostic cents formatter as app/platform/reports/
 * reports-manager.tsx's own copy — subscription_payments/subscription_plans
 * currency is a free-text per-row field this codebase never reconciles
 * across a mixed-currency deployment, so `revenue.totals` (summed across
 * rows) has no single currency to pass to `formatMoney`. Small, pure,
 * per-file helper — not worth centralizing for a second call site. */
function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Same "YYYY-MM" source format as app/academy/dashboard/page.tsx's
 * identical copy. */
function formatMonthPeriod(period: string): string {
  const [year, month] = period.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return period;
  return parsed.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

const PAYMENT_STATUS_TONE: Record<string, "amber" | "green" | "red" | "slate" | "gray"> = {
  pending: "amber",
  verified: "green",
  rejected: "red",
  reversed: "slate",
};

/**
 * Navigation-audit Phase 3 — the one genuinely new page from the audit's
 * §10 table: a lightweight landing page for `/platform/*` so a platform
 * actor doesn't land on a bare "Academies" list with no sense of what needs
 * attention. All data comes from `lib/platform/dashboard.ts`'s
 * `getPlatformDashboardData`, which only calls already-existing, already-gated
 * reads — see that file's module comment.
 *
 * No single page-level capability gate: `app/platform/layout.tsx` already
 * requires *some* platform role before any `/platform/*` route (including
 * this one) renders at all, exactly like `/academy/dashboard` has no gate
 * beyond its own layout. Each section below is independently omitted (not
 * shown as an error) when the actor's specific capability grant doesn't
 * cover it — mirrors the academy dashboard's per-section visibility.
 *
 * Visual-parity pass (dashboard redesign wave): brought onto the same KPI
 * row / chart / table layout as `/academy/dashboard`, using fields
 * (`academyCounts`, `activeAcademyTrend`, `revenue`) that `getPlatformReports`
 * and `listAcademies` already computed on every load but
 * `lib/platform/dashboard.ts` previously discarded — no new queries. The
 * "Total Academies" delta pill is derived from `activeAcademyTrend`'s own
 * last two points (the same series rendered in the chart below), never a
 * fabricated comparison.
 *
 * Entrance stagger: the chart/table `Section`s below the KPI row continue
 * the same `motion-safe:animate-fade-in-up` cadence `StatCard` uses for its
 * own index-based stagger, via `Section`'s `style` passthrough — same
 * reasoning as the Academy dashboard's identical addition (see that file's
 * comment); not applied to `platform-shell.tsx`'s nav for the same
 * every-navigation-frequency reason.
 */
export default async function PlatformDashboardPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const data = await getPlatformDashboardData(context);

  // Derived strictly from activeAcademyTrend's own last two points (already
  // fetched for the chart below) — never a fabricated comparison period, per
  // StatCard's `delta` contract. Cumulative counts never fall in this trend's
  // own derivation (see lib/subscriptions/reports.ts), so "down" never fires.
  let totalAcademiesDelta: { label: string; direction: "up" | "down" | "flat" } | undefined;
  if (data.activeAcademyTrend && data.activeAcademyTrend.length > 0) {
    const latest = data.activeAcademyTrend[data.activeAcademyTrend.length - 1];
    totalAcademiesDelta =
      latest.newlyActivated > 0
        ? { label: `+${latest.newlyActivated} this month`, direction: "up" }
        : { label: "No change this month", direction: "flat" };
  }

  const hasKpis =
    data.academyCounts !== null ||
    data.pendingApprovals !== null ||
    data.expiringSubscriptions !== null ||
    data.revenue !== null;

  // Server-rendered fresh on every request (no caching layer in front), so
  // this is a truthful "as of now" marker, not a fabricated one — same
  // reasoning as the Academy dashboard's identical header addition.
  const generatedAt = new Date();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Dashboard"
        description="Overview of academies, subscriptions, and payments across the platform."
        actions={
          <span className="text-xs text-muted">
            Last updated {generatedAt.toLocaleDateString(undefined, { weekday: "short" })},{" "}
            {generatedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        }
      />

      <div className="flex flex-col gap-6">
        {hasKpis && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            {data.academyCounts !== null && (
              <StatCard
                label="Total Academies"
                value={data.academyCounts.total}
                delta={totalAcademiesDelta}
                icon={<Icon name="apartment" />}
                iconTone="brand"
                index={0}
                href="/platform/academies"
              />
            )}
            {data.pendingApprovals !== null && (
              <StatCard
                label="Pending Approvals"
                value={data.pendingApprovals.length}
                icon={<Icon name="receipt_long" />}
                iconTone={data.pendingApprovals.length > 0 ? "warning" : "brand"}
                index={1}
                href="/platform/academies"
              />
            )}
            {data.expiringSubscriptions !== null && (
              <StatCard
                label="Expiring Subscriptions"
                value={data.expiringSubscriptions.length}
                icon={<Icon name="autorenew" />}
                iconTone={data.expiringSubscriptions.length > 0 ? "warning" : "brand"}
                index={2}
                href="/platform/reports"
              />
            )}
            {data.revenue !== null && (
              <StatCard
                label="Total Collected"
                value={formatCents(data.revenue.totals.collectedCents)}
                hint={
                  data.revenue.totals.expectedCents > 0
                    ? `${formatCents(data.revenue.totals.expectedCents)} expected/pending`
                    : undefined
                }
                icon={<Icon name="payments" />}
                iconTone="success"
                index={3}
                href="/platform/reports"
              />
            )}
          </div>
        )}

        {data.activeAcademyTrend && data.activeAcademyTrend.length > 0 && (
          <Section className="motion-safe:animate-fade-in-up" style={{ animationDelay: "240ms" }}>
            <h2 className="text-base font-semibold text-ink">Active academies</h2>
            <div className="mt-4">
              <TrendAreaChart
                id="platform-dashboard-active-academies"
                points={data.activeAcademyTrend.map((p) => ({
                  label: formatMonthPeriod(p.month),
                  value: p.cumulativeActive,
                }))}
                ariaLabel="Cumulative active academies by activation month"
                emptyMessage="No active academies yet."
              />
            </div>
            <p className="mt-3 text-sm text-muted">
              Academies currently active, grouped by the month their subscription was activated —
              not a historical snapshot, see{" "}
              <Link href="/platform/reports" className="text-brand hover:underline">
                full reports
              </Link>{" "}
              for details.
            </p>
          </Section>
        )}

        <Section className="motion-safe:animate-fade-in-up" style={{ animationDelay: "300ms" }}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Pending approvals</h2>
            <LinkButton href="/platform/academies" variant="secondary">
              View all academies
            </LinkButton>
          </div>
          {data.pendingApprovals === null ? (
            <EmptyState message="You don't have permission to view academy approvals." icon={<Icon name="apartment" />} />
          ) : data.pendingApprovals.length === 0 ? (
            <EmptyState message="No academies awaiting approval." icon={<Icon name="apartment" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Submitted by</th>
                  <th className={th}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.pendingApprovals.map((academy) => (
                  <tr key={academy.id} className={trHover}>
                    <td className={td}>{academy.name}</td>
                    <td className={td}>{academy.createdByEmail ?? "—"}</td>
                    <td className={td}>{formatDate(academy.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        <Section className="motion-safe:animate-fade-in-up" style={{ animationDelay: "360ms" }}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Expiring subscriptions</h2>
            <LinkButton href="/platform/reports" variant="secondary">
              View reports
            </LinkButton>
          </div>
          {data.expiringSubscriptions === null ? (
            <EmptyState message="You don't have permission to view platform reports." icon={<Icon name="autorenew" />} />
          ) : data.expiringSubscriptions.length === 0 ? (
            <EmptyState message="No subscriptions expiring soon." icon={<Icon name="autorenew" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Plan</th>
                  <th className={th}>Ends</th>
                  <th className={th}>Days left</th>
                </tr>
              </thead>
              <tbody>
                {data.expiringSubscriptions.map((row) => (
                  <tr key={row.subscriptionId} className={trHover}>
                    <td className={td}>{row.academyName}</td>
                    <td className={td}>{row.planName}</td>
                    <td className={td}>{formatDate(row.endsAt)}</td>
                    <td className={td}>
                      <Badge
                        label={row.daysUntilExpiry < 0 ? "Overdue" : `${row.daysUntilExpiry}d`}
                        tone={row.daysUntilExpiry < 0 ? "red" : "amber"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        <Section className="motion-safe:animate-fade-in-up" style={{ animationDelay: "420ms" }}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Recent payments</h2>
            <LinkButton href="/platform/payments" variant="secondary">
              View all payments
            </LinkButton>
          </div>
          {data.recentPayments === null ? (
            <EmptyState message="You don't have permission to view subscription payments." icon={<Icon name="payments" />} />
          ) : data.recentPayments.length === 0 ? (
            <EmptyState message="No payments recorded yet." icon={<Icon name="payments" />} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Academy</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Received</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((payment) => (
                  <tr key={payment.id} className={trHover}>
                    <td className={td}>{payment.academyName ?? "—"}</td>
                    <td className={td}>{formatMoney(payment.amountCents, payment.currency)}</td>
                    <td className={td}>{formatDate(payment.receivedAt)}</td>
                    <td className={td}>
                      <Badge label={payment.status} tone={PAYMENT_STATUS_TONE[payment.status] ?? "gray"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>
      </div>
    </div>
  );
}
