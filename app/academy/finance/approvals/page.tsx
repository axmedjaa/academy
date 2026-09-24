import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { getAuthContext } from "@/lib/auth/auth-context";
import { db } from "@/lib/db";
import { students } from "@/lib/db/schema";
import { listStudentPayments } from "@/lib/academies/student-payments";
import { PAGE_WRAP, PageHeader, PageMessage, Section } from "@/app/academy/_shell/ui";
import { PaymentApprovalsQueue } from "./payment-approvals-queue";

/**
 * DESIGN.md §9.6: `/academy/finance/approvals` — "Approval queue (§3) |
 * Self-approval is visually disabled, not hidden... this is the one place a
 * role sees a control they can't use, because omitting it would be
 * confusing on their own submission."
 *
 * Confirmed Phase 4 post-implementation audit gap fix: `approveStudentPaymentAction`/
 * `rejectStudentPaymentAction` (lib/academies/student-payments-actions.ts)
 * already existed, fully authorized and tested, with zero UI call site.
 * This page is that call site — a dedicated route, per DESIGN.md's own
 * naming, rather than folding approve/reject into `/academy/finance`'s
 * existing Payments tab (which only ever shows an "Issue receipt" button
 * today; adding an approval queue there would be redesigning an existing,
 * already-working page rather than filling the confirmed gap).
 *
 * Scope decision: this queue lists STUDENT PAYMENTS only, not expenses.
 * Expense approve/reject already has a working UI
 * (app/academy/finance/finance-income-expenses.tsx, wired in an earlier
 * wave) — duplicating it here would be exactly the "redesign an existing
 * page" this task's brief warns against. DESIGN.md's own component
 * catalogue (§3) describes "Approval queue" as a reusable pattern, not a
 * single combined screen every consumer must share.
 *
 * Reuses `listStudentPayments` unchanged (Item 51/52) — the only change
 * that function needed was exposing a `canApprove` flag alongside its
 * existing `canManage` (see that file's own comment), the same shape
 * `listExpenseRecords` already exposed both of. No new read/query was
 * added.
 *
 * UI-quality pass (this wave): restyled onto the shared Tailwind shell
 * (PAGE_WRAP/PageHeader/PageMessage/Section), matching /academy/finance
 * itself — same student-name-lookup convention as that page's own comment
 * (display-only, on already-authorized/tenant-scoped studentIds).
 */
export default async function FinanceApprovalsPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await listStudentPayments(context);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const pending = result.payments.filter((payment) => payment.status === "pending_approval");
  const studentIds = [...new Set(pending.map((payment) => payment.studentId))];
  const studentRows = studentIds.length
    ? await db
        .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber })
        .from(students)
        .where(inArray(students.id, studentIds))
    : [];
  const studentLabels = Object.fromEntries(
    studentRows.map((row) => [row.id, `${row.fullName} (${row.studentNumber})`]),
  );

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Approvals" description="Student payments awaiting a decision." />
      {result.canApprove ? (
        <PaymentApprovalsQueue payments={pending} studentLabels={studentLabels} currentUserId={context.userId} />
      ) : (
        <Section>
          <p className="text-sm text-muted">You don&apos;t have permission to approve or reject student payments.</p>
        </Section>
      )}
    </div>
  );
}
