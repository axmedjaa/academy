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
  LinkButton,
  PAGE_WRAP,
  PageHeader,
  Section,
  StatCard,
  TableWrap,
  UsageBar,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

// Same convention as app/academy/students/students-list.tsx and
// app/academy/staff/staff-table.tsx's own local copies — a tiny, pure
// per-file helper, not worth centralizing for a third call site.
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
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
 *
 * Impeccable audit pass (design-language-reference wave): wrapped in
 * `PAGE_WRAP` and moved `PageHeader` out of the section-spacing flex
 * container — every other converted `/academy/*` page puts `PageHeader`
 * directly in `PAGE_WRAP` with no enclosing `gap-*` wrapper (its own
 * `mb-6` already supplies that spacing); this page previously doubled it
 * and was the one page never capped to `PAGE_WRAP`'s width. Stat grid
 * switched from a fixed `sm:grid-cols-2 lg:grid-cols-4` to
 * `auto-fit, minmax(220px, 1fr)` so a 5th card never dangles alone on its
 * own row — the column count is now whatever actually fits, for whatever
 * number of cards a given role sees. Alerts gained an icon (DESIGN.md §1:
 * "color + icon + text, never color alone") and, where `lib/academies/
 * dashboard.ts` attaches an unambiguous `href`, are now clickable through
 * to the relevant page. Recent Payments gained a "View all" link to
 * Finance and a per-row link to the student's own profile (using
 * `studentId`, now included in `RecentPaymentRow`) with the same
 * avatar-initial treatment Students/Staff already use. The local
 * `UsageBar` moved to `@/app/academy/_shell/ui` as a small reusable
 * component (same markup, no visual change) rather than a one-off. No
 * data-fetching, permission, or route logic changed anywhere in this pass.
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
    <div className={PAGE_WRAP}>
      <PageHeader title="Dashboard" description="Overview of your academy performance." />

      <div className="flex flex-col gap-6">
        {data.alerts.length > 0 && (
          <div className="flex flex-col gap-2">
            {data.alerts.map((alert, index) => {
              const toneClass = alert.tone === "red" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning";
              const content = (
                <>
                  <Icon name="warning" />
                  <span>{alert.message}</span>
                </>
              );
              return alert.href ? (
                <Link
                  key={index}
                  href={alert.href}
                  role="status"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm no-underline transition-colors duration-150 motion-safe:active:scale-[0.99] hover:brightness-95 ${toneClass}`}
                >
                  {content}
                </Link>
              ) : (
                <div key={index} role="status" className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${toneClass}`}>
                  {content}
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {data.totalStudents !== null && (
            <StatCard
              label="Total Students"
              value={data.totalStudents}
              icon={<Icon name="group" />}
              index={0}
              href="/academy/students"
            />
          )}
          {data.activeStaffCount !== null && (
            <StatCard label="Staff" value={data.activeStaffCount} icon={<Icon name="badge" />} index={1} href="/academy/staff" />
          )}
          {data.upcomingExamsCount !== null && (
            <StatCard
              label="Upcoming Exams"
              value={data.upcomingExamsCount}
              icon={<Icon name="fact_check" />}
              index={2}
              href="/academy/exams"
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
              href="/academy/finance"
            />
          )}
        </div>

        <Section>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Recent payments</h2>
            {data.recentPayments !== null && data.recentPayments.length > 0 && (
              <LinkButton href="/academy/finance" variant="secondary">
                View all
              </LinkButton>
            )}
          </div>
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
                      <td className={td}>
                        <Link
                          href={`/academy/students/${payment.studentId}`}
                          className="flex items-center gap-3 font-medium text-ink no-underline hover:text-brand"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">
                            {getInitials(payment.studentName)}
                          </span>
                          {payment.studentName}
                        </Link>
                      </td>
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
    </div>
  );
}
