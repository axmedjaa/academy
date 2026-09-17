import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listStudentCharges, listStudentPayments } from "@/lib/academies/student-payments";
import { listIncomeRecords } from "@/lib/academies/income-records";
import { listExpenseRecords } from "@/lib/academies/expense-records";
import { FinanceChargesPayments } from "./finance-charges-payments";
import { FinanceIncomeExpenses } from "./finance-income-expenses";

/**
 * PLAN.md Phase 4, Item 51 — `/academy/finance` (Charges/Payments tabs),
 * extended by Item 53 with Income/Expenses tabs. DESIGN.md §9.6 also lists
 * a dashboard tab, an approvals queue, and finance reports — out of scope
 * (approvals is Item 52's page, reports is Item 55's).
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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{error?.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{error?.message}</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Finance</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Student charges, manual payment recording, receipts, and income/expense records. Not a
        general ledger — every payment is manually recorded after the fact.
      </p>
      {chargesResult.ok && paymentsResult.ok && (
        <FinanceChargesPayments
          charges={chargesResult.charges}
          payments={paymentsResult.payments}
          canManage={chargesResult.canManage}
        />
      )}
      <FinanceIncomeExpenses
        income={incomeResult.ok ? incomeResult.records : null}
        incomeCanCreate={incomeResult.ok ? incomeResult.canCreate : false}
        expenses={expensesResult.ok ? expensesResult.records : null}
        expenseCanCreate={expensesResult.ok ? expensesResult.canCreate : false}
        expenseCanApprove={expensesResult.ok ? expensesResult.canApprove : false}
      />
    </main>
  );
}
