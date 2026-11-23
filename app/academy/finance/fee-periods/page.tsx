import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listFeePeriodOverview } from "@/lib/academies/fee-period-overview";
import type { EnrollmentPaymentStatus } from "@/lib/academies/fee-periods";
import { getStudentPhotoUrlsByIds } from "@/lib/academies/students";
import { formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { getStatusTone } from "@/lib/ui/status";
import { Badge, EmptyState, PAGE_WRAP, PageHeader, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, PersonCell, ROW_BTN, ROW_BTN_PRIMARY, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChipParamFilter, FilterBar, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { ChangeFeeButton } from "./change-fee";

const STATUSES: EnrollmentPaymentStatus[] = ["overdue", "partially_paid", "unpaid", "paid"];

/**
 * Fee periods (design A14): every active enrollment's installment plan and
 * where it stands today, searchable and filterable by status. Collect and
 * the period-by-period ledger live on the student's own page (Fees tab).
 * Change fee (course or program) keeps what was paid and spreads the rest of
 * the new fee over new monthly payments (lib/academies/fee-plan-change.ts).
 */
export default async function FeePeriodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };
  const q = get("q").trim();
  const status = STATUSES.includes(get("status") as EnrollmentPaymentStatus) ? (get("status") as EnrollmentPaymentStatus) : undefined;
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const result = await listFeePeriodOverview(context, { searchTerm: q || undefined, status, page });
  if (!result.ok) {
    return <PageMessage title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={result.error.message} />;
  }
  const photos = await getStudentPhotoUrlsByIds(context, result.rows.map((row) => row.studentId));

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Fee periods" description="Installment schedules for enrolled students. A whole-program enrollment shows one program fee." />

      <div className="mb-4">
        <ChipParamFilter
          param="status"
          label="Filter by payment status"
          options={[
            { value: "", label: "All" },
            { value: "overdue", label: "Overdue" },
            { value: "partially_paid", label: "Partially paid" },
            { value: "unpaid", label: "Unpaid" },
            { value: "paid", label: "Paid" },
          ]}
        />
      </div>
      <FilterBar>
        <SearchField placeholder="Search students" />
      </FilterBar>

      {result.rows.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message={q || status ? "No enrollment matches these filters." : "No active enrollments yet. Enroll a student in a batch to start a fee schedule."}
            icon={<Icon name="receipt_long" />}
          />
        </Section>
      ) : (
        <DataTable
          stackBelow={1040}
          footer={<PaginationNav page={result.page} pageSize={result.pageSize} totalCount={result.totalCount} searchParams={params} />}
        >
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Schedule</th>
              <th className={`${rtTh} text-right`}>Due so far</th>
              <th className={`${rtTh} text-right`}>Paid</th>
              <th className={`${rtTh} text-right`}>Remaining</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const currency = row.schedule?.currency ?? "USD";
              return (
                <tr key={row.enrollmentId} className={trHover}>
                  <td className={rtTd} data-label="Student">
                    <PersonCell
                      name={row.studentName}
                      sub={row.studentNumber}
                      href={`/academy/students/${row.studentId}?tab=fees`}
                      photoUrl={photos.get(row.studentId) ?? null}
                    />
                  </td>
                  <td className={rtTd} data-label="Batch">
                    <span className="font-semibold">{row.batchCode}</span>
                    <span className="block text-xs text-muted">
                      {row.kind === "program" ? `Program · ${row.courseName}` : row.courseName}
                    </span>
                  </td>
                  <td className={rtTd} data-label="Schedule">
                    {row.schedule ? (
                      <>
                        {describePaymentPlan(row.schedule.amountCents, row.schedule.intervalMonths, currency)}
                        <span className="block text-xs text-muted">Plan total {formatMoney(row.schedule.amountCents, currency)}</span>
                      </>
                    ) : (
                      <span className="text-muted">{row.scholarship === "full" ? "Free, nothing due" : row.status === "paid" ? "Paid in full" : "No schedule"}</span>
                    )}
                    {row.scholarship && (
                      <span className="mt-1 block">
                        <Badge label={row.scholarship === "full" ? "Full scholarship" : "Partial scholarship"} tone="blue" />
                      </span>
                    )}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Due so far">
                    {formatMoney(row.dueCents, currency)}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Paid">
                    {formatMoney(row.paidCents, currency)}
                  </td>
                  <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="Remaining">
                    {formatMoney(row.remainingCents, currency)}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <Badge label={row.status} tone={getStatusTone(row.status)} />
                  </td>
                  <td className={`${rtTd} text-right`} data-actions="">
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      {result.canManage && row.overdueCents > 0 ? (
                        <Link href={`/academy/students/${row.studentId}?tab=fees`} className={ROW_BTN_PRIMARY}>
                          <Icon name="cash" width={16} height={16} />
                          Collect {formatMoney(row.overdueCents, currency)}
                        </Link>
                      ) : (
                        <Link href={`/academy/students/${row.studentId}?tab=fees`} className={ROW_BTN}>
                          Periods
                        </Link>
                      )}
                      {result.canManage && (
                        <ChangeFeeButton
                          target={row.kind === "course" ? { kind: "course", enrollmentId: row.enrollmentId } : { kind: "program", programEnrollmentId: row.enrollmentId }}
                          studentName={row.studentName}
                          label={`${row.batchCode} · ${row.kind === "program" ? `Program · ${row.courseName}` : row.courseName}`}
                        />
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        The schedule total is the full fee, not a per-installment amount, and the last installment absorbs any rounding.
        Change fee keeps what was already paid and spreads the rest of the new fee over the new monthly payments. A full
        scholarship is free and never shows as unpaid. Overpayment is not supported.
        Figures cover the installments that have started so far. Open a student to see each period and collect payments.
      </NoteBlock>
    </div>
  );
}
