import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getStudentReports, type StudentReportsData } from "@/lib/academies/student-reports";
import { getAcademicReports, type AcademicReportsData } from "@/lib/academies/academic-reports";
import { getFinanceReports } from "@/lib/academies/finance-reports";
import { FinanceReportsView } from "@/app/academy/finance-reports/finance-reports-view";
import { ReportExportButton } from "./report-export-button";
import { BarChart, TrendAreaChart } from "@/app/academy/_shell/charts";
import { color } from "@/lib/ui/theme";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Field,
  PAGE_WRAP,
  PageHeader,
  Section,
  StatCard,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";

/** `enrollmentTrend`'s period is stored as a plain "YYYY-MM" string (see
 * student-reports.ts) — fine for a table cell, but a raw "2025-03" reads
 * worse as a chart axis label than a short month name. Display-only; the
 * table above keeps the raw string unchanged. */
function formatMonthPeriod(period: string): string {
  const [year, month] = period.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return period;
  return parsed.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

/**
 * PLAN.md Phase 5, Item 61a — `/academy/reports` hub (DESIGN.md §9.9: "hub
 * with Student/Academic/Finance sub-views, each: filter bar + table + a
 * simple chart only where the data is genuinely aggregate/trend... chart
 * never replaces the table. Export button (§11.6 scope)").
 *
 * ---------------------------------------------------------------------
 * Export button (PLAN.md Item 60)
 * ---------------------------------------------------------------------
 * Each tab renders a real Export CSV button, wired through
 * `lib/export/export-data-actions.ts` -> `lib/export/export-data.ts`'s
 * `exportData`, reusing this SAME tab's already-fetched filters (never a
 * second, separately-filtered query) — see `ReportExportButton`
 * (./report-export-button.tsx) for the Student/Academic tabs. The Finance
 * tab gets its export button for free: it renders `FinanceReportsView`
 * verbatim, and that component now has one built in.
 *

 * ---------------------------------------------------------------------
 * Finance tab — the canonical finance-reports destination
 * ---------------------------------------------------------------------
 * This tab imports and calls `getFinanceReports` directly (Item 55's own
 * aggregation, lib/academies/finance-reports.ts — untouched) and reuses
 * that item's own `FinanceReportsView` client component verbatim.
 * Navigation-audit Phase 1 made this (`?tab=finance`) the single canonical
 * place finance reports live — `/academy/finance-reports` is now a
 * compatibility redirect here (app/academy/finance-reports/page.tsx),
 * kept only so old links/bookmarks don't 404. No aggregation/query logic
 * or UI changed as part of that — only the second route pointing at it.
 *
 * ---------------------------------------------------------------------
 * Tabs, filters, pagination: plain GET-query-param navigation
 * ---------------------------------------------------------------------
 * Same convention as app/academy/audit-logs/page.tsx and
 * app/platform/audit-logs/page.tsx: a `<form method="get">` re-navigates
 * the whole page with new query params, server-rendered from scratch each
 * time — no client component needed for the Student/Academic tabs' own
 * filter bars. The Finance tab is the one exception, since it reuses
 * `FinanceReportsView` verbatim and that component already manages its own
 * client-side filter state via `getFinanceReportsAction` — mixing filter
 * mechanisms across tabs is an accepted, documented tradeoff of the "reuse,
 * don't duplicate" instruction for that tab specifically.
 *
 * ---------------------------------------------------------------------
 * Charts: shared primitives, no new dependency
 * ---------------------------------------------------------------------
 * `TrendAreaChart`/`BarChart` (app/academy/_shell/charts.tsx) are plain
 * inline-SVG, server-rendered like the rest of this page — no charting
 * library (none exists in package.json). Enrollment trend (a genuine time
 * series) uses the smooth gradient-area line chart; pass rate by batch
 * (categorical) uses the bar chart. Both sit next to (never instead of) the
 * full data table for their section, per DESIGN.md's "chart never replaces
 * the table" rule.
 */
export default async function AcademyReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };

  const tabParam = get("tab");
  const tab: "student" | "academic" | "finance" =
    tabParam === "academic" || tabParam === "finance" ? tabParam : "student";

  const dateFrom = get("dateFrom");
  const dateTo = get("dateTo");
  const branchId = get("branchId");
  const batchId = get("batchId");
  const courseId = get("courseId");

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Reports" description="Student, academic, and finance reporting for this academy." />

      <nav className="mb-5 inline-flex gap-1 rounded-control border border-border bg-surface p-1">
        <TabLink label="Student" href="?tab=student" active={tab === "student"} />
        <TabLink label="Academic" href="?tab=academic" active={tab === "academic"} />
        <TabLink label="Finance" href="?tab=finance" active={tab === "finance"} />
      </nav>

      {tab === "student" && (
        <StudentTab
          context={context}
          dateFrom={dateFrom}
          dateTo={dateTo}
          branchId={branchId}
        />
      )}
      {tab === "academic" && (
        <AcademicTab
          context={context}
          dateFrom={dateFrom}
          dateTo={dateTo}
          batchId={batchId}
          courseId={courseId}
        />
      )}
      {tab === "finance" && <FinanceTab context={context} />}
    </div>
  );
}

function TabLink({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <a
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.98] ${
        active ? "bg-brand text-white" : "text-muted hover:bg-app hover:text-ink"
      }`}
    >
      {label}
    </a>
  );
}

// ---------------------------------------------------------------------
// Student tab
// ---------------------------------------------------------------------

async function StudentTab({
  context,
  dateFrom,
  dateTo,
  branchId,
}: {
  context: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
  dateFrom: string;
  dateTo: string;
  branchId: string;
}) {
  const result = await getStudentReports(context, {
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    branchId: branchId || undefined,
  });

  if (!result.ok) {
    return <ErrorMessage message={result.error.message} />;
  }

  const report: StudentReportsData = result.report;

  return (
    <div className="flex flex-col gap-6">
      <FilterForm tab="student" dateFrom={dateFrom} dateTo={dateTo} branchId={branchId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total students (matching filters)" value={report.totalStudents} />
        {report.statusBreakdown.map((row) => (
          <StatCard key={row.status} label={`Status: ${row.status}`} value={row.count} />
        ))}
      </div>

      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Enrollment trend</h3>
        {/* Genuinely aggregate/trend data — chart alongside the table, never instead of it. */}
        <Section className="mb-3">
          <TrendAreaChart
            id="enrollment-trend"
            points={report.enrollmentTrend.map((p) => ({
              label: formatMonthPeriod(p.period),
              value: p.count,
            }))}
            ariaLabel="New enrollments per month"
            emptyMessage="No enrollments in the selected period."
          />
        </Section>
        <SimpleTable
          columns={["Month", "New enrollments"]}
          rows={report.enrollmentTrend.map((p) => [p.period, String(p.count)])}
          emptyMessage="No enrollments in the selected period."
        />
      </div>

      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Enrollment status breakdown</h3>
        <SimpleTable
          columns={["Status", "Count"]}
          rows={report.enrollmentStatusBreakdown.map((row) => [row.status, String(row.count)])}
          emptyMessage="No enrollments recorded."
        />
      </div>

      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Branch distribution</h3>
        <SimpleTable
          columns={["Branch", "Students"]}
          rows={report.branchDistribution.map((row) => [row.branchName, String(row.count)])}
          emptyMessage="No students match these filters."
        />
      </div>

      <ReportExportButton
        kind="student"
        filters={{ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, branchId: branchId || undefined }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Academic tab
// ---------------------------------------------------------------------

async function AcademicTab({
  context,
  dateFrom,
  dateTo,
  batchId,
  courseId,
}: {
  context: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
  dateFrom: string;
  dateTo: string;
  batchId: string;
  courseId: string;
}) {
  const result = await getAcademicReports(context, {
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    batchId: batchId || undefined,
    courseId: courseId || undefined,
  });

  if (!result.ok) {
    return <ErrorMessage message={result.error.message} />;
  }

  const report: AcademicReportsData = result.report;

  return (
    <div className="flex flex-col gap-6">
      <FilterForm tab="academic" dateFrom={dateFrom} dateTo={dateTo} batchId={batchId} courseId={courseId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Results published" value={report.resultsPublishedCount} />
      </div>

      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Pass rate by batch</h3>
        {/* Genuinely aggregate/trend data (pass/fail rate) — chart alongside the table. */}
        <Section className="mb-3">
          <BarChart
            id="pass-rate-by-batch"
            series={[{ name: "Pass rate", color: color.primaryBlue }]}
            groups={report.passFailByBatch.map((row) => ({
              label: row.batchName,
              values: [
                {
                  label: row.batchName,
                  value: row.passRate === null ? 0 : Math.round(row.passRate * 100),
                  display: row.passRate === null ? "—" : `${Math.round(row.passRate * 100)}%`,
                },
              ],
            }))}
            ariaLabel="Pass rate by batch"
            emptyMessage="No published results in the selected batches."
            formatAxisValue={(value) => `${value}%`}
          />
        </Section>
        <SimpleTable
          columns={["Batch", "Course", "Pass", "Fail", "Pending", "Pass rate"]}
          rows={report.passFailByBatch.map((row) => [
            row.batchName,
            row.courseName,
            String(row.passCount),
            String(row.failCount),
            String(row.pendingCount),
            row.passRate === null ? "—" : `${Math.round(row.passRate * 100)}%`,
          ])}
          emptyMessage="No published results match these filters."
        />
      </div>

      <div>
        <h3 className="mb-2 text-base font-semibold text-ink">Grade distribution</h3>
        <SimpleTable
          columns={["Grade band", "Count"]}
          rows={report.gradeDistribution.map((row) => [row.gradeBandLabel, String(row.count)])}
          emptyMessage="No published, graded results match these filters."
        />
      </div>

      <ReportExportButton
        kind="academic"
        filters={{
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          batchId: batchId || undefined,
          courseId: courseId || undefined,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Finance tab — reuses Item 55's getFinanceReports + FinanceReportsView
// verbatim (see this file's top comment for the duplication-vs-redirect
// judgment call).
// ---------------------------------------------------------------------

async function FinanceTab({
  context,
}: {
  context: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;
}) {
  const result = await getFinanceReports(context, {});

  if (!result.ok) {
    return <ErrorMessage message={result.error.message} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Outstanding charges, payments received, income vs. expenses. Never
        includes platform subscription billing (§9.6).
      </p>
      <FinanceReportsView initialReport={result.report} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Shared filter form (Student/Academic tabs only — Finance reuses its own
// client-side filter bar via FinanceReportsView).
// ---------------------------------------------------------------------

function FilterForm({
  tab,
  dateFrom,
  dateTo,
  branchId,
  batchId,
  courseId,
}: {
  tab: "student" | "academic";
  dateFrom: string;
  dateTo: string;
  branchId?: string;
  batchId?: string;
  courseId?: string;
}) {
  return (
    <Section>
      {/* Mobile-first: each field is full-width and stacks on a narrow
       * phone (a 140-160px min-width field left a wide blank gap to its
       * right at that size) — reverting to the original fixed widths,
       * laid out in a row, once there's room to spare at `sm:`. */}
      <form method="get" className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <input type="hidden" name="tab" value={tab} />
        <Field label="From" className="w-full sm:w-auto sm:min-w-[140px]">
          <input type="date" name="dateFrom" defaultValue={dateFrom} className={inputClass} />
        </Field>
        <Field label="To" className="w-full sm:w-auto sm:min-w-[140px]">
          <input type="date" name="dateTo" defaultValue={dateTo} className={inputClass} />
        </Field>
        {tab === "student" && (
          <Field label="Branch ID" className="w-full sm:w-auto sm:min-w-[160px]">
            <input type="text" name="branchId" defaultValue={branchId} placeholder="(optional)" className={inputClass} />
          </Field>
        )}
        {tab === "academic" && (
          <>
            <Field label="Batch ID" className="w-full sm:w-auto sm:min-w-[160px]">
              <input type="text" name="batchId" defaultValue={batchId} placeholder="(optional)" className={inputClass} />
            </Field>
            <Field label="Course ID" className="w-full sm:w-auto sm:min-w-[160px]">
              <input type="text" name="courseId" defaultValue={courseId} placeholder="(optional)" className={inputClass} />
            </Field>
          </>
        )}
        <div className="flex items-center gap-4 sm:gap-3">
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            Filter
          </Button>
          <a href={`?tab=${tab}`} className="shrink-0 text-sm text-brand hover:underline">
            Reset
          </a>
        </div>
      </form>
    </Section>
  );
}

function SimpleTable({
  columns,
  rows,
  emptyMessage,
}: {
  columns: string[];
  rows: string[][];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} icon={<Icon name="bar_chart" />} />;
  }

  return (
    <TableWrap>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col} className={th}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={trHover}>
            {row.map((cell, j) => (
              <td key={j} className={td}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

