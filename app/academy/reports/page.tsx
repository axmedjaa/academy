import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getStudentReports, type StudentReportsData } from "@/lib/academies/student-reports";
import { getAcademicReports, type AcademicReportsData } from "@/lib/academies/academic-reports";
import { getFinanceReports } from "@/lib/academies/finance-reports";
import { FinanceReportsView } from "@/app/academy/finance-reports/finance-reports-view";

/**
 * PLAN.md Phase 5, Item 61a — `/academy/reports` hub (DESIGN.md §9.9: "hub
 * with Student/Academic/Finance sub-views, each: filter bar + table + a
 * simple chart only where the data is genuinely aggregate/trend... chart
 * never replaces the table. Export button (§11.6 scope)").
 *
 * ---------------------------------------------------------------------
 * Export button: deliberately NOT built here
 * ---------------------------------------------------------------------
 * PLAN.md Item 60 (`exportData` + export UI) is a separate, not-yet-built
 * item this task is explicitly told not to touch. Below is a clearly
 * labeled placeholder comment at the one spot the button would go, per the
 * task brief's "leave a clearly-commented placeholder or simply omit it"
 * instruction — no export UI, no client wiring, nothing that would need
 * undoing when Item 60 lands.
 *
 * ---------------------------------------------------------------------
 * Finance tab: reuse, not duplicate — and NOT a replacement for
 * `/academy/finance-reports`
 * ---------------------------------------------------------------------
 * This tab imports and calls `getFinanceReports` directly (Item 55's own
 * aggregation, lib/academies/finance-reports.ts — untouched) and reuses
 * that item's own `FinanceReportsView` client component verbatim, exactly
 * as `app/academy/finance-reports/page.tsx` does. `/academy/finance-reports`
 * is left completely untouched by this item — this is a deliberate,
 * conservative choice for this wave: two routes now render the same
 * report, which is duplication at the *page* level only (zero duplicated
 * aggregation/query logic, which lives in exactly one place). Reconciling
 * that — e.g. turning `/academy/finance-reports` into a redirect to this
 * hub's `?tab=finance`, or vice versa — is a genuine follow-up worth doing
 * in a later wave, not resolved here, since collapsing the two routes is a
 * navigation/IA decision outside this item's scope and risk budget.
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
 * Charts: plain inline SVG, no new dependency
 * ---------------------------------------------------------------------
 * No existing page in this codebase renders a chart of any kind (grepped
 * for a charting library import — none exists in package.json either), so
 * there's no established approach to mirror. Per the task brief, this adds
 * no charting library: `EnrollmentTrendChart`/`PassRateChart` below are
 * small inline-SVG bar charts, server-rendered like the rest of this page.
 * Both sit next to (never instead of) the full data table for their
 * section, per DESIGN.md's "chart never replaces the table" rule.
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
    <main
      style={{
        maxWidth: 1100,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Reports</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Student, academic, and finance reporting for this academy.
      </p>

      <nav style={{ display: "flex", gap: "0.5rem", margin: "1rem 0", borderBottom: "1px solid #ddd" }}>
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
    </main>
  );
}

function TabLink({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <a
      href={href}
      style={{
        padding: "0.5rem 0.9rem",
        textDecoration: "none",
        color: active ? "#111" : "#666",
        borderBottom: active ? "2px solid #111" : "2px solid transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </a>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" style={{ color: "crimson" }}>
      {message}
    </p>
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
    return <ErrorBox message={result.error.message} />;
  }

  const report: StudentReportsData = result.report;

  return (
    <div>
      <FilterForm tab="student" dateFrom={dateFrom} dateTo={dateTo} branchId={branchId} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", margin: "1rem 0" }}>
        <StatCard label="Total students (matching filters)" value={report.totalStudents} />
        {report.statusBreakdown.map((row) => (
          <StatCard key={row.status} label={`Status: ${row.status}`} value={row.count} />
        ))}
      </div>

      <h3>Enrollment trend</h3>
      {/* Genuinely aggregate/trend data — chart alongside the table, never instead of it. */}
      <BarChart
        points={report.enrollmentTrend.map((p) => ({ label: p.period, value: p.count }))}
        emptyMessage="No enrollments in the selected period."
      />
      <SimpleTable
        columns={["Month", "New enrollments"]}
        rows={report.enrollmentTrend.map((p) => [p.period, String(p.count)])}
        emptyMessage="No enrollments in the selected period."
      />

      <h3 style={{ marginTop: "1.5rem" }}>Enrollment status breakdown</h3>
      <SimpleTable
        columns={["Status", "Count"]}
        rows={report.enrollmentStatusBreakdown.map((row) => [row.status, String(row.count)])}
        emptyMessage="No enrollments recorded."
      />

      <h3 style={{ marginTop: "1.5rem" }}>Branch distribution</h3>
      <SimpleTable
        columns={["Branch", "Students"]}
        rows={report.branchDistribution.map((row) => [row.branchName, String(row.count)])}
        emptyMessage="No students match these filters."
      />

      {/* Export button placeholder — PLAN.md Item 60 (exportData), a
          separate, later item this task must not build. Intentionally no
          button here yet. */}
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
    return <ErrorBox message={result.error.message} />;
  }

  const report: AcademicReportsData = result.report;

  return (
    <div>
      <FilterForm tab="academic" dateFrom={dateFrom} dateTo={dateTo} batchId={batchId} courseId={courseId} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", margin: "1rem 0" }}>
        <StatCard label="Results published" value={report.resultsPublishedCount} />
      </div>

      <h3>Pass rate by batch</h3>
      {/* Genuinely aggregate/trend data (pass/fail rate) — chart alongside the table. */}
      <BarChart
        points={report.passFailByBatch.map((row) => ({
          label: row.batchName,
          value: row.passRate === null ? 0 : Math.round(row.passRate * 100),
        }))}
        valueSuffix="%"
        emptyMessage="No published results in the selected batches."
      />
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

      <h3 style={{ marginTop: "1.5rem" }}>Grade distribution</h3>
      <SimpleTable
        columns={["Grade band", "Count"]}
        rows={report.gradeDistribution.map((row) => [row.gradeBandLabel, String(row.count)])}
        emptyMessage="No published, graded results match these filters."
      />

      {/* Export button placeholder — PLAN.md Item 60 (exportData), a
          separate, later item this task must not build. Intentionally no
          button here yet. */}
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
    return <ErrorBox message={result.error.message} />;
  }

  return (
    <div>
      <p style={{ color: "#666", fontSize: "0.85rem" }}>
        Outstanding charges, payments received, income vs. expenses. Never
        includes platform subscription billing (§9.6). This is the same
        report as{" "}
        <a href="/academy/finance-reports">/academy/finance-reports</a> —
        both routes coexist for now (see this page&apos;s module comment).
      </p>
      <FinanceReportsView initialReport={result.report} />
      {/* Export button placeholder — PLAN.md Item 60 (exportData), a
          separate, later item this task must not build. Intentionally no
          button here yet. */}
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
    <form
      method="get"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem",
        alignItems: "flex-end",
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem",
      }}
    >
      <input type="hidden" name="tab" value={tab} />
      <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
        From
        <input type="date" name="dateFrom" defaultValue={dateFrom} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
        To
        <input type="date" name="dateTo" defaultValue={dateTo} />
      </label>
      {tab === "student" && (
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Branch ID
          <input type="text" name="branchId" defaultValue={branchId} placeholder="(optional)" />
        </label>
      )}
      {tab === "academic" && (
        <>
          <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
            Batch ID
            <input type="text" name="batchId" defaultValue={batchId} placeholder="(optional)" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
            Course ID
            <input type="text" name="courseId" defaultValue={courseId} placeholder="(optional)" />
          </label>
        </>
      )}
      <button type="submit">Filter</button>
      <a href={`?tab=${tab}`} style={{ fontSize: "0.85rem" }}>
        Reset
      </a>
    </form>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem" }}>
      <div style={{ color: "#666", fontSize: "0.8rem" }}>{label}</div>
      <div style={{ fontSize: "1.5rem" }}>{value}</div>
    </div>
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
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.4rem 0" }}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} style={{ padding: "0.5rem 0", color: "#777" }}>
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "0.4rem 0", borderBottom: "1px solid #f0f0f0" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * Minimal inline-SVG bar chart — no charting library dependency (none
 * exists in this codebase's package.json). Purely presentational, next to
 * (never instead of) the data table for the same section, per DESIGN.md's
 * "chart never replaces the table" rule.
 */
function BarChart({
  points,
  emptyMessage,
  valueSuffix = "",
}: {
  points: { label: string; value: number }[];
  emptyMessage: string;
  valueSuffix?: string;
}) {
  if (points.length === 0) {
    return <p style={{ color: "#777" }}>{emptyMessage}</p>;
  }

  const width = 640;
  const height = 160;
  const barGap = 8;
  const barWidth = Math.max(8, width / points.length - barGap);
  const maxValue = Math.max(1, ...points.map((p) => p.value));

  return (
    <svg
      viewBox={`0 0 ${width} ${height + 24}`}
      role="img"
      aria-label="Chart"
      style={{ width: "100%", maxWidth: width, height: "auto", display: "block" }}
    >
      {points.map((point, i) => {
        const barHeight = (point.value / maxValue) * height;
        const x = i * (barWidth + barGap);
        const y = height - barHeight;
        return (
          <g key={point.label}>
            <rect x={x} y={y} width={barWidth} height={barHeight} fill="#4f7cff" rx={2} />
            <text x={x + barWidth / 2} y={height + 14} fontSize="9" textAnchor="middle" fill="#666">
              {point.label.length > 8 ? `${point.label.slice(0, 7)}…` : point.label}
            </text>
            <text x={x + barWidth / 2} y={y - 4} fontSize="9" textAnchor="middle" fill="#333">
              {point.value}
              {valueSuffix}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
