import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import type { AuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getStudentReports } from "@/lib/academies/student-reports";
import { getAcademicReports } from "@/lib/academies/academic-reports";
import { getFinanceReports, type AmountByCurrency, type PaymentSource } from "@/lib/academies/finance-reports";
import { getFeeCollectionSummary, getProgramFeeCollectionSummary } from "@/lib/academies/fee-period-overview";
import { listBranches } from "@/lib/academies/branches";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import {
  ACADEMY_EXAMS_ACTION,
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_RESULTS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { formatMoney } from "@/lib/ui/money";
import { PAGE_WRAP, PageHeader, PageMessage, trHover } from "@/app/academy/_shell/ui";
import { BarList, BlockTitle, DataTable, NoteBlock, StackBar, StatRow, TabLinks, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, DateParamField, FilterBar, FilterDropdown } from "@/app/academy/_shell/filter-controls";
import { ReportExportButton } from "./report-export-button";

type ReportTab = "student" | "academic" | "finance";
const TAB_LABEL: Record<ReportTab, string> = { student: "Student", academic: "Academic", finance: "Finance" };

/** "2026-03" -> "Mar 2026" for a chart label. */
function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, 1);
  return Number.isNaN(date.getTime()) ? period : date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** 78 -> "78", 77.5 -> "77.5" (one decimal at most). */
const formatMark = (value: number) => String(Math.round(value * 10) / 10);

/** Per-currency totals as one line ("$120.00 + SOS 5,000"); never summed across currencies. */
const moneyLine = (totals: AmountByCurrency[]) =>
  totals.length ? totals.map((t) => formatMoney(t.amountCents, t.currency)).join(" + ") : formatMoney(0, "USD");
const STUDENT_PAYMENT_METHOD_ORDER = ["cash", "mobile_money", "bank_transfer"] as const;
const METHOD_LABEL: Record<(typeof STUDENT_PAYMENT_METHOD_ORDER)[number], string> = {
  cash: "Cash",
  mobile_money: "Mobile money",
  bank_transfer: "Bank transfer",
};
const centsOf = (totals: AmountByCurrency[], currency: string) => totals.find((t) => t.currency === currency)?.amountCents ?? 0;
const SOURCE_LABEL: Record<PaymentSource, string> = {
  program: "Program fees",
  course: "Course fees",
  other: "Charges and other",
};
const SOURCE_ORDER: PaymentSource[] = ["program", "course", "other"];

/**
 * Reports (design A15): Student, Academic and Finance summaries as pill
 * tabs (`?tab=`), each with summary cards, charts, a detail table and URL
 * filters, and Export CSV in the header (the audited export for the open
 * tab, with the same filters). A tab appears only for roles that can read
 * that report — the same rules the report functions enforce themselves.
 */
export default async function AcademyReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") return <PageMessage title="Access unavailable" message={access.message} />;
  const role = access.membershipRole;
  const level = (action: string) => getAcademyPermissionLevel(role, action);

  const tabs: ReportTab[] = [];
  if (level(ACADEMY_STUDENTS_ACTION) !== "none") tabs.push("student");
  const exams = level(ACADEMY_EXAMS_ACTION);
  if (exams === "full" || exams === "manage" || exams === "enter_marks" || level(ACADEMY_RESULTS_ACTION) === "approve") tabs.push("academic");
  if ([ACADEMY_STUDENT_PAYMENTS_ACTION, ACADEMY_INCOME_ACTION, ACADEMY_EXPENSES_ACTION].some((a) => level(a) !== "none")) tabs.push("finance");
  if (tabs.length === 0) return <PageMessage title="Access denied" message="You don't have permission to view reports." />;

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const tab: ReportTab = tabs.includes(get("tab") as ReportTab) ? (get("tab") as ReportTab) : tabs[0];
  const dateFrom = get("dateFrom") || undefined;
  const dateTo = get("dateTo") || undefined;

  const filters =
    tab === "student"
      ? { dateFrom, dateTo, branchId: get("branchId") || undefined }
      : tab === "academic"
        ? { dateFrom, dateTo, batchId: get("batchId") || undefined, courseId: get("courseId") || undefined }
        : { dateFrom, dateTo, method: get("method") || undefined };

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Reports"
        description="Summaries built from the records in this academy. Every export is logged."
        actions={<ReportExportButton kind={tab} filters={filters} />}
      />
      <TabLinks
        label="Report sections"
        current={tab}
        tabs={tabs.map((key) => ({ key, label: TAB_LABEL[key], href: `/academy/reports?tab=${key}` }))}
      />
      {tab === "student" && <StudentReport context={context} filters={filters as { dateFrom?: string; dateTo?: string; branchId?: string }} />}
      {tab === "academic" && (
        <AcademicReport context={context} filters={filters as { dateFrom?: string; dateTo?: string; batchId?: string; courseId?: string }} />
      )}
      {tab === "finance" && <FinanceReport context={context} filters={filters as { dateFrom?: string; dateTo?: string; method?: string }} />}
    </div>
  );
}

function DateFilters({ extra, params }: { extra?: React.ReactNode; params: string[] }) {
  return (
    <FilterBar>
      {extra}
      <DateParamField param="dateFrom" label="From" />
      <DateParamField param="dateTo" label="To" />
      <ClearFilters params={["dateFrom", "dateTo", ...params]} />
    </FilterBar>
  );
}

/* ------------------------------------------------------------------ */

async function StudentReport({ context, filters }: { context: AuthContext; filters: { dateFrom?: string; dateTo?: string; branchId?: string } }) {
  const [result, branchesResult] = await Promise.all([getStudentReports(context, filters), listBranches(context)]);
  if (!result.ok) return <PageMessage title="Report unavailable" message={result.error.message} />;
  const report = result.report;
  const branches = branchesResult.ok ? branchesResult.branches : [];
  const statusCount = (status: string) => report.statusBreakdown.find((row) => row.status === status)?.count ?? 0;

  return (
    <>
      <DateFilters
        params={["branchId"]}
        extra={
          branches.length > 1 ? (
            <FilterDropdown
              param="branchId"
              label="Branch"
              icon="apartment"
              options={[{ value: "", label: "All branches" }, ...branches.map((b) => ({ value: b.id, label: b.name }))]}
            />
          ) : null
        }
      />
      <StatRow
        items={[
          { label: "Total students", value: report.totalStudents, hint: `${statusCount("active")} active, ${statusCount("archived")} archived`, icon: "group" },
          { label: "Applied", value: report.studentStatus.applied, hint: "no active enrollment", icon: "badge" },
          { label: "Enrolled", value: report.studentStatus.enrolled, hint: "in at least one course now", icon: "school" },
        ]}
      />
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BarList
          title="Enrollment by batch"
          sub={`Students with an active enrollment${report.enrollmentByBatch.length > 10 ? ", top 10 batches" : ""}`}
          rows={report.enrollmentByBatch.slice(0, 10).map((row) => ({ label: row.batchCode, value: row.activeStudents, text: String(row.activeStudents) }))}
          empty="No batches in view."
        />
        <StackBar
          title="Student status"
          sub="All students in view"
          segments={[
            { label: "Enrolled", value: report.studentStatus.enrolled, text: String(report.studentStatus.enrolled) },
            { label: "Applied", value: report.studentStatus.applied, text: String(report.studentStatus.applied) },
            { label: "Archived", value: report.studentStatus.archived, text: String(report.studentStatus.archived) },
          ]}
          empty="No students match these filters."
        />
      </div>
      <BlockTitle>Detail by batch</BlockTitle>
      <DataTable stackBelow={600}>
        <thead>
          <tr>
            <th className={rtTh}>Batch</th>
            <th className={rtTh}>Branch</th>
            <th className={`${rtTh} text-right`}>Enrolled</th>
          </tr>
        </thead>
        <tbody>
          {report.enrollmentByBatch.length === 0 ? (
            <tr>
              <td colSpan={3} className={`${rtTd} text-center text-muted`}>
                No batches in view.
              </td>
            </tr>
          ) : (
            report.enrollmentByBatch.map((row) => (
              <tr key={row.batchId} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Batch">
                  {row.batchCode}
                  {row.courseNames.length ? `, ${row.courseNames[0]}${row.courseNames.length > 1 ? ` +${row.courseNames.length - 1}` : ""}` : ""}
                </td>
                <td className={rtTd} data-label="Branch">
                  {row.branchName}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Enrolled">
                  {row.activeStudents}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
      <NoteBlock>Dates filter by registration date. Enrolled means at least one active enrollment; applied means active with none yet. Counts include only students you can see.</NoteBlock>
    </>
  );
}

/* ------------------------------------------------------------------ */

async function AcademicReport({
  context,
  filters,
}: {
  context: AuthContext;
  filters: { dateFrom?: string; dateTo?: string; batchId?: string; courseId?: string };
}) {
  const [result, batchesResult, coursesResult] = await Promise.all([
    getAcademicReports(context, filters),
    listBatches(context),
    listCourses(context),
  ]);
  if (!result.ok) return <PageMessage title="Report unavailable" message={result.error.message} />;
  const report = result.report;

  return (
    <>
      <DateFilters
        params={["batchId", "courseId"]}
        extra={
          <>
            <FilterDropdown
              param="batchId"
              label="Batch"
              icon="layers"
              options={[
                { value: "", label: "All batches" },
                ...(batchesResult.ok ? batchesResult.batches : []).map((b) => ({ value: b.id, label: `${b.code} · ${b.name}` })),
              ]}
            />
            <FilterDropdown
              param="courseId"
              label="Course"
              icon="menu_book"
              options={[{ value: "", label: "All courses" }, ...(coursesResult.ok ? coursesResult.courses : []).map((c) => ({ value: c.id, label: c.name }))]}
            />
          </>
        }
      />
      <StatRow
        items={[
          { label: "Results entered", value: report.resultsEnteredCount, hint: "any status", icon: "fact_check" },
          { label: "Published", value: report.resultsPublishedCount, icon: "fact_check" },
          {
            label: "Passed",
            value: report.resultsPassedCount,
            hint: report.resultsPublishedCount
              ? `${Math.round((report.resultsPassedCount / report.resultsPublishedCount) * 100)}% of published`
              : "none published",
            icon: "workspace_premium",
          },
        ]}
      />
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BarList
          title="Grade distribution"
          sub="Published results by grade"
          rows={report.gradeDistribution.map((row) => ({ label: row.gradeBandLabel, value: row.count, text: String(row.count), muted: row.failing }))}
          empty="No published, graded results match these filters."
        />
        <BarList
          title="Average mark by exam"
          sub="Published results only, out of the maximum"
          rows={report.byExam.map((row) => ({
            label: `${row.examName}, ${row.batchCode}`,
            value: row.averageMarks === null || row.maxMarks <= 0 ? 0 : (row.averageMarks / row.maxMarks) * 100,
            text: row.averageMarks === null ? "No published results" : `${formatMark(row.averageMarks)} / ${formatMark(row.maxMarks)}`,
          }))}
          empty="No exams match these filters."
        />
      </div>
      <BlockTitle>Detail by exam</BlockTitle>
      <DataTable stackBelow={760}>
        <thead>
          <tr>
            <th className={rtTh}>Exam</th>
            <th className={`${rtTh} text-right`}>Results</th>
            <th className={`${rtTh} text-right`}>Published</th>
            <th className={`${rtTh} text-right`}>Average</th>
            <th className={`${rtTh} text-right`}>Passed</th>
          </tr>
        </thead>
        <tbody>
          {report.byExam.length === 0 ? (
            <tr>
              <td colSpan={5} className={`${rtTd} text-center text-muted`}>
                No exams match these filters.
              </td>
            </tr>
          ) : (
            report.byExam.map((row) => (
              <tr key={row.examId} className={trHover}>
                <td className={rtTd} data-label="Exam">
                  <span className="block font-semibold">
                    {row.examName}, {row.batchCode}
                  </span>
                  <span className="block text-xs text-muted">{row.courseName}</span>
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Results">
                  {row.enteredCount}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Published">
                  {row.publishedCount}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Average">
                  {row.averageMarks === null ? "-" : formatMark(row.averageMarks)}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Passed">
                  {row.passedCount}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
      <NoteBlock>Results entered counts every result in any status. Published figures and grades count published results only, graded with the configuration each was published with.</NoteBlock>
    </>
  );
}

/* ------------------------------------------------------------------ */

async function FinanceReport({ context, filters }: { context: AuthContext; filters: { dateFrom?: string; dateTo?: string; method?: string } }) {
  const method = STUDENT_PAYMENT_METHOD_ORDER.find((m) => m === filters.method);
  const [result, feeCollection, programCollection] = await Promise.all([
    getFinanceReports(context, { dateFrom: filters.dateFrom, dateTo: filters.dateTo, method }),
    getFeeCollectionSummary(context),
    getProgramFeeCollectionSummary(context),
  ]);
  if (!result.ok) return <PageMessage title="Report unavailable" message={result.error.message} />;
  const { studentPayments, income, expenses } = result.report;
  const currencies = [
    ...new Set([
      ...(studentPayments.visible ? [...studentPayments.paymentsReceived.totalsByCurrency, ...studentPayments.outstandingCharges.totalsByCurrency] : []),
      ...(income.visible ? income.totalsByCurrency : []),
      ...(expenses.visible ? expenses.totalsByCurrency : []),
    ].map((t) => t.currency)),
  ];
  const main = currencies[0] ?? "USD";
  const inMain = currencies.length > 1 ? `, in ${main}` : "";
  // Shown whenever fee periods are readable (empty when nothing is scheduled).
  const fee = feeCollection.ok
    ? (feeCollection.totals.find((t) => t.currency === main) ??
      feeCollection.totals[0] ?? { currency: main, collectedCents: 0, overdueCents: 0, notYetDueCents: 0 })
    : null;
  // Complete-program installments (the one program fee) are reported apart
  // from course fee periods, which `fee` above covers; no installment is in both.
  const programFee =
    programCollection.ok && programCollection.totals.length > 0
      ? (programCollection.totals.find((t) => t.currency === main) ?? programCollection.totals[0])
      : null;
  const programRows = programCollection.ok ? programCollection.byProgram : [];
  const bySource = studentPayments.visible
    ? SOURCE_ORDER.map((source) => {
        const row = studentPayments.paymentsReceived.bySource.find((r) => r.source === source && r.currency === main);
        return { source, amountCents: row?.amountCents ?? 0, count: row?.count ?? 0 };
      })
    : [];
  const programPayments = bySource.find((row) => row.source === "program") ?? { amountCents: 0, count: 0 };
  const byMonth = studentPayments.visible ? studentPayments.paymentsReceived.byMonth.filter((row) => row.currency === main) : [];
  const byMethod = studentPayments.visible
    ? STUDENT_PAYMENT_METHOD_ORDER.map((m) => ({
        method: m,
        amountCents: studentPayments.paymentsReceived.byMethod.find((row) => row.method === m && row.currency === main)?.amountCents ?? 0,
      }))
    : [];

  return (
    <>
      <DateFilters
        params={["method"]}
        extra={
          studentPayments.visible ? (
            <FilterDropdown
              param="method"
              label="Payment method"
              icon="payments"
              options={[
                { value: "", label: "Any method" },
                { value: "cash", label: "Cash" },
                { value: "mobile_money", label: "Mobile money" },
                { value: "bank_transfer", label: "Bank transfer" },
              ]}
            />
          ) : null
        }
      />
      <StatRow
        items={[
          ...(studentPayments.visible
            ? [
                {
                  label: "Student payments",
                  value: moneyLine(studentPayments.paymentsReceived.totalsByCurrency),
                  hint: `${studentPayments.paymentsReceived.count} posted`,
                  icon: "payments",
                },
                ...(programPayments.amountCents > 0 || programFee
                  ? [
                      {
                        label: "Program fee payments",
                        value: formatMoney(programPayments.amountCents, main),
                        hint: `${programPayments.count} of the student payments`,
                        icon: "school",
                      },
                    ]
                  : []),
                ...(studentPayments.refundsRecorded.count > 0
                  ? [
                      {
                        label: "Refunds",
                        value: moneyLine(studentPayments.refundsRecorded.totalsByCurrency),
                        hint: (() => {
                          const program = studentPayments.refundsRecorded.bySource.filter((r) => r.source === "program").reduce((n, r) => n + r.count, 0);
                          const total = studentPayments.refundsRecorded.count;
                          return program > 0 ? `${total} on withdrawal, ${program} from programs` : `${total} recorded on withdrawal`;
                        })(),
                        icon: "autorenew",
                      },
                    ]
                  : []),
              ]
            : []),
          ...(income.visible
            ? [{ label: "Income", value: moneyLine(income.totalsByCurrency), hint: "posted, including book sales", icon: "bank" }]
            : []),
          ...(expenses.visible
            ? [
                { label: "Expenses", value: moneyLine(expenses.totalsByCurrency), hint: "approved only", icon: "receipt_long" },
                { label: "Pending expense approvals", value: expenses.pendingApprovalsCount, icon: "pending" },
              ]
            : []),
        ]}
      />
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {fee ? (
          <StackBar
            title="Course fee collection"
            sub={`Collected, overdue and not yet due on active individual course enrollments, as of today${inMain}`}
            segments={[
              { label: "Collected", value: fee.collectedCents, text: formatMoney(fee.collectedCents, fee.currency) },
              { label: "Overdue", value: fee.overdueCents, text: formatMoney(fee.overdueCents, fee.currency) },
              { label: "Not yet due", value: fee.notYetDueCents, text: formatMoney(fee.notYetDueCents, fee.currency) },
            ]}
            empty="No fee schedules on active enrollments yet."
          />
        ) : studentPayments.visible ? (
          <StackBar
            title="Student charges"
            sub={`Payments received against what is still owed on open charges${inMain}`}
            segments={[
              {
                label: "Payments received",
                value: centsOf(studentPayments.paymentsReceived.totalsByCurrency, main),
                text: formatMoney(centsOf(studentPayments.paymentsReceived.totalsByCurrency, main), main),
              },
              {
                label: `Outstanding charges (${studentPayments.outstandingCharges.count} open)`,
                value: centsOf(studentPayments.outstandingCharges.totalsByCurrency, main),
                text: formatMoney(centsOf(studentPayments.outstandingCharges.totalsByCurrency, main), main),
              },
            ]}
            empty="No payments or open charges in this period."
          />
        ) : null}
        {programFee ? (
          <StackBar
            title="Program fee collection"
            sub={`Installments of active complete-program enrollments, as of today, in ${programFee.currency}`}
            segments={[
              { label: "Collected", value: programFee.collectedCents, text: formatMoney(programFee.collectedCents, programFee.currency) },
              { label: "Overdue", value: programFee.overdueCents, text: formatMoney(programFee.overdueCents, programFee.currency) },
              { label: "Not yet due", value: programFee.notYetDueCents, text: formatMoney(programFee.notYetDueCents, programFee.currency) },
            ]}
            empty="No program installments yet."
          />
        ) : null}
        {studentPayments.visible && (
          <BarList
            title="Student payments by source"
            sub={`What each posted payment paid for, each payment counted once${inMain}`}
            rows={
              bySource.every((row) => row.amountCents === 0)
                ? []
                : bySource.map((row) => ({ label: SOURCE_LABEL[row.source], value: row.amountCents, text: formatMoney(row.amountCents, main) }))
            }
            empty="No payments received in this period."
          />
        )}
        {studentPayments.visible && (
          <BarList
            title="Collections by month"
            sub={`Student payments received${inMain}`}
            rows={byMonth.map((row) => ({ label: monthLabel(row.month), value: row.amountCents, text: formatMoney(row.amountCents, main) }))}
            empty="No payments received in this period."
          />
        )}
        {studentPayments.visible && (
          <BarList
            title="Student payments by method"
            sub={`Posted payments${inMain}`}
            rows={byMethod.every((row) => row.amountCents === 0) ? [] : byMethod.map((row) => ({ label: METHOD_LABEL[row.method], value: row.amountCents, text: formatMoney(row.amountCents, main) }))}
            empty="No payments received in this period."
          />
        )}
        {(income.visible || expenses.visible) && (
          <BarList
            title="Income and expenses"
            sub={`Posted income and approved expenses${inMain}`}
            rows={[
              ...(income.visible ? [{ label: "Income", value: centsOf(income.totalsByCurrency, main), text: formatMoney(centsOf(income.totalsByCurrency, main), main) }] : []),
              ...(expenses.visible
                ? [{ label: "Expenses", value: centsOf(expenses.totalsByCurrency, main), text: formatMoney(centsOf(expenses.totalsByCurrency, main), main), muted: true }]
                : []),
            ]}
          />
        )}
      </div>
      {programRows.length > 0 && (
        <>
          <BlockTitle>Program fees</BlockTitle>
          <DataTable stackBelow={760}>
            <thead>
              <tr>
                <th className={rtTh}>Program</th>
                <th className={`${rtTh} text-right`}>Enrollments</th>
                <th className={`${rtTh} text-right`}>Program fees</th>
                <th className={`${rtTh} text-right`}>Collected</th>
                <th className={`${rtTh} text-right`}>Overdue</th>
                <th className={`${rtTh} text-right`}>Not yet due</th>
              </tr>
            </thead>
            <tbody>
              {programRows.map((row) => (
                <tr key={`${row.programId}:${row.currency}`} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Program">
                    {row.programName}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Enrollments">
                    {row.enrollments}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Program fees">
                    {formatMoney(row.finalFeeCents, row.currency)}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Collected">
                    {formatMoney(row.collectedCents, row.currency)}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Overdue">
                    {formatMoney(row.overdueCents, row.currency)}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Not yet due">
                    {formatMoney(row.notYetDueCents, row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
      <NoteBlock>
        {fee || programFee ? "Course and program fee collection cover the installments of active enrollments as of today and ignore the dates above. " : ""}
        {programRows.length > 0 || programPayments.amountCents > 0
          ? "A complete program has one program fee paid in monthly installments; its courses carry no course fee, so nothing is counted twice. "
          : ""}Collections by month use the date each payment was received (UTC). Totals are kept per currency and never added
        across currencies. Platform subscription billing is not included.
      </NoteBlock>
    </>
  );
}
