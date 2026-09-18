import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAcademyDashboardData } from "@/lib/academies/dashboard";
import { Card, EmptyState, ErrorMessage, StatCard, StatusBadge } from "@/app/academy/_shell/ui";
import { color, spacing } from "@/lib/ui/theme";

const PAYMENT_STATUS_TONE = {
  pending_approval: "amber",
  approved: "green",
  rejected: "red",
  reversed: "slate",
} as const;

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

/**
 * DESIGN.md §9.1 — replaces the Item 28 placeholder shell
 * (`app/academy/dashboard/page.tsx`'s original "future items will add real
 * content here" comment). All data comes from
 * `lib/academies/dashboard.ts`'s `getAcademyDashboardData`, which itself
 * only calls already-existing, already-gated report/summary functions — see
 * that file's module comment.
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
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      <div>
        <h1 style={{ margin: 0, color: color.text }}>Dashboard</h1>
        <p style={{ margin: 0, marginTop: spacing.xxs, color: color.textMuted }}>
          Overview of your academy performance.
        </p>
      </div>

      {data.alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
          {data.alerts.map((alert, index) => (
            <div
              key={index}
              role="status"
              style={{
                borderRadius: 8,
                padding: `${spacing.xs} ${spacing.sm}`,
                backgroundColor: alert.tone === "red" ? color.statusRedBg : color.statusAmberBg,
                color: alert.tone === "red" ? color.statusRed : color.statusAmber,
                fontSize: "0.85rem",
              }}
            >
              {alert.message}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: spacing.md,
        }}
      >
        {data.totalStudents !== null && <StatCard label="Total Students" value={data.totalStudents} />}
        {data.activeStaffCount !== null && <StatCard label="Staff" value={data.activeStaffCount} />}
        {data.upcomingExamsCount !== null && (
          <StatCard label="Upcoming Exams" value={data.upcomingExamsCount} />
        )}
        {data.pendingApprovalsCount !== null && (
          <StatCard label="Pending Approvals" value={data.pendingApprovalsCount} />
        )}
        {data.finance && (
          <StatCard
            label="Outstanding Charges"
            value={data.finance.outstandingCharges.count}
            hint={data.finance.outstandingCharges.totalsByCurrency
              .map((row) => formatMoney(row.amountCents, row.currency))
              .join(", ") || undefined}
          />
        )}
      </div>

      <Card>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Recent payments</h2>
        {data.recentPayments === null ? (
          <EmptyState message="You don't have permission to view payments." />
        ) : data.recentPayments.length === 0 ? (
          <EmptyState message="No payments recorded yet." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: `1px solid ${color.border}` }}>
                <th style={{ padding: "0.4rem 0" }}>Student</th>
                <th style={{ padding: "0.4rem 0" }}>Amount</th>
                <th style={{ padding: "0.4rem 0" }}>Date</th>
                <th style={{ padding: "0.4rem 0" }}>Method</th>
                <th style={{ padding: "0.4rem 0" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentPayments.map((payment) => (
                <tr key={payment.id} style={{ borderBottom: `1px solid ${color.border}` }}>
                  <td style={{ padding: "0.4rem 0" }}>{payment.studentName}</td>
                  <td style={{ padding: "0.4rem 0" }}>{formatMoney(payment.amountCents, payment.currency)}</td>
                  <td style={{ padding: "0.4rem 0" }}>{payment.receivedAt.toLocaleDateString()}</td>
                  <td style={{ padding: "0.4rem 0" }}>{payment.method.replace("_", " ")}</td>
                  <td style={{ padding: "0.4rem 0" }}>
                    <StatusBadge label={payment.status.replace("_", " ")} tone={PAYMENT_STATUS_TONE[payment.status]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {data.usage && (
        <Card>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Usage</h2>
          {data.usage.metrics && data.usage.limits ? (
            <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
              <UsageBar
                label="Students"
                used={data.usage.metrics.activeStudentsCount}
                limit={data.usage.limits.maxStudents}
              />
              <UsageBar label="Staff" used={data.usage.metrics.activeStaffCount} limit={data.usage.limits.maxStaff} />
              <UsageBar label="Branches" used={data.usage.metrics.branchCount} limit={data.usage.limits.maxBranches} />
              <UsageBar label="Courses" used={data.usage.metrics.courseCount} limit={data.usage.limits.maxCourses} />
              <Link href="/academy/settings" style={{ color: color.primaryBlue, fontSize: "0.85rem" }}>
                View full usage in Settings →
              </Link>
            </div>
          ) : (
            <EmptyState message="Usage has not been calculated yet." />
          )}
        </Card>
      )}
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const barColor = ratio >= 1 ? color.statusRed : ratio >= 0.8 ? color.statusAmber : color.statusGreen;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: color.textMuted }}>
        <span>{label}</span>
        <span>
          {used} / {limit}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, backgroundColor: color.statusGrayBg, marginTop: 4 }}>
        <div style={{ height: 6, borderRadius: 3, width: `${ratio * 100}%`, backgroundColor: barColor }} />
      </div>
    </div>
  );
}
