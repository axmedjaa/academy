import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { getAuthContext } from "@/lib/auth/auth-context";
import { db } from "@/lib/db";
import { students } from "@/lib/db/schema";
import { listStudentCharges, listStudentPayments } from "@/lib/academies/student-payments";
import { searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { listIncomeRecords } from "@/lib/academies/income-records";
import { listExpenseRecords } from "@/lib/academies/expense-records";
import { LinkButton, PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { FinanceChargesPayments } from "./finance-charges-payments";
import { FinanceIncomeExpenses } from "./finance-income-expenses";

/**
 * PLAN.md Phase 4, Item 51 — `/academy/finance` (Charges/Payments tabs),
 * extended by Item 53 with Income/Expenses tabs. DESIGN.md §9.6 also lists
 * a dashboard tab, an approvals queue, and finance reports — the approvals
 * queue now lives at its own dedicated `/academy/finance/approvals` route
 * (confirmed Phase 4 audit gap fix; linked from here when the caller can
 * approve), and reports remain Item 55's separate page.
 *
 * Same gating shape as app/academy/branches/page.tsx: the `/academy/*`
 * layout already ran a base subscription/membership check but has no
 * channel to hand this page the resolved academyId/role, so this page's
 * own reads repeat a checkAcademyAccessForContext-backed lookup themselves.
 *
 * ---------------------------------------------------------------------
 * Independent per-section gating
 * ---------------------------------------------------------------------
 * `academy.student_payments`/`academy.income`/`academy.expenses` are three
 * separate permission rows with different per-role cells (e.g. Trainer has
 * "view" on student payments and expenses but no entry at all on income) —
 * each section's own list call is resolved independently, and a `forbidden`
 * result on one row simply omits that section (`null` passed to
 * `FinanceIncomeExpenses`) rather than blocking the whole page, per
 * DESIGN.md §5's "nav item and every action tied to it are absent... not
 * rendered, not disabled" rule. Only when EVERY section is inaccessible
 * (e.g. Admissions Officer, who has "—" on all three rows) does this page
 * render a top-level "Access denied".
 *
 * UI-quality pass (this wave): restyled onto the shared Tailwind shell
 * (PAGE_WRAP/PageHeader/PageMessage), matching every other `/academy/*`
 * page — this page and its two client components previously predated that
 * pass and still used raw inline styles/plain `<table>`. No business logic
 * changed: same three independent reads, same ok/ownership checks, same
 * props into the two child components. The one net-new read is a
 * display-only student-name lookup (`fullName`/`studentNumber`, matching
 * the "Name (STD-XXXX)" convention already used by roster-panel.tsx/
 * exams-list.tsx/results-list.tsx) — every studentId being resolved here
 * already came from a charge/payment row that listStudentCharges/
 * listStudentPayments already tenant-scoped and authorized, so this is a
 * display-field fetch on already-authorized ids, not a fresh authorization
 * decision (same reasoning as lib/academies/id-cards-actions.ts's own
 * resolveStudentName comment).
 *
 * Student picker (this wave): `searchStudents` (already tenant/branch-scoped
 * for the caller's own role, same as everywhere else it's used — e.g.
 * app/academy/batches/[batchId]/page.tsx's own studentOptions) backs a
 * `<select>` in the Create Charge/Record Payment forms so a caller picks a
 * student by name instead of typing/pasting a raw id. Active students only
 * (creating a new charge/payment for an archived student isn't a real
 * workflow); capped at STUDENTS_MAX_PAGE_SIZE, same ceiling every other
 * "list students for a picker" call site already accepts rather than
 * building unbounded/paginated combobox UI for this.
 */
export default async function AcademyFinancePage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const chargesResult = await listStudentCharges(context);
  const paymentsResult = await listStudentPayments(context);
  const incomeResult = await listIncomeRecords(context);
  const expensesResult = await listExpenseRecords(context);

  const chargesPaymentsAccessible = chargesResult.ok && paymentsResult.ok;
  const incomeAccessible = incomeResult.ok;
  const expensesAccessible = expensesResult.ok;

  if (!chargesPaymentsAccessible && !incomeAccessible && !expensesAccessible) {
    const error = !chargesResult.ok
      ? chargesResult.error
      : !paymentsResult.ok
        ? paymentsResult.error
        : !incomeResult.ok
          ? incomeResult.error
          : !expensesResult.ok
            ? expensesResult.error
            : null;
    return (
      <PageMessage
        title={error?.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={error?.message ?? "You don't have permission to view this page."}
      />
    );
  }

  const studentIds = new Set<string>();
  if (chargesResult.ok) {
    for (const charge of chargesResult.charges) studentIds.add(charge.studentId);
  }
  if (paymentsResult.ok) {
    for (const payment of paymentsResult.payments) studentIds.add(payment.studentId);
  }
  const studentRows = studentIds.size
    ? await db
        .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber })
        .from(students)
        .where(inArray(students.id, [...studentIds]))
    : [];
  const studentLabels = Object.fromEntries(
    studentRows.map((row) => [row.id, `${row.fullName} (${row.studentNumber})`]),
  );

  const studentPickerResult =
    chargesResult.ok && paymentsResult.ok
      ? await searchStudents(context, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE })
      : null;
  const studentOptions =
    studentPickerResult?.ok
      ? studentPickerResult.data.rows.map((row) => ({
          id: row.id,
          fullName: row.fullName,
          studentNumber: row.studentNumber,
        }))
      : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Finance"
        description="Student charges, manual payment recording, receipts, and income/expense records. Not a general ledger — every payment is manually recorded after the fact."
        actions={
          paymentsResult.ok && paymentsResult.canApprove ? (
            <LinkButton href="/academy/finance/approvals" variant="secondary">
              Pending approvals
            </LinkButton>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-8">
        {chargesResult.ok && paymentsResult.ok && (
          <FinanceChargesPayments
            charges={chargesResult.charges}
            payments={paymentsResult.payments}
            studentLabels={studentLabels}
            studentOptions={studentOptions}
            canManage={chargesResult.canManage}
            canApprove={paymentsResult.canApprove}
            currentUserId={context.userId}
          />
        )}
        <FinanceIncomeExpenses
          income={incomeResult.ok ? incomeResult.records : null}
          incomeCanCreate={incomeResult.ok ? incomeResult.canCreate : false}
          expenses={expensesResult.ok ? expensesResult.records : null}
          expenseCanCreate={expensesResult.ok ? expensesResult.canCreate : false}
          expenseCanApprove={expensesResult.ok ? expensesResult.canApprove : false}
          currentUserId={context.userId}
        />
      </div>
    </div>
  );
}
