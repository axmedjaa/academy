import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAcademyDashboardData } from "@/lib/academies/dashboard";
import { getStatusTone } from "@/lib/ui/status";
import { Icon } from "@/app/academy/_shell/icons";
import {
  Badge,
  EmptyState,
  ErrorMessage,
  PageHeader,
  Section,
  StatCard,
  TableWrap,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

/**
 * DESIGN.md §9.1 — replaces the Item 28 placeholder shell. All data comes
 * from `lib/academies/dashboard.ts`'s `getAcademyDashboardData`, which itself
 * only calls already-existing, already-gated report/summary functions — see
 * that file's module comment.
 *
 * UI-quality pass (Phase 3 of the frontend redesign): restyled onto the same
 * Tailwind shell every other `/academy/*` list page already uses
 * (PageHeader/Section/TableWrap/Badge) instead of this page's original
 * bespoke inline-style markup — no data, query, or permission logic
 * changed. Status coloring now goes through `lib/ui/status.ts`'s shared
 * `getStatusTone` instead of a copy of the tone map local to this file (a
 * second, independent copy still lives in
 * app/academy/finance/finance-charges-payments.tsx's own richer payment
 * table — consolidating that one too is a follow-up, not done here to keep
 * this pass scoped to the dashboard).
 */
export default async function AcademyDashboardPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await getAcademyDashboardData(context);
  if (!result.ok) {
    return <ErrorMessage message={result.error.message} />;
  }

  const { data } = result;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Overview of your academy performance." />

      {data.alerts.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.alerts.map((alert, index) => (
            <div
              key={index}
              role="status"
              className={`rounded-lg px-3 py-2 text-sm ${
                alert.tone === "red" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"
              }`}
            >
              {alert.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.totalStudents !== null && (
          <StatCard label="Total Students" value={data.totalStudents} icon={<Icon name="group" />} index={0} />
        )}
        {data.activeStaffCount !== null && (
          <StatCard label="Staff" value={data.activeStaffCount} icon={<Icon name="badge" />} index={1} />
        )}
        {data.upcomingExamsCount !== null && (
          <StatCard
            label="Upcoming Exams"
            value={data.upcomingExamsCount}
            icon={<Icon name="fact_check" />}
            index={2}
          />
        )}
        {data.pendingApprovalsCount !== null && (
          <StatCard
            label="Pending Approvals"
            value={data.pendingApprovalsCount}
            icon={<Icon name="receipt_long" />}
            index={3}
          />
        )}
        {data.finance && (
          <StatCard
            label="Outstanding Charges"
            value={data.finance.outstandingCharges.count}
            hint={data.finance.outstandingCharges.totalsByCurrency
              .map((row) => formatMoney(row.amountCents, row.currency))
              .join(", ") || undefined}
            icon={<Icon name="payments" />}
            index={4}
          />
        )}
      </div>

      <Section>
        <h2 className="text-base font-semibold text-ink">Recent payments</h2>
        {data.recentPayments === null ? (
          <EmptyState message="You don't have permission to view payments." />
        ) : data.recentPayments.length === 0 ? (
          <EmptyState message="No payments recorded yet." icon={<Icon name="payments" />} />
        ) : (
          <div className="mt-4">
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Student</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Date</th>
                  <th className={th}>Method</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((payment) => (
                  <tr key={payment.id} className={trHover}>
                    <td className={`${td} font-medium`}>{payment.studentName}</td>
                    <td className={`${td} tabular-nums`}>{formatMoney(payment.amountCents, payment.currency)}</td>
                    <td className={td}>{payment.receivedAt.toLocaleDateString()}</td>
                    <td className={td}>{payment.method.replace("_", " ")}</td>
                    <td className={td}>
                      <Badge label={payment.status.replace("_", " ")} tone={getStatusTone(payment.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}
      </Section>

      {data.usage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Usage</h2>
          {data.usage.metrics && data.usage.limits ? (
            <div className="mt-4 flex flex-col gap-3">
              <UsageBar
                label="Students"
                used={data.usage.metrics.activeStudentsCount}
                limit={data.usage.limits.maxStudents}
              />
              <UsageBar label="Staff" used={data.usage.metrics.activeStaffCount} limit={data.usage.limits.maxStaff} />
              <UsageBar label="Branches" used={data.usage.metrics.branchCount} limit={data.usage.limits.maxBranches} />
              <UsageBar label="Courses" used={data.usage.metrics.courseCount} limit={data.usage.limits.maxCourses} />
              <Link href="/academy/settings" className="text-sm text-brand hover:underline">
                View full usage in Settings →
              </Link>
            </div>
          ) : (
            <EmptyState message="Usage has not been calculated yet." icon={<Icon name="bar_chart" />} />
          )}
        </Section>
      )}
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const barColorClass = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-success";
  return (
    <div>
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-app">
        <div
          className={`h-1.5 rounded-full transition-[width] duration-300 ${barColorClass}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
