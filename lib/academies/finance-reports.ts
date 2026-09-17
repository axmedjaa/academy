import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseRecords, incomeRecords, studentCharges, studentPayments, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 4, Item 55 — `getFinanceReports`.
 *
 * ---------------------------------------------------------------------
 * Structural guarantee: platform billing is unreachable from this module
 * ---------------------------------------------------------------------
 * DESIGN.md §9.6's Finance Reports row: "Never shows a subscription-payment
 * row — this view is exclusively student/academy-side money; platform SaaS
 * billing has no presence here at all." PLAN.md §8 asks for this to hold "at
 * the query level, not just by table design."
 *
 * This file's only table imports are `student_charges`, `student_payments`,
 * `students` (for branch scoping), `income_records`, `expense_records` — it
 * never imports `subscriptionPayments`/`academySubscriptions`/
 * `subscriptionPlans` from lib/db/schema, anywhere, for any reason. That is
 * a structural fact checkable by grepping this file's import list, not a
 * runtime filter that could be forgotten on one code path — there is no
 * identifier in scope anywhere below that could reference a subscription
 * table even by mistake. finance-reports.test.ts asserts this both by
 * source-text inspection (no `subscriptionPayments`/`academySubscriptions`/
 * `subscriptionPlans` token appears in this file at all) and by shape
 * (the returned report's TypeScript type has no field that could carry one).
 *
 * ---------------------------------------------------------------------
 * Per-entity scoping — NOT one combined permission gate
 * ---------------------------------------------------------------------
 * DESIGN.md §5's Role-to-UI Visibility Matrix has "Export
 * (Reports/Students/Finance/Audit)" as "Per own view rights" for every
 * single role, identically — reports (and, per that row, later exports)
 * never grant more than the role's own existing view right on the
 * underlying entity. This module reuses the exact three permission rows
 * lib/academies/student-payments.ts / income-records.ts / expense-records.ts
 * already gate their own reads on — `ACADEMY_STUDENT_PAYMENTS_ACTION`,
 * `ACADEMY_INCOME_ACTION`, `ACADEMY_EXPENSES_ACTION` — rather than adding a
 * fourth "finance reports" row to lib/auth/academy-permissions.ts (the task
 * brief explicitly says not to touch that file, and a new row would just be
 * a second, redundant gate on data three existing rows already gate).
 *
 * Each of the report's three sections (student payments/charges, income,
 * expenses) is resolved independently against its own row:
 * `level === "none"` on that row means that section comes back
 * `{ visible: false }` and contributes nothing to the report at all — no
 * amounts, no counts, not even a zero — while the OTHER two sections are
 * still computed normally if the caller's level on *their* rows is above
 * "none". This is why a Trainer (view on student_payments and expenses,
 * none on income) sees two sections and not the third, while an Admissions
 * Officer (none on all three) sees an entirely empty report — never a
 * single combined "forbidden" for the whole report, since PLAN.md/
 * DESIGN.md's matrix gives no role a broader "reports see everything"
 * exception. The only whole-report failure is `checkAcademyAccessForContext`
 * itself returning "blocked" (not a member / suspended academy / etc.) —
 * that is a pre-existing, unrelated gate every `/academy/*` action already
 * goes through, not something this item invents.
 *
 * Any level above "none" (`view`, `manage`, `full`, `approve`) is treated
 * identically for visibility purposes — this module never distinguishes
 * "can this caller *create*" from "can this caller *see this report
 * section*" the way the entity files' own `canManage`/`canCreate`/
 * `canApprove` helpers do, because a report is read-only: it has no create/
 * approve action of its own to gate more narrowly than plain visibility.
 *
 * ---------------------------------------------------------------------
 * What each section aggregates
 * ---------------------------------------------------------------------
 * - `studentPayments.outstandingCharges`: `student_charges` rows not yet
 *   fully paid — fixed to `status IN (open, partially_paid)` per PLAN.md's
 *   own phrasing ("student_charges not yet fully paid"). This is the
 *   section's definition, not something the generic `status` filter can
 *   override — passing e.g. `status: "paid"` simply has no effect on this
 *   particular metric (see `resolveStatusFilters`'s comment).
 * - `studentPayments.paymentsReceived`: `student_payments` rows, defaulting
 *   to `status = "approved"` (money actually confirmed received) unless the
 *   caller's `status` filter names a different `student_payments` status
 *   value explicitly.
 * - `studentPayments.pendingApprovalsCount`: `student_payments` rows with
 *   `status = "pending_approval"`, counted directly off that column —
 *   deliberately NOT computed via `approval_requests`
 *   (`entityType: "student_payment"`), because `recordStudentPayment`
 *   (Item 51) never creates an `approval_requests` row for a payment today;
 *   that only starts happening once Item 52's `approveStudentPayment`/
 *   `rejectStudentPayment` exist, which this item is explicitly told not to
 *   build or depend on. Counting the entity's own status column directly
 *   is correct today and stays correct once Item 52 lands (the status
 *   column is still the source of truth either way).
 * - `income`: `income_records` rows, defaulting to `status = "posted"`
 *   (excludes `reversed`) unless overridden by a valid `income_records`
 *   status in the filter.
 * - `expenses`: `expense_records` rows, defaulting to `status = "approved"`
 *   unless overridden, plus `expenses.pendingApprovalsCount` — same
 *   direct-status-column reasoning as payments above (also not computed via
 *   `approval_requests`, for consistency, even though `submitExpenseForApproval`
 *   does populate that table today).
 *
 * All monetary totals are grouped and returned per-currency
 * (`totalsByCurrency`) rather than summed across currencies, since nothing
 * in this codebase enforces a single currency per academy (every entity's
 * `currency` column is caller-suppliable, only *defaulted* from the
 * academy's `default_currency`) — summing raw cents across currencies would
 * silently produce a meaningless number.
 *
 * ---------------------------------------------------------------------
 * Filters (DESIGN.md §9.6: "Date/branch/status/method filters")
 * ---------------------------------------------------------------------
 * - `dateFrom`/`dateTo`: applied to each entity's own natural date column —
 *   `student_charges.created_at`, `student_payments.received_at`,
 *   `income_records.created_at`, `expense_records.created_at`. Inclusive on
 *   both ends.
 * - `branchId`: `income_records`/`expense_records` carry their own nullable
 *   `branch_id` column, filtered directly. `student_charges`/
 *   `student_payments` carry no `branch_id` column at all (same fact
 *   lib/academies/student-payments.ts's own module comment notes) — this
 *   filter reaches them via an inner join through `students.branch_id`
 *   instead, same shape as any other per-student branch scoping in this
 *   codebase.
 * - `status`: a plain string, applied per-entity only when it matches that
 *   entity's own status enum (`resolveStatusFilters`) — the four entities
 *   this report touches have four different, non-overlapping status
 *   vocabularies (`open`/`partially_paid`/... vs. `pending_approval`/
 *   `approved`/... vs. `posted`/`reversed` vs.
 *   `draft`/`pending_approval`/...), so a single filter value can only ever
 *   be meaningful for the section(s) whose enum it actually belongs to; it
 *   is silently ignored (falls back to that section's own default) for any
 *   section whose enum it doesn't match. `student_charges`'s own metric is
 *   fixed to its "outstanding" definition regardless (see above).
 * - `method`: `student_payments.method` only — no other table in this
 *   report has a payment method column.
 *
 * A `branchId` naming a real branch of a DIFFERENT academy is never
 * validated against a separate lookup — it doesn't need to be. Every query
 * below already filters its primary table on `academy_id = <caller's own
 * academy>` first; a cross-academy branch id can never match any row that
 * also satisfies that condition, so it deterministically yields empty
 * results rather than leaking another tenant's data. Same reasoning
 * applies to a nonexistent branch id.
 *
 * ---------------------------------------------------------------------
 * Why no branch dropdown/lookup dependency in the UI layer
 * ---------------------------------------------------------------------
 * `app/academy/finance-reports/page.tsx` takes `branchId` as a plain text
 * field rather than a `<select>` populated from `lib/academies/branches.ts`'s
 * `listBranches` — that function gates on the SEPARATE `academy.branches`
 * permission row, on which Finance Officer (the role this report matters
 * most for) has no entry at all ("none"). Wiring the report's branch filter
 * through `listBranches` would make a Finance Officer unable to filter by
 * branch despite having full view rights on every finance row this report
 * covers — an accidental narrowing this item's scoping rule explicitly
 * forbids ("never grant MORE than... " implies never grant less via an
 * unrelated permission row either). A free-text branch id input has no such
 * dependency.
 */

const OUTSTANDING_CHARGE_STATUSES = ["open", "partially_paid"] as const;
const STUDENT_PAYMENT_STATUSES = ["pending_approval", "approved", "rejected", "reversed"] as const;
const STUDENT_PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer"] as const;
const INCOME_RECORD_STATUSES = ["posted", "reversed"] as const;
const EXPENSE_RECORD_STATUSES = ["draft", "pending_approval", "approved", "rejected", "reversed"] as const;

type StudentPaymentStatus = (typeof STUDENT_PAYMENT_STATUSES)[number];
type StudentPaymentMethod = (typeof STUDENT_PAYMENT_METHODS)[number];
type IncomeRecordStatus = (typeof INCOME_RECORD_STATUSES)[number];
type ExpenseRecordStatus = (typeof EXPENSE_RECORD_STATUSES)[number];

export const financeReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  branchId: z.string().uuid("Invalid branch id").optional(),
  status: z.string().trim().min(1).max(50).optional(),
  method: z.enum(STUDENT_PAYMENT_METHODS).optional(),
});

export type FinanceReportFiltersInput = z.input<typeof financeReportFiltersSchema>;
type ParsedFinanceReportFilters = z.infer<typeof financeReportFiltersSchema>;

export interface FinanceReportsActionError {
  code: "blocked" | "validation";
  message: string;
}

export interface AmountByCurrency {
  currency: string;
  amountCents: number;
  count: number;
}

export interface OutstandingChargesSection {
  count: number;
  totalsByCurrency: AmountByCurrency[];
}

export interface PaymentsReceivedSection {
  count: number;
  totalsByCurrency: AmountByCurrency[];
}

export type StudentPaymentsReportSection =
  | { visible: false }
  | {
      visible: true;
      outstandingCharges: OutstandingChargesSection;
      paymentsReceived: PaymentsReceivedSection;
      pendingApprovalsCount: number;
    };

export type IncomeReportSection =
  | { visible: false }
  | { visible: true; count: number; totalsByCurrency: AmountByCurrency[] };

export type ExpensesReportSection =
  | { visible: false }
  | {
      visible: true;
      count: number;
      totalsByCurrency: AmountByCurrency[];
      pendingApprovalsCount: number;
    };

export interface FinanceReportsData {
  academyId: string;
  generatedAt: Date;
  filters: {
    dateFrom: Date | null;
    dateTo: Date | null;
    branchId: string | null;
    status: string | null;
    method: StudentPaymentMethod | null;
  };
  studentPayments: StudentPaymentsReportSection;
  income: IncomeReportSection;
  expenses: ExpensesReportSection;
}

export type GetFinanceReportsResult =
  | { ok: true; report: FinanceReportsData }
  | { ok: false; error: FinanceReportsActionError };

function matchesEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (!value) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function toAmountsByCurrency(
  rows: { currency: string; amountCents: number; count: number }[],
): AmountByCurrency[] {
  return rows.map((row) => ({
    currency: row.currency,
    amountCents: row.amountCents,
    count: row.count,
  }));
}

function totalCount(rows: { count: number }[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/** Outstanding charges: fixed to the "not yet fully paid" definition —
 * never overridden by `filters.status` (see this module's doc comment). */
async function computeOutstandingCharges(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<OutstandingChargesSection> {
  const conditions: SQL[] = [
    eq(studentCharges.academyId, academyId),
    inArray(studentCharges.status, OUTSTANDING_CHARGE_STATUSES),
  ];
  if (filters.dateFrom) conditions.push(gte(studentCharges.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(studentCharges.createdAt, filters.dateTo));
  if (filters.branchId) conditions.push(eq(students.branchId, filters.branchId));

  const rows = await db
    .select({
      currency: studentCharges.currency,
      amountCents: sql<number>`coalesce(sum(${studentCharges.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(studentCharges)
    .innerJoin(students, eq(studentCharges.studentId, students.id))
    .where(and(...conditions))
    .groupBy(studentCharges.currency);

  return { count: totalCount(rows), totalsByCurrency: toAmountsByCurrency(rows) };
}

/** Payments received this period: defaults to `status = "approved"` unless
 * the filter names a valid `student_payments` status explicitly. */
async function computePaymentsReceived(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<PaymentsReceivedSection> {
  const status: StudentPaymentStatus = matchesEnum(filters.status, STUDENT_PAYMENT_STATUSES) ?? "approved";
  const conditions: SQL[] = [
    eq(studentPayments.academyId, academyId),
    eq(studentPayments.status, status),
  ];
  if (filters.method) conditions.push(eq(studentPayments.method, filters.method));
  if (filters.dateFrom) conditions.push(gte(studentPayments.receivedAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(studentPayments.receivedAt, filters.dateTo));
  if (filters.branchId) conditions.push(eq(students.branchId, filters.branchId));

  const rows = await db
    .select({
      currency: studentPayments.currency,
      amountCents: sql<number>`coalesce(sum(${studentPayments.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(studentPayments)
    .innerJoin(students, eq(studentPayments.studentId, students.id))
    .where(and(...conditions))
    .groupBy(studentPayments.currency);

  return { count: totalCount(rows), totalsByCurrency: toAmountsByCurrency(rows) };
}

/** Pending student-payment approvals, counted directly off
 * `student_payments.status` — see this module's doc comment on why this
 * never queries `approval_requests`. Always `status = "pending_approval"`,
 * never overridden by `filters.status` (same "fixed metric" reasoning as
 * outstanding charges). */
async function computePendingPaymentApprovals(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<number> {
  const conditions: SQL[] = [
    eq(studentPayments.academyId, academyId),
    eq(studentPayments.status, "pending_approval"),
  ];
  if (filters.dateFrom) conditions.push(gte(studentPayments.receivedAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(studentPayments.receivedAt, filters.dateTo));
  if (filters.branchId) conditions.push(eq(students.branchId, filters.branchId));

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(studentPayments)
    .innerJoin(students, eq(studentPayments.studentId, students.id))
    .where(and(...conditions));

  return row?.count ?? 0;
}

/** Income: defaults to `status = "posted"` (excludes `reversed`) unless the
 * filter names a valid `income_records` status explicitly. */
async function computeIncomeTotals(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<{ count: number; totalsByCurrency: AmountByCurrency[] }> {
  const status: IncomeRecordStatus = matchesEnum(filters.status, INCOME_RECORD_STATUSES) ?? "posted";
  const conditions: SQL[] = [eq(incomeRecords.academyId, academyId), eq(incomeRecords.status, status)];
  if (filters.branchId) conditions.push(eq(incomeRecords.branchId, filters.branchId));
  if (filters.dateFrom) conditions.push(gte(incomeRecords.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(incomeRecords.createdAt, filters.dateTo));

  const rows = await db
    .select({
      currency: incomeRecords.currency,
      amountCents: sql<number>`coalesce(sum(${incomeRecords.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(incomeRecords)
    .where(and(...conditions))
    .groupBy(incomeRecords.currency);

  return { count: totalCount(rows), totalsByCurrency: toAmountsByCurrency(rows) };
}

/** Expenses: defaults to `status = "approved"` unless the filter names a
 * valid `expense_records` status explicitly. */
async function computeExpenseTotals(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<{ count: number; totalsByCurrency: AmountByCurrency[] }> {
  const status: ExpenseRecordStatus = matchesEnum(filters.status, EXPENSE_RECORD_STATUSES) ?? "approved";
  const conditions: SQL[] = [eq(expenseRecords.academyId, academyId), eq(expenseRecords.status, status)];
  if (filters.branchId) conditions.push(eq(expenseRecords.branchId, filters.branchId));
  if (filters.dateFrom) conditions.push(gte(expenseRecords.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(expenseRecords.createdAt, filters.dateTo));

  const rows = await db
    .select({
      currency: expenseRecords.currency,
      amountCents: sql<number>`coalesce(sum(${expenseRecords.amountCents}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(expenseRecords)
    .where(and(...conditions))
    .groupBy(expenseRecords.currency);

  return { count: totalCount(rows), totalsByCurrency: toAmountsByCurrency(rows) };
}

/** Pending expense approvals, counted directly off `expense_records.status`
 * — same "always pending_approval, never overridden by filters.status,
 * doesn't query approval_requests" reasoning as
 * `computePendingPaymentApprovals`. */
async function computePendingExpenseApprovals(
  academyId: string,
  filters: ParsedFinanceReportFilters,
): Promise<number> {
  const conditions: SQL[] = [
    eq(expenseRecords.academyId, academyId),
    eq(expenseRecords.status, "pending_approval"),
  ];
  if (filters.branchId) conditions.push(eq(expenseRecords.branchId, filters.branchId));
  if (filters.dateFrom) conditions.push(gte(expenseRecords.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(expenseRecords.createdAt, filters.dateTo));

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(expenseRecords)
    .where(and(...conditions));

  return row?.count ?? 0;
}

/**
 * `getFinanceReports` — the report itself. See this module's top doc
 * comment for the full scoping/structural rationale. Read-only: no
 * `recordAudit` call, same convention as every other plain `list*` read in
 * this codebase (lib/academies/income-records.ts's `listIncomeRecords`,
 * lib/academies/student-payments.ts's `listStudentCharges`/
 * `listStudentPayments`, etc. — only mutations are audited).
 */
export async function getFinanceReports(
  actorContext: AuthContext,
  filtersInput: FinanceReportFiltersInput = {},
): Promise<GetFinanceReportsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const parsed = financeReportFiltersSchema.safeParse(filtersInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid filters." },
    };
  }
  const filters = parsed.data;
  const { academyId, membershipRole } = access;

  const studentPaymentsLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION);
  const incomeLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_INCOME_ACTION);
  const expensesLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXPENSES_ACTION);

  const [studentPaymentsSection, incomeSection, expensesSection] = await Promise.all([
    studentPaymentsLevel !== "none"
      ? (async (): Promise<StudentPaymentsReportSection> => {
          const [outstandingCharges, paymentsReceived, pendingApprovalsCount] = await Promise.all([
            computeOutstandingCharges(academyId, filters),
            computePaymentsReceived(academyId, filters),
            computePendingPaymentApprovals(academyId, filters),
          ]);
          return { visible: true, outstandingCharges, paymentsReceived, pendingApprovalsCount };
        })()
      : Promise.resolve<StudentPaymentsReportSection>({ visible: false }),
    incomeLevel !== "none"
      ? computeIncomeTotals(academyId, filters).then(
          (totals): IncomeReportSection => ({ visible: true, ...totals }),
        )
      : Promise.resolve<IncomeReportSection>({ visible: false }),
    expensesLevel !== "none"
      ? (async (): Promise<ExpensesReportSection> => {
          const [totals, pendingApprovalsCount] = await Promise.all([
            computeExpenseTotals(academyId, filters),
            computePendingExpenseApprovals(academyId, filters),
          ]);
          return { visible: true, ...totals, pendingApprovalsCount };
        })()
      : Promise.resolve<ExpensesReportSection>({ visible: false }),
  ]);

  return {
    ok: true,
    report: {
      academyId,
      generatedAt: new Date(),
      filters: {
        dateFrom: filters.dateFrom ?? null,
        dateTo: filters.dateTo ?? null,
        branchId: filters.branchId ?? null,
        status: filters.status ?? null,
        method: filters.method ?? null,
      },
      studentPayments: studentPaymentsSection,
      income: incomeSection,
      expenses: expensesSection,
    },
  };
}
