import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthContext } from "@/lib/auth/auth-context";
import { db } from "@/lib/db";
import { studentCharges, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  STUDENT_PAYMENT_LIST_STATUSES,
  STUDENT_PAYMENT_METHODS,
  listReceiptsForPayments,
  listStudentCharges,
  listStudentPayments,
  type StudentPaymentListStatus,
  type StudentPaymentMethod,
} from "@/lib/academies/student-payments";
import { listFeePeriodPaymentHistory } from "@/lib/academies/fee-periods";
import { getStudentPhotoUrlsByIds, searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { getStudentsOverview } from "@/lib/academies/students-overview";
import { listIncomeRecords } from "@/lib/academies/income-records";
import { listExpenseRecords } from "@/lib/academies/expense-records";
import { resolveStaffNames } from "@/lib/academies/staff-labels";
import {
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";
import { getStatusTone } from "@/lib/ui/status";
import { Badge, EmptyState, PAGE_WRAP, PageHeader, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, NoteBlock, PersonCell, ROW_BTN_PRIMARY, TabLinks, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { FinanceCreateAction, FinanceExportButton } from "./finance-create";
import { ExpensesTable, IncomeTable, PaymentsTable } from "./finance-tables";
import { categoryChip } from "./finance-chips";
import { LIST_PAGE_SIZE_MAX } from "@/lib/ui/pagination";
import { ChipParamFilter, ClearFilters, FilterBar, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { describeAllocations } from "@/lib/ui/payment-allocations";
import { getRefundedAmountsForPayments } from "@/lib/academies/course-refunds";

const FINANCE_PAGE_SIZE = LIST_PAGE_SIZE_MAX;

type FinanceTab = "charges" | "payments" | "income" | "expenses";
const TAB_LABEL: Record<FinanceTab, string> = { charges: "Charges", payments: "Payments", income: "Income", expenses: "Expenses" };

/**
 * Finance (design A13): Charges, Payments, Income and Expenses as pill
 * tabs (`?tab=`), each table with its own create action in the header and
 * Export CSV (the audited finance-report export).
 *
 * A tab appears only for a role with any access on its permission row
 * (student payments covers Charges and Payments; income and expenses are
 * their own rows), and only the open tab's records are read. Every list
 * call re-checks access and academy scope itself; the extra lookups here
 * (student names and photos, charge descriptions, staff names, receipts,
 * courses) are display enrichment on rows those calls already returned.
 *
 * Student payments post immediately (no approval step) and are only ever
 * reversed or adjusted, never edited; recurring fee-period payments are
 * collected from the student's own page.
 */
export default async function AcademyFinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") {
    return <PageMessage title="Access unavailable" message={access.message} />;
  }
  const { academyId, membershipRole } = access;

  const tabs: FinanceTab[] = [];
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) !== "none") tabs.push("charges", "payments");
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_INCOME_ACTION) !== "none") tabs.push("income");
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_EXPENSES_ACTION) !== "none") tabs.push("expenses");
  if (tabs.length === 0) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };
  const requested = get("tab") as FinanceTab;
  const tab: FinanceTab = tabs.includes(requested) ? requested : tabs[0];
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const tabLinks = tabs.map((key) => ({ key, label: TAB_LABEL[key], href: `/academy/finance?tab=${key}` }));

  // Student names (and numbers) for any student a listed row references.
  async function studentsById(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { labels: {} as Record<string, { name: string; number: string }>, photos: new Map<string, string>() };
    const [rows, photos] = await Promise.all([
      db
        .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber })
        .from(students)
        .where(and(eq(students.academyId, academyId), inArray(students.id, unique))),
      getStudentPhotoUrlsByIds(context!, unique),
    ]);
    return { labels: Object.fromEntries(rows.map((row) => [row.id, { name: row.fullName, number: row.studentNumber }])), photos };
  }

  // Active students for the Create charge / Record payment pickers.
  async function studentOptions() {
    const result = await searchStudents(context!, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE });
    return result.ok
      ? result.data.rows.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber, phone: row.phone }))
      : [];
  }

  const header = (actions: React.ReactNode, description = "Student charges and payments, income and expenses.") => (
    <PageHeader
      title="Finance"
      description={description}
      actions={
        <>
          <FinanceExportButton />
          {actions}
        </>
      }
    />
  );

  /* ---------------------------------------------------------------- */
  if (tab === "charges") {
    const chargesResult = await listStudentCharges(context, {}, { page, pageSize: FINANCE_PAGE_SIZE });
    if (!chargesResult.ok) return <PageMessage title="Access denied" message={chargesResult.error.message} />;
    const canManage = chargesResult.canManage;

    const overview = canManage ? await getStudentsOverview(context) : null;
    const overdueByStudent = overview?.ok ? (overview.overview.finance?.overdueByStudent ?? {}) : {};
    const overdueIds = Object.keys(overdueByStudent);

    const [{ labels, photos }, options] = await Promise.all([
      studentsById([...chargesResult.charges.map((charge) => charge.studentId), ...overdueIds]),
      canManage ? studentOptions() : Promise.resolve([]),
    ]);

    return (
      <div className={PAGE_WRAP}>
        {header(canManage ? <FinanceCreateAction kind="charge" studentOptions={options} /> : null)}
        <TabLinks tabs={tabLinks} current={tab} label="Finance sections" />

        {canManage && (
          <>
            <BlockTitle>Overdue fees</BlockTitle>
            {overdueIds.length === 0 ? (
              <Section className="mb-8">
                <EmptyState message="No student has an overdue fee period." icon={<Icon name="check_circle" />} />
              </Section>
            ) : (
              <DataTable stackBelow={600}>
                <thead>
                  <tr>
                    <th className={rtTh}>Student</th>
                    <th className={`${rtTh} text-right`}>Amount overdue</th>
                    <th className={rtTh}>
                      <span className="sr-only">Collect</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overdueIds
                    .sort((a, b) => (labels[a]?.name ?? "").localeCompare(labels[b]?.name ?? ""))
                    .map((studentId) => {
                      const amounts = overdueByStudent[studentId];
                      const line = amounts.map((x) => formatMoney(x.amountCents, x.currency)).join(" + ");
                      return (
                        <tr key={studentId} className={trHover}>
                          <td className={rtTd} data-label="Student">
                            <PersonCell
                              name={labels[studentId]?.name ?? "Student"}
                              sub={labels[studentId]?.number}
                              href={`/academy/students/${studentId}`}
                              photoUrl={photos.get(studentId) ?? null}
                            />
                          </td>
                          <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="Amount overdue">
                            {line}
                          </td>
                          <td className={`${rtTd} text-right`} data-actions="">
                            <Link href={`/academy/students/${studentId}?tab=fees`} className={ROW_BTN_PRIMARY}>
                              <Icon name="cash" width={16} height={16} />
                              Collect {line}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </DataTable>
            )}
            <BlockTitle>Charges</BlockTitle>
          </>
        )}

        {chargesResult.charges.length === 0 ? (
          <Section className="mb-8">
            <EmptyState message="No charges to show yet." icon={<Icon name="receipt_long" />} />
          </Section>
        ) : (
          <DataTable
            stackBelow={760}
            footer={
              <PaginationNav
                page={page}
                pageSize={FINANCE_PAGE_SIZE}
                totalCount={chargesResult.totalCount ?? chargesResult.charges.length}
                searchParams={params}
              />
            }
          >
            <thead>
              <tr>
                <th className={rtTh}>Student</th>
                <th className={rtTh}>Charge</th>
                <th className={`${rtTh} text-right`}>Amount</th>
                <th className={rtTh}>Due</th>
                <th className={rtTh}>Status</th>
              </tr>
            </thead>
            <tbody>
              {chargesResult.charges.map((charge) => (
                <tr key={charge.id} className={trHover}>
                  <td className={rtTd} data-label="Student">
                    <PersonCell
                      name={labels[charge.studentId]?.name ?? "Student"}
                      sub={labels[charge.studentId]?.number}
                      href={`/academy/students/${charge.studentId}`}
                      photoUrl={photos.get(charge.studentId) ?? null}
                    />
                  </td>
                  <td className={rtTd} data-label="Charge">
                    {categoryChip(charge.description)}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Amount">
                    {formatMoney(charge.amountCents, charge.currency)}
                  </td>
                  <td className={`${rtTd} whitespace-nowrap`} data-label="Due">
                    {charge.dueDate ? formatDate(charge.dueDate) : "No due date"}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <Badge label={charge.status} tone={getStatusTone(charge.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        <NoteBlock>
          A charge is a one-off amount a student owes, such as a replacement fee. Recurring course fees are fee periods, collected
          from the student&apos;s page. A charge&apos;s status follows the payments recorded against it.
        </NoteBlock>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  if (tab === "payments") {
    // Search and filters (design `pay` table: searchable). Unknown values are
    // ignored rather than trusted; the list call scopes everything to this
    // academy and re-checks access itself.
    const q = get("q").trim();
    const statusParam = get("status");
    const status = (STUDENT_PAYMENT_LIST_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as StudentPaymentListStatus)
      : undefined;
    const methodParam = get("method");
    const method = (STUDENT_PAYMENT_METHODS as readonly string[]).includes(methodParam) ? (methodParam as StudentPaymentMethod) : undefined;
    const filtered = Boolean(q || status || method);

    const paymentsResult = await listStudentPayments(context, { q, status, method }, { page, pageSize: FINANCE_PAGE_SIZE });
    if (!paymentsResult.ok) return <PageMessage title="Access denied" message={paymentsResult.error.message} />;
    const payments = paymentsResult.payments;
    const canManage = paymentsResult.canManage;

    const chargeIds = [...new Set(payments.map((p) => p.chargeId).filter((id): id is string => Boolean(id)))];
    const [{ labels, photos }, staffNames, receipts, history, chargeRows, payable, options] = await Promise.all([
      studentsById(payments.map((p) => p.studentId)),
      resolveStaffNames(academyId, payments.map((p) => p.recordedBy)),
      listReceiptsForPayments(context, payments.map((p) => p.id)),
      // Only this page's payments: what each one was allocated to.
      listFeePeriodPaymentHistory(context, { paymentIds: payments.map((p) => p.id) }),
      chargeIds.length
        ? db
            .select({ id: studentCharges.id, description: studentCharges.description })
            .from(studentCharges)
            .where(and(eq(studentCharges.academyId, academyId), inArray(studentCharges.id, chargeIds)))
        : Promise.resolve([]),
      canManage ? listStudentCharges(context, { status: ["open", "partially_paid"] }) : Promise.resolve(null),
      canManage ? studentOptions() : Promise.resolve([]),
    ]);
    const chargeDescription = Object.fromEntries(chargeRows.map((row) => [row.id, row.description]));
    // Refunds recorded out of these payments (course withdrawals).
    const refundedByPayment = await getRefundedAmountsForPayments(academyId, payments.map((p) => p.id));
    // One payment can fund several fee periods, even of several courses: it
    // stays one row, labelled with every course it was allocated to.
    const allocationsByPayment = new Map((history.ok ? history.rows : []).map((row) => [row.paymentId, describeAllocations(row.periods)]));

    const rows = payments.map((payment) => ({
      payment,
      studentName: labels[payment.studentId]?.name ?? "Student",
      studentNumber: labels[payment.studentId]?.number ?? "",
      photoUrl: photos.get(payment.studentId) ?? null,
      recordedByName: staffNames[payment.recordedBy] ?? "Staff member",
      appliesTo:
        (payment.chargeId ? chargeDescription[payment.chargeId] : undefined) ??
        allocationsByPayment.get(payment.id)?.label ??
        (payment.reversedPaymentId ? "Reversal" : "General payment"),
      appliesToDetail: allocationsByPayment.get(payment.id)?.detail ?? null,
      receipt: receipts.get(payment.id) ? { id: receipts.get(payment.id)!.id, number: receipts.get(payment.id)!.receiptNumber } : null,
      refundedCents: refundedByPayment.get(payment.id) ?? 0,
    }));

    return (
      <div className={PAGE_WRAP}>
        {header(
          canManage ? (
            <FinanceCreateAction
              kind="payment"
              studentOptions={options}
              payableCharges={(payable?.ok ? payable.charges : []).map((charge) => ({
                id: charge.id,
                studentId: charge.studentId,
                description: charge.description,
                amountCents: charge.amountCents,
                currency: charge.currency,
                status: charge.status,
              }))}
            />
          ) : null,
        )}
        <TabLinks tabs={tabLinks} current={tab} label="Finance sections" />
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <ChipParamFilter
            param="status"
            label="Filter by payment status"
            options={[
              { value: "", label: "All" },
              { value: "posted", label: "Posted" },
              { value: "reversed", label: "Reversed" },
              { value: "reversal", label: "Reversal" },
            ]}
          />
        </div>
        <FilterBar>
          <SearchField placeholder="Search student, number or reference" />
          <FilterSelect
            param="method"
            label="Method"
            options={[
              { value: "", label: "All methods" },
              { value: "cash", label: "Cash" },
              { value: "mobile_money", label: "Mobile money" },
              { value: "bank_transfer", label: "Bank transfer" },
            ]}
          />
          {filtered && <ClearFilters params={["q", "status", "method"]} compact />}
        </FilterBar>
        {payments.length === 0 ? (
          <Section className="mb-8">
            <EmptyState
              message={filtered ? "No payment matches these filters." : "No payments to show yet."}
              icon={<Icon name="payments" />}
            />
          </Section>
        ) : (
          <PaymentsTable
            rows={rows}
            canManage={canManage}
            canReverse={paymentsResult.canReverse}
            currentUserId={context.userId}
            footer={
              <PaginationNav
                page={page}
                pageSize={FINANCE_PAGE_SIZE}
                totalCount={paymentsResult.totalCount ?? payments.length}
                searchParams={params}
              />
            }
          />
        )}
        <NoteBlock>
          Student payments post immediately and cannot be edited. They are corrected by reversing or adjusting them: the
          person who recorded a payment can correct it, and a Manager can correct any payment. The original stays on record
          with a linked reversal.
        </NoteBlock>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  if (tab === "income") {
    const incomeResult = await listIncomeRecords(context);
    if (!incomeResult.ok) return <PageMessage title="Access denied" message={incomeResult.error.message} />;
    const records = [...incomeResult.records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const staffNames = await resolveStaffNames(academyId, records.map((r) => r.recordedBy));
    return (
      <div className={PAGE_WRAP}>
        {header(incomeResult.canCreate ? <FinanceCreateAction kind="income" /> : null)}
        <TabLinks tabs={tabLinks} current={tab} label="Finance sections" />
        {records.length === 0 ? (
          <Section className="mb-8">
            <EmptyState message="No income recorded yet." icon={<Icon name="bank" />} />
          </Section>
        ) : (
          <IncomeTable
            rows={records.map((record) => ({ record, recordedByName: staffNames[record.recordedBy] ?? "Staff member" }))}
            canReverse={incomeResult.canCreate}
          />
        )}
        <NoteBlock>
          Income posts directly with no approval step and is corrected by reversing or adjusting it, including by whoever
          recorded it. Book sale payments appear here automatically.
        </NoteBlock>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  const expensesResult = await listExpenseRecords(context);
  if (!expensesResult.ok) return <PageMessage title="Access denied" message={expensesResult.error.message} />;
  const records = [...expensesResult.records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const staffNames = await resolveStaffNames(academyId, records.map((r) => r.submittedBy));
  return (
    <div className={PAGE_WRAP}>
      {header(expensesResult.canCreate ? <FinanceCreateAction kind="expense" /> : null)}
      <TabLinks tabs={tabLinks} current={tab} label="Finance sections" />
      {records.length === 0 ? (
        <Section className="mb-8">
          <EmptyState message="No expenses recorded yet." icon={<Icon name="receipt_long" />} />
        </Section>
      ) : (
        <ExpensesTable
          rows={records.map((record) => ({ record, submittedByName: staffNames[record.submittedBy] ?? "Staff member" }))}
          canCreate={expensesResult.canCreate}
          canApprove={expensesResult.canApprove}
          canSelfApprove={expensesResult.canSelfApprove}
          currentUserId={context.userId}
        />
      )}
      <NoteBlock>
        Expenses keep an approval workflow: a new expense is a draft until it is submitted for approval. Approved expenses
        are corrected by reversing or adjusting them, never edited: whoever submitted an expense can correct it, and an
        Administrator or Manager can correct any expense.
      </NoteBlock>
    </div>
  );
}
