import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { getBranchScope, inBranchScope, studentInScopeCondition, type BranchScope } from "@/lib/academies/branch-access";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  batchEnrollments,
  batches,
  branches,
  courses,
  enrollmentFeeSchedules,
  FEE_INTERVAL_MONTHS_OPTIONS,
  feePeriods,
  paymentAllocations,
  students,
  studentPayments,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_FEE_PERIODS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Student Fee Periods — a bounded, one-time course fee paid off in equal
 * MONTHLY installments, student-centered. See lib/db/schema.ts's module
 * comment above `enrollmentFeeSchedules` for the schema rationale (why fee
 * periods are their own tables, and why paid/remaining/status are computed
 * at read time instead of stored).
 *
 * ---------------------------------------------------------------------
 * Payment schedule model — read this before touching any of the
 * calculation/generation code below
 * ---------------------------------------------------------------------
 * `enrollment_fee_schedules.intervalMonths` (1/2/3/4/6/12) is the NUMBER OF
 * EQUAL MONTHLY INSTALLMENTS the schedule's `amountCents` — the schedule's
 * own TOTAL fee, for whichever phase of the enrollment's payment history is
 * currently active (see `setEnrollmentFeeSchedule`'s own doc comment on how
 * that total is derived across a schedule change) — is split into. "A
 * 6-month schedule" means SIX separate monthly charges summing to the
 * total (e.g. $36 over 6 months = $6/month × 6), never one lump
 * charge covering a 6-month-long period. This is a deliberate correction:
 * an earlier revision of this file treated `intervalMonths` as the LENGTH
 * of a single period (so "6 months" generated one $36, 6-calendar-month-
 * long `fee_periods` row) — that is exactly backwards from how an
 * installment plan actually works and is no longer how this file behaves.
 * Every `fee_periods` row this file ever generates spans EXACTLY one
 * calendar month, full stop, regardless of `intervalMonths`; see
 * `splitIntoMonthlyInstallments` (the one centralized, integer-cents
 * installment calculation every caller must go through — never divide
 * `amountCents` by `intervalMonths` inline anywhere else) and
 * `generateFeePeriodsForEnrollment`'s own doc comment for the full model,
 * including why a schedule is BOUNDED (exactly `intervalMonths`
 * installments, never more) rather than an open-ended recurring charge.
 *
 * Four distinct concepts, never conflated:
 *   - Schedule duration / installment count: `intervalMonths` (1..12).
 *   - Payment frequency: always monthly — there is no other frequency.
 *   - Monthly installment: `amountCents / intervalMonths`, rounded per
 *     `splitIntoMonthlyInstallments` — what the student actually owes per
 *     `fee_periods` row (`fee_periods.expectedAmountCents`).
 *   - Total fee: `enrollment_fee_schedules.amountCents` — the schedule's
 *     own total, never a per-period amount.
 *
 * ---------------------------------------------------------------------
 * Why fee-period payments reuse student_payments verbatim
 * ---------------------------------------------------------------------
 * A fee-period payment is created here (`recordFeePeriodPayment`) with
 * `chargeId: null` and one-or-more `payment_allocations` rows instead —
 * everything else (`student_payments` itself, `reverseStudentPayment`/
 * `adjustStudentPayment`, `issueReceipt`) is the EXACT existing code in
 * lib/academies/student-payments.ts and lib/academies/finance-reversals.ts,
 * unmodified. The payment is written `status: "approved"` directly and is
 * immediately effective — there is no approval workflow for student
 * payments (recurring or one-off charge) at all; see
 * lib/academies/student-payments.ts's own module comment for the full
 * "no approval workflow" architecture decision. Reversal/adjustment
 * remains the correction mechanism for a payment recorded in error.
 *
 * ---------------------------------------------------------------------
 * Permission gating
 * ---------------------------------------------------------------------
 * `ACADEMY_FEE_PERIODS_ACTION` mirrors `ACADEMY_STUDENT_PAYMENTS_ACTION`
 * row for row (see lib/auth/academy-permissions.ts) — same reasoning as
 * above: this is the same underlying financial capability.
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/**
 * The exact same predicate, exported for the Students-list page
 * (app/academy/students/page.tsx) to compute whether the CURRENT actor may
 * see/use the new per-student "Record Payment" action there — reused
 * verbatim rather than re-implemented, per the explicit "use the existing
 * payment-recording permission rules; do not create a special Students-list
 * permission" requirement. This is `ACADEMY_FEE_PERIODS_ACTION`'s own
 * "manage" gate (Manager/Finance Officer/Academy Administrator), completely
 * independent of `ACADEMY_STUDENTS_ACTION`'s own edit permission that
 * already gates that page's Edit/Archive/Delete actions — a Finance Officer
 * can have "view" on students but "manage" on fee periods, and must still
 * see this action.
 */
export { canManage as canManageFeePeriodPayments };

export interface FeePeriodActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: FeePeriodActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's fee periods.",
};

const ENROLLMENT_NOT_FOUND: FeePeriodActionError = {
  code: "not_found",
  message: "Enrollment not found.",
};

const STUDENT_NOT_FOUND: FeePeriodActionError = {
  code: "not_found",
  message: "Student not found.",
};

interface ResolvedFeePeriodsAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
  /** Multi-branch: fee periods belong to an enrollment, an enrollment to a
   * batch, and a batch to a branch — see lib/academies/branch-access.ts. */
  scope: BranchScope;
}

type ResolveFeePeriodsAccessResult =
  | { ok: true; access: ResolvedFeePeriodsAccess }
  | { ok: false; error: FeePeriodActionError };

async function resolveFeePeriodsAccess(actorContext: AuthContext): Promise<ResolveFeePeriodsAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION);
  if (permissionLevel === "none") {
    return { ok: false, error: FORBIDDEN };
  }
  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      permissionLevel,
      scope: await getBranchScope(access, actorContext.userId),
    },
  };
}

/** Exported for reuse by lib/academies/batch-assignments.ts's
 * `enrollStudentInBatch`, which resolves a payment plan's currency the same
 * way (client-supplied, else the academy's own default) inside its own
 * transaction before calling `createInitialEnrollmentFeeSchedule`. */
export async function resolveCurrency(executor: DbClient, academyId: string, provided: string | undefined): Promise<string> {
  if (provided) return provided;
  const [academy] = await executor
    .select({ defaultCurrency: academies.defaultCurrency })
    .from(academies)
    .where(eq(academies.id, academyId))
    .limit(1);
  return academy?.defaultCurrency ?? "USD";
}

// ===========================================================================
// Date-only arithmetic — fee_periods/enrollment_fee_schedules date columns
// come back from drizzle as plain "YYYY-MM-DD" strings, never Date objects
// (same convention as student_charges.dueDate elsewhere in this codebase).
// All arithmetic below stays in this string/UTC-parts domain deliberately,
// to avoid local-timezone drift shifting a period's boundary by a day.
// ===========================================================================

interface DateParts {
  y: number;
  m: number; // 1-12
  d: number;
}

function parseDateOnly(value: string): DateParts {
  const [y, m, d] = value.split("-").map(Number);
  return { y, m, d };
}

function formatDateOnly({ y, m, d }: DateParts): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Adds `months` whole calendar months, clamping the day to the resulting
 * month's actual length (e.g. Jan 31 + 1 month -> Feb 28/29, never Mar 3). */
function addMonths(parts: DateParts, months: number): DateParts {
  const totalMonths = (parts.m - 1) + months;
  const y = parts.y + Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(parts.d, lastDayOfMonth) };
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  date.setUTCDate(date.getUTCDate() + days);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function compareDateOnly(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function todayDateOnly(): string {
  const now = new Date();
  return formatDateOnly({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() });
}

const SOMALIA_UTC_OFFSET_HOURS = 3;

/**
 * "Today," as a calendar date in this product's one supported market's own
 * local time (Somalia, a fixed UTC+3 with no daylight-saving transitions —
 * so a flat +3-hour shift of the current instant, then reading its
 * calendar date in UTC terms, is a correct, deterministic way to compute
 * "today, Somalia time" regardless of what timezone the SERVER process
 * itself happens to run in (very likely UTC, not UTC+3, in most
 * deployments). This is deliberately a SEPARATE function from
 * `todayDateOnly()` above (plain UTC) rather than a replacement for it:
 * `todayDateOnly()`'s existing call sites (overdue-status reads, payment
 * summaries) are payment-calculation logic this task was explicitly told
 * not to change, and plain UTC vs. Somalia-local only disagree for a
 * 3-hour window once a day (21:00-24:00 UTC) — not worth the risk of
 * touching that unrelated logic to fix a bug this task didn't report there.
 *
 * Exported specifically for `enrollStudentInBatch`'s (batch-assignments.ts)
 * anchor-date default — see that call site's own comment for why
 * enrollment specifically needs the real Somalia calendar day: an
 * enrollment recorded late at night UTC could otherwise anchor to
 * "yesterday" by Somalia's own clock, one full calendar day off from the
 * staff member's and student's actual local "today."
 */
export function todayDateOnlyInAcademyTimezone(): string {
  const shifted = new Date(Date.now() + SOMALIA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return formatDateOnly({ y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() });
}

// ===========================================================================
// Enrollment fee schedule
// ===========================================================================

// z.union of literals (not z.number().refine) so invalid-value error
// messages and TS narrowing both stay precise, matching FEE_INTERVAL_MONTHS_OPTIONS
// (the single source of truth also enforced by the DB check constraint).
const intervalMonthsSchema = z.union(
  FEE_INTERVAL_MONTHS_OPTIONS.map((value) => z.literal(value)) as [
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
  { message: "Payment plan interval must be one of: 1, 2, 3, 4, 6, or 12 months." },
);

export const setEnrollmentFeeScheduleSchema = z.object({
  enrollmentId: z.string().uuid("Invalid enrollment id"),
  // The number of equal MONTHLY installments — see this file's own module
  // comment ("Payment schedule model"). Once the enrollment already has any
  // started installment, `amountCents`/`anchorDate` below are overridden
  // server-side regardless of what's submitted (see
  // `setEnrollmentFeeSchedule`'s own doc comment) — only `intervalMonths`
  // is ever actually taken from the caller in that case.
  intervalMonths: intervalMonthsSchema,
  // The schedule's TOTAL fee (never a per-installment amount) — see this
  // file's module comment. Honored as-is only when there is no existing
  // schedule, or the existing one has no started installments yet;
  // otherwise server-computed (remaining balance) — see
  // `setEnrollmentFeeSchedule`.
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD")
    .optional(),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid start date is required"),
});

export type SetEnrollmentFeeScheduleInput = z.input<typeof setEnrollmentFeeScheduleSchema>;

export interface EnrollmentFeeScheduleRecord {
  id: string;
  academyId: string;
  enrollmentId: string;
  /** Number of equal monthly installments — see this file's module
   * comment ("Payment schedule model"). NOT a period length. */
  intervalMonths: number;
  /** The schedule's TOTAL fee — NOT a per-installment amount. Use
   * `monthlyInstallmentCents` for the per-month figure. */
  amountCents: number;
  currency: string;
  anchorDate: string;
  /** Derived, never stored: `amountCents` split evenly across
   * `intervalMonths` installments (last one absorbs the remainder) — see
   * `splitIntoMonthlyInstallments`. This is "the monthly payment" the UI
   * should show (e.g. "$6.00/month"), distinct from `amountCents` (the
   * total). */
  monthlyInstallmentCents: number;
}

function toScheduleRecord(row: typeof enrollmentFeeSchedules.$inferSelect): EnrollmentFeeScheduleRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    enrollmentId: row.enrollmentId,
    intervalMonths: row.intervalMonths,
    amountCents: row.amountCents,
    currency: row.currency,
    anchorDate: row.anchorDate,
    monthlyInstallmentCents: splitIntoMonthlyInstallments(row.amountCents, row.intervalMonths)[0],
  };
}

/** Verifies an enrollment belongs to this academy (and, when supplied, to
 * this student) — the same "fetch, then compare academyId" cross-tenant
 * check used throughout this codebase (see student-payments.ts's own module
 * comment). Also resolves the batch/course for display purposes. */
async function getScopedEnrollment(
  executor: DbClient,
  enrollmentId: string,
  academyId: string,
  scope: BranchScope,
  studentId?: string,
) {
  const [row] = await executor
    .select({
      id: batchEnrollments.id,
      academyId: batchEnrollments.academyId,
      studentId: batchEnrollments.studentId,
      batchId: batchEnrollments.batchId,
      status: batchEnrollments.status,
      batchName: batches.name,
      courseName: courses.name,
      branchId: batches.branchId,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batchEnrollments.batchId, batches.id))
    .innerJoin(courses, eq(batchEnrollments.courseId, courses.id))
    .where(eq(batchEnrollments.id, enrollmentId))
    .limit(1);
  if (!row || row.academyId !== academyId) return null;
  if (studentId && row.studentId !== studentId) return null;
  // Outside the caller's branches: the same "not found" as a missing row.
  if (!inBranchScope(scope, row.branchId)) return null;
  return row;
}

export type SetEnrollmentFeeScheduleResult =
  | { ok: true; schedule: EnrollmentFeeScheduleRecord }
  | { ok: false; error: FeePeriodActionError };

/**
 * Creates or updates the one fee schedule an enrollment may have. Manager/
 * Finance Officer only (`canManage`).
 *
 * ---------------------------------------------------------------------
 * Changing an existing schedule: effective-date rule + auto-carried
 * remaining balance (approved product decision)
 * ---------------------------------------------------------------------
 * A period that has already STARTED (`periodStart <= today`) is never
 * touched by a schedule change, whether it's paid, partially paid, or
 * still unpaid/overdue — it stays exactly as generated under the OLD
 * schedule, full stop. That is the entire "protect financial history"
 * story; there is no separate carve-out needed for "paid" specifically,
 * because a period that has started but is still unpaid (the exact case
 * this product's own task spec calls out as "do not silently overwrite
 * the current unpaid period") is equally protected by the same
 * `periodStart <= today` test.
 *
 * When any such started period already exists, the caller's own
 * `amountCents`/`anchorDate` are NEVER used directly — both are
 * server-computed, authoritatively, so an admin changing the schedule
 * never needs to do (or risk getting wrong) the "how much is actually
 * left, and when does the new plan actually start" arithmetic themselves:
 *   - `amountCents` becomes the CURRENT schedule's own total minus the
 *     expected amounts of its kept installments (started or paid, kept
 *     with their own amounts whether paid, partly paid or unpaid). This
 *     is the "auto-carry the remaining balance" rule: restructuring a
 *     payment plan never changes the total a student owes for the course,
 *     only how the part not yet scheduled is split going forward.
 *     (Subtracting only what was PAID would charge a kept period's unpaid
 *     part twice: once on the period, once in the new plan.) If every
 *     installment of the current schedule is already kept, nothing is
 *     left to reschedule and the change is refused rather than adding
 *     charges beyond the course fee.
 *   - `anchorDate` becomes the day after the latest already-started
 *     period's own end date — "the new plan begins at the start of the
 *     next not-yet-started period," never today, never wherever the form
 *     happened to submit — regardless of whether the remaining-balance
 *     case above applies, since this is what prevents a new period from
 *     ever overlapping an already-started one.
 * Only `intervalMonths` (the new installment count) is ever actually
 * taken from the caller in that case. On a genuine first-time "Set fee
 * schedule" (no existing schedule at all), or when editing a schedule
 * that has no started installments yet (nothing paid, nothing to
 * protect), the caller's `amountCents`/`anchorDate` are used exactly as
 * submitted — there is no "remaining balance" to carry when nothing has
 * started.
 *
 * Separately: any NOT-YET-STARTED period (`periodStart > today`) — e.g.
 * the later installments of a 6-month plan that were generated eagerly
 * when it was first set up, before the admin shortens or restructures it
 * — is deleted and replaced under the new schedule, but ONLY if no
 * payment was ever allocated to it (nothing stops staff from recording an
 * advance payment against a not-yet-due period via its own per-row
 * "Record Payment" action, so this is a real possibility, not a
 * theoretical one). Any such period with so much as one
 * `payment_allocations` row is left exactly alone, matching the DB's own
 * FK (`payment_allocations.fee_period_id` has no ON DELETE clause —
 * Postgres would refuse the delete outright if this check were ever
 * skipped; this check exists so that refusal never happens as an
 * unhandled error).
 *
 * Once stale not-yet-started periods are gone and `anchorDate` has been
 * moved to the correct resume point, the existing, unmodified
 * `generateFeePeriodsForEnrollment` does the rest for free — this is what
 * makes "the new plan begins at the start of the next not-yet-started
 * period" fall out of already-existing, already-tested generation logic
 * rather than a second, parallel period-generation implementation.
 */
export async function setEnrollmentFeeSchedule(
  actorContext: AuthContext,
  input: SetEnrollmentFeeScheduleInput,
): Promise<SetEnrollmentFeeScheduleResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, scope } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = setEnrollmentFeeScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const enrollment = await getScopedEnrollment(tx, data.enrollmentId, academyId, scope);
    if (!enrollment) return { kind: "not_found" as const };

    const currency = await resolveCurrency(tx, academyId, data.currency);

    // For the audit log's "before" value, AND (below) to decide whether
    // this is a genuine change to an already-active schedule versus a
    // first-time setup.
    // Locked so two concurrent changes can't both carry from the same state.
    const [existingForAudit] = await tx
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, data.enrollmentId))
      .limit(1)
      .for("update");

    const today = todayDateOnlyInAcademyTimezone();
    const existingPeriods = existingForAudit
      ? await tx
          .select({
            id: feePeriods.id,
            periodStart: feePeriods.periodStart,
            periodEnd: feePeriods.periodEnd,
            expectedAmountCents: feePeriods.expectedAmountCents,
          })
          .from(feePeriods)
          .where(eq(feePeriods.enrollmentId, data.enrollmentId))
      : [];
    const startedPeriods = existingPeriods.filter((period) => period.periodStart <= today);

    // A period must be protected from the "fresh start" branch below not
    // only once it has STARTED, but also the moment ANY payment has been
    // allocated to it — nothing stops staff from recording an advance
    // payment against a not-yet-due period via its own per-row Record
    // Payment action, including the very first (and, for a 1-installment
    // schedule, only) period an enrollment ever has. Bug this fixes: if
    // that one period is paid before anything has "started" yet, and the
    // schedule is then edited (e.g. correcting a wrong anchor date), the
    // old `startedPeriods`-only check saw zero protected periods and let
    // the submitted anchor create a brand-new, disconnected period —
    // orphaning the paid one (still in the DB, still correctly referenced
    // by Payment History, but no longer "current") while the schedule
    // silently doubled its real installment count. See fee-periods.test.ts
    // regression for the exact reported shape.
    const notYetStartedPeriods = existingPeriods.filter((period) => period.periodStart > today);
    const notYetStartedAllocatedIds =
      notYetStartedPeriods.length > 0
        ? new Set(
            (
              await tx
                .select({ feePeriodId: paymentAllocations.feePeriodId })
                .from(paymentAllocations)
                .where(inArray(paymentAllocations.feePeriodId, notYetStartedPeriods.map((period) => period.id)))
            ).map((row) => row.feePeriodId),
          )
        : new Set<string>();
    const protectedPeriods = [
      ...startedPeriods,
      ...notYetStartedPeriods.filter((period) => notYetStartedAllocatedIds.has(period.id)),
    ];

    let effectiveAmountCents = data.amountCents;
    let effectiveAnchorDate = data.anchorDate;

    if (existingForAudit && protectedPeriods.length > 0) {
      // The resume point moves past every protected installment —
      // started, paid, or both — regardless of the remaining-balance case
      // below. This is what keeps a schedule change from ever overlapping
      // a historical OR an advance-paid period.
      const latestProtectedPeriodEnd = protectedPeriods.reduce(
        (latest, period) => (compareDateOnly(period.periodEnd, latest) > 0 ? period.periodEnd : latest),
        protectedPeriods[0].periodEnd,
      );
      effectiveAnchorDate = formatDateOnly(addDays(parseDateOnly(latestProtectedPeriodEnd), 1));

      // What carries into the new plan is the part of the current
      // schedule's total that no kept period already charges. Kept periods
      // keep their own expected amounts (paid, partly paid or unpaid), so
      // subtracting only what was PAID would charge their unpaid part a
      // second time. Only kept periods of the CURRENT schedule count here
      // (they start on or after its anchor); periods kept from an earlier
      // schedule were already outside this schedule's total when it was
      // set. Payments, allocations and receipts are never touched.
      const keptExpectedCents = protectedPeriods
        .filter((period) => compareDateOnly(period.periodStart, existingForAudit.anchorDate) >= 0)
        .reduce((sum, period) => sum + period.expectedAmountCents, 0);
      const carriedCents = existingForAudit.amountCents - keptExpectedCents;

      // Every installment of the current plan is already kept, so a new
      // plan could only add charges beyond the course fee. Refused rather
      // than treating the submitted amount as a fresh fee.
      if (carriedCents <= 0) return { kind: "nothing_to_reschedule" as const };
      effectiveAmountCents = carriedCents;
    }

    // Atomic upsert targeting the table's own unique(enrollment_id) index —
    // replaces the previous unsafe "select, then insert-or-update" pattern,
    // which had a real TOCTOU race: two concurrent first-time calls could
    // both see "no existing row" and both attempt an insert, with the loser
    // throwing an uncaught unique-violation instead of cleanly updating.
    const [row] = await tx
      .insert(enrollmentFeeSchedules)
      .values({
        academyId,
        enrollmentId: data.enrollmentId,
        intervalMonths: data.intervalMonths,
        amountCents: effectiveAmountCents,
        currency,
        anchorDate: effectiveAnchorDate,
        createdBy: actorContext.userId,
      })
      .onConflictDoUpdate({
        target: enrollmentFeeSchedules.enrollmentId,
        set: {
          intervalMonths: data.intervalMonths,
          amountCents: effectiveAmountCents,
          currency,
          anchorDate: effectiveAnchorDate,
          updatedAt: new Date(),
        },
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: existingForAudit ? "updateEnrollmentFeeSchedule" : "createEnrollmentFeeSchedule",
        entityType: "enrollment_fee_schedule",
        entityId: row.id,
        before: existingForAudit ? toScheduleRecord(existingForAudit) : undefined,
        after: toScheduleRecord(row),
      },
      tx,
    );

    if (existingPeriods.length > 0) {
      // `candidateIds` here is always exactly `notYetStartedPeriods.map(id)`
      // above (both filter the same `existingPeriods` array by the same
      // `periodStart > today` condition) — so "which of these already have
      // a payment allocation" was already answered by `notYetStartedAllocatedIds`
      // a few lines up. Perf investigation (Afoogy slow-dashboard task,
      // measured): this function was issuing the identical
      // `paymentAllocations` lookup, for the identical set of ids, twice —
      // reusing that result removes one of this function's ~10 sequential
      // Neon round trips (confirmed ~300ms each) with zero behavior change.
      const candidateIds = existingPeriods.filter((period) => period.periodStart > today).map((period) => period.id);

      if (candidateIds.length > 0) {
        const deletableIds = candidateIds.filter((id) => !notYetStartedAllocatedIds.has(id));
        if (deletableIds.length > 0) {
          await tx.delete(feePeriods).where(inArray(feePeriods.id, deletableIds));
        }
      }

      await generateFeePeriodsForEnrollment(tx, data.enrollmentId, academyId);
    }

    return { kind: "ok" as const, row };
  });

  if (result.kind === "not_found") return { ok: false, error: ENROLLMENT_NOT_FOUND };
  if (result.kind === "nothing_to_reschedule") {
    return {
      ok: false,
      error: {
        code: "validation",
        message:
          "Every installment of the current plan has started or been paid, so there is nothing left to reschedule. Changing the plan now would charge more than the course fee.",
      },
    };
  }
  return { ok: true, schedule: toScheduleRecord(result.row) };
}

export type GetEnrollmentFeeScheduleResult =
  | { ok: true; schedule: EnrollmentFeeScheduleRecord | null }
  | { ok: false; error: FeePeriodActionError };

export async function getEnrollmentFeeSchedule(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<GetEnrollmentFeeScheduleResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, scope } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId, scope);
  if (!enrollment) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const [row] = await db
    .select()
    .from(enrollmentFeeSchedules)
    .where(eq(enrollmentFeeSchedules.enrollmentId, enrollmentId))
    .limit(1);

  return { ok: true, schedule: row ? toScheduleRecord(row) : null };
}

// ===========================================================================
// Fee period generation — deterministic, idempotent, race-safe via the
// (enrollment_id, period_start, period_end) unique constraint.
// ===========================================================================

/**
 * The ONE authoritative calculation for "how much is each monthly
 * installment" — see this file's own module comment ("Payment schedule
 * model") for why every caller must go through this rather than dividing
 * `amountCents` by `intervalMonths` inline. Integer-cents only, no
 * floating-point money math (same rule as lib/ui/money.ts): `totalCents`
 * divides evenly into `count` installments of `Math.floor(totalCents /
 * count)` each, with the LAST installment absorbing whatever remainder is
 * left over (e.g. $100 over 3 months -> $33.33, $33.33, $33.34) — so the
 * installments always sum to EXACTLY `totalCents`, never a cent more or
 * less, regardless of how unevenly it divides.
 */
export function splitIntoMonthlyInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const installments = new Array<number>(count).fill(base);
  installments[count - 1] = totalCents - base * (count - 1);
  return installments;
}

/**
 * Generates every monthly installment still owed for this enrollment's
 * CURRENT fee schedule — see this file's own module comment ("Payment
 * schedule model") for the full model this implements. A no-op when the
 * enrollment has no fee schedule. Safe to call repeatedly —
 * already-existing periods are left untouched, and once all
 * `schedule.intervalMonths` installments exist, calling this again does
 * nothing more: a fee schedule is a bounded, one-time total, never an
 * open-ended recurring charge that keeps generating as time passes.
 *
 * Every period this function ever creates spans EXACTLY one calendar
 * month (`periodEnd` is the day before the same day-of-month one month
 * later, clamped the same way `addMonths` always has), with
 * `expectedAmountCents` set from `splitIntoMonthlyInstallments`.
 * `fee_periods.intervalMonths` still records the SCHEDULE's own
 * installment count the period was generated under (never "1") — a
 * historical/display label, decoupled from the period's own always-1-
 * month length (see that column's own schema comment).
 *
 * ---------------------------------------------------------------------
 * Resume point / overlap safety (unchanged reasoning from the original
 * fix, now also used to count how many of the CURRENT schedule's own
 * installments already exist)
 * ---------------------------------------------------------------------
 * `enrollment_fee_schedules` holds exactly ONE row per enrollment
 * (`setEnrollmentFeeSchedule` upserts onto it, and — see its own doc
 * comment — moves `anchorDate` itself forward past any already-started
 * periods whenever a schedule change needs to). Walking from
 * `schedule.anchorDate` and counting CONTIGUOUS existing periods (one per
 * calendar month, starting exactly at `anchorDate`) tells this function
 * both (a) where to resume — the first calendar month after the last
 * contiguous one — and (b) how many of the schedule's `intervalMonths`
 * installments already exist, without needing any extra persisted state.
 * A period is only ever counted as "already generated" for the CURRENT
 * schedule if it sits exactly in that contiguous run from `anchorDate`;
 * `setEnrollmentFeeSchedule` is responsible for making sure nothing from
 * a PRIOR schedule phase can be mistaken for one of these by moving
 * `anchorDate` past it first. This never touches, rewrites, or deletes an
 * existing `fee_periods` row — historical periods (paid or not) are
 * exactly as untouched as before, and a genuinely unusual survivor (e.g.
 * an advance-paid not-yet-started period that outlived a schedule change
 * — see `setEnrollmentFeeSchedule`'s own doc comment) simply breaks the
 * contiguous run at that point: this function then safely fills in
 * whatever calendar months are actually missing before it (never
 * overlapping it, since `onConflictDoNothing` on the exact
 * `(enrollment_id, period_start, period_end)` unique index silently skips
 * any month that collides with it), rather than skipping past it.
 */
export async function generateFeePeriodsForEnrollment(
  executor: DbClient,
  enrollmentId: string,
  academyId: string,
): Promise<void> {
  // Performance plan P9: the schedule and the existing periods are
  // independent reads, so they go out together (one round trip instead of
  // two on the common no-op path). Inside a transaction the same client
  // simply runs them in order.
  const [[schedule], existingPeriods] = await Promise.all([
    executor
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, enrollmentId))
      .limit(1),
    executor
      .select({ periodStart: feePeriods.periodStart })
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, enrollmentId)),
  ]);
  if (!schedule) return;

  const existingStartDates = new Set(existingPeriods.map((row) => row.periodStart));

  let cursor = parseDateOnly(schedule.anchorDate);
  let installmentsAlreadyGenerated = 0;
  while (installmentsAlreadyGenerated < schedule.intervalMonths && existingStartDates.has(formatDateOnly(cursor))) {
    installmentsAlreadyGenerated += 1;
    cursor = addMonths(cursor, 1);
  }

  const installments = splitIntoMonthlyInstallments(schedule.amountCents, schedule.intervalMonths);

  // Perf investigation (Afoogy slow-dashboard task): previously issued one
  // sequential INSERT per remaining installment — up to `intervalMonths`
  // round trips (12, for a 12-month schedule), each paying this project's
  // own ~200-300ms Neon round-trip cost. That's the dominant cause of
  // setEnrollmentFeeSchedule's and enrollStudentInBatch's own test
  // timeouts (both call this function) — not query execution, round-trip
  // count. A single multi-row INSERT with the same `ON CONFLICT DO
  // NOTHING` produces the exact same rows: Postgres resolves the
  // (enrollment_id, period_start, period_end) exclusion/unique conflict
  // per inserted row, same as the removed per-row try/catch
  // (isUniqueViolation) — in one round trip instead of up to N. No two
  // rows in this batch can conflict with each other (`cursor` strictly
  // advances one month per entry for this one enrollmentId), only
  // (harmlessly) with rows a concurrent call already committed.
  const rowsToInsert: (typeof feePeriods.$inferInsert)[] = [];
  for (let installmentIndex = installmentsAlreadyGenerated; installmentIndex < schedule.intervalMonths; installmentIndex += 1) {
    const periodStart = formatDateOnly(cursor);
    const periodEnd = formatDateOnly(addDays(addMonths(cursor, 1), -1));
    rowsToInsert.push({
      academyId,
      enrollmentId,
      intervalMonths: schedule.intervalMonths,
      periodStart,
      periodEnd,
      dueDate: periodStart,
      expectedAmountCents: installments[installmentIndex],
      currency: schedule.currency,
    });
    cursor = addMonths(cursor, 1);
  }

  if (rowsToInsert.length > 0) {
    await executor.insert(feePeriods).values(rowsToInsert).onConflictDoNothing();
  }
}

// ===========================================================================
// Enrollment-time fee-schedule creation — a deliberately bare, permission-
// agnostic insert, NOT a wrapper around `setEnrollmentFeeSchedule`.
//
// This is the "narrowly scoped enrollment capability, not general
// fee-schedule management" boundary from the approved architecture review:
// `enrollStudentInBatch` (lib/academies/batch-assignments.ts) already
// authorizes the caller against its OWN permission row
// (`ACADEMY_COURSES_BATCHES_ACTION`) before ever reaching this function, so
// this function does no authorization of its own and must never be
// exported for direct use outside that one call site. It does not go
// through `resolveFeePeriodsAccess`/`ACADEMY_FEE_PERIODS_ACTION` at all —
// enrolling a student does NOT grant the enroller any standing ability to
// later modify that (or any other) fee schedule; changing an existing
// schedule after enrollment still requires `setEnrollmentFeeSchedule`'s own
// `ACADEMY_FEE_PERIODS_ACTION` gate, completely unaffected by this.
//
// Always a plain INSERT (never an upsert): `enrollmentId` is freshly
// generated by the caller's own just-inserted `batch_enrollments` row in
// the same transaction, so no prior schedule can exist for it and no
// unique-violation race is possible here (unlike `setEnrollmentFeeSchedule`,
// which really can race on an existing enrollment).
// ===========================================================================

export interface CreateInitialEnrollmentFeeScheduleInput {
  academyId: string;
  enrollmentId: string;
  intervalMonths: number;
  amountCents: number;
  currency: string;
  anchorDate: string;
  createdBy: string;
}

export async function createInitialEnrollmentFeeSchedule(
  executor: DbClient,
  input: CreateInitialEnrollmentFeeScheduleInput,
): Promise<typeof enrollmentFeeSchedules.$inferSelect> {
  const [row] = await executor
    .insert(enrollmentFeeSchedules)
    .values({
      academyId: input.academyId,
      enrollmentId: input.enrollmentId,
      intervalMonths: input.intervalMonths,
      amountCents: input.amountCents,
      currency: input.currency,
      anchorDate: input.anchorDate,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

// ===========================================================================
// Reading fee periods with derived paid/remaining/status
// ===========================================================================

export type FeePeriodStatus = "unpaid" | "partially_paid" | "paid" | "overdue";

export interface FeePeriodRecord {
  id: string;
  enrollmentId: string;
  intervalMonths: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  expectedAmountCents: number;
  currency: string;
  paidCents: number;
  remainingCents: number;
  status: FeePeriodStatus;
}

export function computeFeePeriodStatus(
  expectedCents: number,
  paidCents: number,
  dueDate: string,
  today: string = todayDateOnly(),
): FeePeriodStatus {
  const remaining = expectedCents - paidCents;
  if (remaining <= 0) return "paid";
  if (compareDateOnly(dueDate, today) < 0) return "overdue";
  return paidCents > 0 ? "partially_paid" : "unpaid";
}

/** Sums only APPROVED payments' allocations — pending/rejected/reversed
 * payments never contribute, same rule as recalculateStudentChargeStatus in
 * student-payments.ts. Returns a Map from fee_period id to paid cents;
 * periods with no approved allocations are simply absent (treat as 0). */
export async function getApprovedPaidCentsByPeriod(
  executor: DbClient,
  feePeriodIds: string[],
): Promise<Map<string, number>> {
  if (feePeriodIds.length === 0) return new Map();
  const rows = await executor
    .select({
      feePeriodId: paymentAllocations.feePeriodId,
      paid: sql<string>`coalesce(sum(${paymentAllocations.amountCents}), 0)`,
    })
    .from(paymentAllocations)
    .innerJoin(studentPayments, eq(paymentAllocations.studentPaymentId, studentPayments.id))
    .where(and(inArray(paymentAllocations.feePeriodId, feePeriodIds), eq(studentPayments.status, "approved")))
    .groupBy(paymentAllocations.feePeriodId);
  return new Map(rows.map((row) => [row.feePeriodId, Number(row.paid)]));
}

function toFeePeriodRecord(
  row: typeof feePeriods.$inferSelect,
  paidCents: number,
  today: string,
): FeePeriodRecord {
  return {
    id: row.id,
    enrollmentId: row.enrollmentId,
    intervalMonths: row.intervalMonths,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    dueDate: row.dueDate,
    expectedAmountCents: row.expectedAmountCents,
    currency: row.currency,
    paidCents,
    remainingCents: Math.max(0, row.expectedAmountCents - paidCents),
    status: computeFeePeriodStatus(row.expectedAmountCents, paidCents, row.dueDate, today),
  };
}

export type ListFeePeriodsResult =
  | { ok: true; enrollment: { id: string; studentId: string; batchName: string; courseName: string }; periods: FeePeriodRecord[]; canManage: boolean }
  | { ok: false; error: FeePeriodActionError };

/** Lazily generates any periods due to exist up through today, then returns
 * every period for this enrollment with paid/remaining/status derived live. */
export async function listFeePeriodsForEnrollment(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<ListFeePeriodsResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel, scope } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId, scope);
  if (!enrollment) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  await generateFeePeriodsForEnrollment(db, enrollmentId, academyId);

  const rows = await db
    .select()
    .from(feePeriods)
    .where(eq(feePeriods.enrollmentId, enrollmentId));

  const today = todayDateOnly();
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, rows.map((row) => row.id));
  const periods = rows
    .map((row) => toFeePeriodRecord(row, paidByPeriod.get(row.id) ?? 0, today))
    .sort((a, b) => compareDateOnly(a.periodStart, b.periodStart));

  return {
    ok: true,
    enrollment: {
      id: enrollment.id,
      studentId: enrollment.studentId,
      batchName: enrollment.batchName,
      courseName: enrollment.courseName,
    },
    periods,
    canManage: canManage(permissionLevel),
  };
}

export interface StudentEnrollmentOption {
  id: string;
  batchId: string;
  batchName: string;
  batchCode: string;
  courseId: string;
  courseName: string;
  enrolledAt: Date;
  status: "active" | "withdrawn" | "completed";
  /** The batch's own lifecycle status (planned, active, completed, archived). */
  batchStatus: "planned" | "active" | "completed" | "archived";
  branchName: string;
}

export type ListEnrollmentsForStudentResult =
  | { ok: true; enrollments: StudentEnrollmentOption[] }
  | { ok: false; error: FeePeriodActionError };

/** Powers the "Select Enrollment" step of Record Payment (§13-14) — every
 * enrollment this student has ever had in this academy, tenant-scoped. */
export async function listEnrollmentsForStudent(
  actorContext: AuthContext,
  studentId: string,
): Promise<ListEnrollmentsForStudentResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, scope } = resolved.access;

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) return { ok: false, error: STUDENT_NOT_FOUND };

  const [student] = await db
    .select({ id: students.id, academyId: students.academyId, branchId: students.branchId })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student || student.academyId !== academyId || !inBranchScope(scope, student.branchId)) {
    return { ok: false, error: STUDENT_NOT_FOUND };
  }

  const rows = await db
    .select({
      id: batchEnrollments.id,
      status: batchEnrollments.status,
      batchId: batchEnrollments.batchId,
      batchName: batches.name,
      batchCode: batches.code,
      courseId: batchEnrollments.courseId,
      courseName: courses.name,
      enrolledAt: batchEnrollments.enrolledAt,
      batchStatus: batches.status,
      branchName: branches.name,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batchEnrollments.batchId, batches.id))
    .innerJoin(branches, eq(batches.branchId, branches.id))
    .innerJoin(courses, eq(batchEnrollments.courseId, courses.id))
    .where(and(eq(batchEnrollments.studentId, studentId), eq(batchEnrollments.academyId, academyId)))
    .orderBy(batchEnrollments.enrolledAt);

  return { ok: true, enrollments: rows };
}

// ===========================================================================
// Recording a fee-period payment (§12-20) — reuses student_payments/
// approval_requests exactly as recordStudentPayment does.
// ===========================================================================

const allocationSchema = z.object({
  feePeriodId: z.string().uuid("Invalid fee period id"),
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
});

export const recordFeePeriodPaymentSchema = z.object({
  studentId: z.string().uuid("Invalid student id"),
  enrollmentId: z.string().uuid("Invalid enrollment id"),
  allocations: z.array(allocationSchema).min(1, "Select at least one fee period"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD")
    .optional(),
  method: z.enum(["cash", "mobile_money", "bank_transfer"]),
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  // Distinct from `reference` (a transaction/reference number) — free-form
  // staff notes, e.g. "Second installment".
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
});

export type RecordFeePeriodPaymentInput = z.input<typeof recordFeePeriodPaymentSchema>;

export interface FeePeriodPaymentRecord {
  id: string;
  studentId: string;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  allocations: { feePeriodId: string; amountCents: number }[];
}

export type RecordFeePeriodPaymentResult =
  | { ok: true; payment: FeePeriodPaymentRecord }
  | { ok: false; error: FeePeriodActionError };

/**
 * §12-20 in one action: validates the student/enrollment/every fee period
 * belong to each other and to this academy, rejects any allocation that
 * would push a period's already-APPROVED paid total past its expected
 * amount (no overpayment support — §22), then inserts one `student_payments`
 * row (amount = sum of allocations, never a separately client-supplied
 * total) — written as `status: "approved"` directly, immediately effective,
 * per the "no approval workflow for student payments" architecture decision
 * — plus one `payment_allocations` row per period. No `approval_requests`
 * row is created; the payment counts toward its fee period(s)' balance the
 * instant this transaction commits.
 */
export async function recordFeePeriodPayment(
  actorContext: AuthContext,
  input: RecordFeePeriodPaymentInput,
): Promise<RecordFeePeriodPaymentResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, scope } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = recordFeePeriodPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  // Reject a client-side duplicate period in the same submission up front —
  // the DB unique constraint would also catch it, but this gives a clearer
  // message than a generic conflict.
  const periodIds = data.allocations.map((allocation) => allocation.feePeriodId);
  if (new Set(periodIds).size !== periodIds.length) {
    return { ok: false, error: { code: "validation", message: "Each fee period may only be selected once per payment." } };
  }

  const result = await db.transaction(async (tx) => {
    const [student] = await tx
      .select({ id: students.id, academyId: students.academyId, branchId: students.branchId })
      .from(students)
      .where(eq(students.id, data.studentId))
      .limit(1);
    if (!student || student.academyId !== academyId || !inBranchScope(scope, student.branchId)) {
      return { kind: "student_not_found" as const };
    }

    const enrollment = await getScopedEnrollment(tx, data.enrollmentId, academyId, scope, data.studentId);
    if (!enrollment) {
      return { kind: "enrollment_not_found" as const };
    }

    const periods = await tx
      .select()
      .from(feePeriods)
      .where(and(inArray(feePeriods.id, periodIds), eq(feePeriods.enrollmentId, data.enrollmentId)))
      .for("update");
    if (periods.length !== periodIds.length) {
      return { kind: "period_not_found" as const };
    }

    const paidByPeriod = await getApprovedPaidCentsByPeriod(tx, periodIds);
    for (const allocation of data.allocations) {
      const period = periods.find((row) => row.id === allocation.feePeriodId);
      if (!period) continue; // unreachable — already checked above
      const remaining = period.expectedAmountCents - (paidByPeriod.get(period.id) ?? 0);
      if (allocation.amountCents > remaining) {
        return {
          kind: "exceeds_balance" as const,
          periodStart: period.periodStart,
          remainingCents: Math.max(0, remaining),
        };
      }
    }

    const totalAmountCents = data.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    const currency = await resolveCurrency(tx, academyId, data.currency);
    const now = new Date();

    const [payment] = await tx
      .insert(studentPayments)
      .values({
        academyId,
        studentId: data.studentId,
        chargeId: null,
        amountCents: totalAmountCents,
        currency,
        method: data.method,
        reference: data.reference,
        notes: data.notes,
        receivedAt: data.receivedAt,
        recordedBy: actorContext.userId,
        status: "approved",
        approvedBy: actorContext.userId,
        approvedAt: now,
      })
      .returning();

    const allocationRows = await tx
      .insert(paymentAllocations)
      .values(
        data.allocations.map((allocation) => ({
          academyId,
          studentPaymentId: payment.id,
          feePeriodId: allocation.feePeriodId,
          amountCents: allocation.amountCents,
        })),
      )
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "recordFeePeriodPayment",
        entityType: "student_payment",
        entityId: payment.id,
        after: { ...payment, allocations: allocationRows },
      },
      tx,
    );

    return { kind: "ok" as const, payment, allocations: allocationRows };
  });

  if (result.kind === "student_not_found") return { ok: false, error: STUDENT_NOT_FOUND };
  if (result.kind === "enrollment_not_found") return { ok: false, error: ENROLLMENT_NOT_FOUND };
  if (result.kind === "period_not_found") {
    return { ok: false, error: { code: "not_found", message: "One or more selected fee periods were not found for this enrollment." } };
  }
  if (result.kind === "exceeds_balance") {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `Amount exceeds the outstanding balance for the period starting ${result.periodStart} (remaining: ${result.remainingCents} cents). Overpayment is not supported.`,
      },
    };
  }

  return {
    ok: true,
    payment: {
      id: result.payment.id,
      studentId: result.payment.studentId,
      amountCents: result.payment.amountCents,
      currency: result.payment.currency,
      method: result.payment.method,
      status: result.payment.status,
      allocations: result.allocations.map((row) => ({ feePeriodId: row.feePeriodId, amountCents: row.amountCents })),
    },
  };
}

// ===========================================================================
// Simple "enter one amount" recording — the Afoogy manual student-payment
// verification report's required UX ("select student -> enter amount paid
// -> save -> update balance -> record history," one flat form with Total
// Fee/Previously Paid/Remaining/Amount Paid Now, no per-period checkboxes).
//
// This is a thin wrapper, not a parallel code path: it computes which
// period(s) the entered amount covers (oldest outstanding period first,
// same "no overpayment" rule as before) and then calls the exact same,
// already-validated `recordFeePeriodPayment` above with that explicit
// allocation list — every guarantee that function already provides
// (tenant scoping, row-locked balance re-check at write time, immediate
// "approved" status, audit logging, no approval workflow) applies here
// unchanged. `recordFeePeriodPayment`'s manual multi-period allocation
// capability is kept, not removed, for any caller that still needs it.
// ===========================================================================

export const recordEnrollmentPaymentSchema = z.object({
  studentId: z.string().uuid("Invalid student id"),
  enrollmentId: z.string().uuid("Invalid enrollment id"),
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD")
    .optional(),
  method: z.enum(["cash", "mobile_money", "bank_transfer"]),
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
});

export type RecordEnrollmentPaymentInput = z.input<typeof recordEnrollmentPaymentSchema>;

/**
 * Loads every outstanding (remainingCents > 0) fee period for this
 * enrollment via `listFeePeriodsForEnrollment` (already lazily generates
 * through today and computes remaining live), sorted oldest-due first, then
 * greedily consumes the entered amount into each period's remaining balance
 * in turn — a normal single-period payment lands on exactly one
 * allocation, same as before; a larger payment (or one recorded against a
 * student who has fallen behind) spans as many periods as it covers.
 *
 * Mirrors `recordFeePeriodPayment`'s own overpayment rule at the aggregate
 * level: an amount exceeding the TOTAL outstanding balance across every
 * currently-existing period is refused outright (no partial application),
 * with a `conflict` error naming the maximum acceptable amount — this never
 * silently drops money or invents a new period to absorb the excess.
 */
export async function recordEnrollmentPayment(
  actorContext: AuthContext,
  input: RecordEnrollmentPaymentInput,
): Promise<RecordFeePeriodPaymentResult> {
  const parsed = recordEnrollmentPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const periodsResult = await listFeePeriodsForEnrollment(actorContext, data.enrollmentId);
  if (!periodsResult.ok) return periodsResult;

  const outstanding = periodsResult.periods
    .filter((period) => period.remainingCents > 0)
    .sort((a, b) => compareDateOnly(a.periodStart, b.periodStart));

  let remaining = data.amountCents;
  const allocations: { feePeriodId: string; amountCents: number }[] = [];
  for (const period of outstanding) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, period.remainingCents);
    allocations.push({ feePeriodId: period.id, amountCents: take });
    remaining -= take;
  }

  if (allocations.length === 0) {
    return { ok: false, error: { code: "validation", message: "There is no outstanding balance to record a payment against." } };
  }
  if (remaining > 0) {
    const totalOutstandingCents = outstanding.reduce((sum, period) => sum + period.remainingCents, 0);
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `Amount exceeds the total outstanding balance (${totalOutstandingCents} cents). Overpayment is not supported.`,
      },
    };
  }

  return recordFeePeriodPayment(actorContext, {
    studentId: data.studentId,
    enrollmentId: data.enrollmentId,
    allocations,
    currency: data.currency,
    method: data.method,
    reference: data.reference,
    notes: data.notes,
    receivedAt: data.receivedAt,
  });
}

// ===========================================================================
// Fee-period payment history (§24) — student_payments rows that carry
// allocations, joined back to their fee periods/enrollment/batch/course.
// ===========================================================================

export interface FeePeriodPaymentHistoryRow {
  paymentId: string;
  studentId: string;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  receivedAt: Date;
  recordedBy: string;
  courseName: string;
  batchName: string;
  intervalMonths: number;
  /** One entry per allocation. A payment can fund periods of several
   * enrollments, so each carries its own course and batch. */
  periods: {
    feePeriodId: string;
    enrollmentId: string;
    periodStart: string;
    periodEnd: string;
    amountCents: number;
    courseName: string;
    batchName: string;
  }[];
}

export type ListFeePeriodPaymentHistoryResult =
  | { ok: true; rows: FeePeriodPaymentHistoryRow[] }
  | { ok: false; error: FeePeriodActionError };

export async function listFeePeriodPaymentHistory(
  actorContext: AuthContext,
  filters: { studentId?: string; enrollmentId?: string; paymentIds?: string[] } = {},
): Promise<ListFeePeriodPaymentHistoryResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, scope } = resolved.access;

  const conditions = [eq(studentPayments.academyId, academyId)];
  const historyScope = studentInScopeCondition(scope, academyId, studentPayments.studentId);
  if (historyScope) conditions.push(historyScope);
  if (filters.studentId) conditions.push(eq(studentPayments.studentId, filters.studentId));
  if (filters.enrollmentId) conditions.push(eq(feePeriods.enrollmentId, filters.enrollmentId));
  if (filters.paymentIds) {
    if (filters.paymentIds.length === 0) return { ok: true, rows: [] };
    conditions.push(inArray(studentPayments.id, filters.paymentIds));
  }

  const rows = await db
    .select({
      paymentId: studentPayments.id,
      studentId: studentPayments.studentId,
      amountCents: studentPayments.amountCents,
      currency: studentPayments.currency,
      method: studentPayments.method,
      status: studentPayments.status,
      receivedAt: studentPayments.receivedAt,
      recordedBy: studentPayments.recordedBy,
      allocationAmountCents: paymentAllocations.amountCents,
      feePeriodId: feePeriods.id,
      enrollmentId: feePeriods.enrollmentId,
      periodStart: feePeriods.periodStart,
      periodEnd: feePeriods.periodEnd,
      intervalMonths: feePeriods.intervalMonths,
      courseName: courses.name,
      batchName: batches.name,
    })
    .from(paymentAllocations)
    .innerJoin(studentPayments, eq(paymentAllocations.studentPaymentId, studentPayments.id))
    .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
    .innerJoin(batchEnrollments, eq(feePeriods.enrollmentId, batchEnrollments.id))
    .innerJoin(batches, eq(batchEnrollments.batchId, batches.id))
    .innerJoin(courses, eq(batchEnrollments.courseId, courses.id))
    .where(and(...conditions));

  const byPayment = new Map<string, FeePeriodPaymentHistoryRow>();
  for (const row of rows) {
    let entry = byPayment.get(row.paymentId);
    if (!entry) {
      entry = {
        paymentId: row.paymentId,
        studentId: row.studentId,
        amountCents: row.amountCents,
        currency: row.currency,
        method: row.method,
        status: row.status,
        receivedAt: row.receivedAt,
        recordedBy: row.recordedBy,
        courseName: row.courseName,
        batchName: row.batchName,
        intervalMonths: row.intervalMonths,
        periods: [],
      };
      byPayment.set(row.paymentId, entry);
    }
    entry.periods.push({
      feePeriodId: row.feePeriodId,
      enrollmentId: row.enrollmentId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      amountCents: row.allocationAmountCents,
      courseName: row.courseName,
      batchName: row.batchName,
    });
  }

  return { ok: true, rows: [...byPayment.values()].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()) };
}

// ===========================================================================
// Enrollment payment summary — derived, never stored, so it can never go
// stale (the approved architecture's explicit requirement). A brand-new
// enrollment reads UNPAID because no approved payment exists yet — never
// because of any special-cased "new enrollment" branch.
// ===========================================================================

export type EnrollmentPaymentStatus = "unpaid" | "partially_paid" | "paid" | "overdue";

export interface EnrollmentPaymentSummary {
  enrollmentId: string;
  expectedCents: number;
  paidCents: number;
  remainingCents: number;
  status: EnrollmentPaymentStatus;
  /** Number of fee periods factored into this summary — only periods whose
   * `periodStart` has already arrived (see module comment below); excludes
   * future not-yet-due periods so a student isn't marked unpaid/overdue for
   * money that isn't owed yet. */
  periodsConsidered: number;
}

export type GetEnrollmentPaymentSummaryResult =
  | { ok: true; summary: EnrollmentPaymentSummary }
  | { ok: false; error: FeePeriodActionError };

/**
 * Shared by `getEnrollmentPaymentSummary` (single enrollment) and
 * `getStudentPaymentSummaries` (batched, for the Students list) — narrows
 * "every generated period" down to the ones that actually count toward
 * "is this student paid up right now": normally periods whose `periodStart`
 * has already arrived, but the earliest period alone when NONE have
 * started yet (a brand-new enrollment whose first period is anchored in
 * the future must still read `Expected > 0`, never an empty summary).
 */
export function selectRelevantPeriods<T extends { periodStart: string }>(periods: T[], today: string): T[] {
  const started = periods.filter((period) => compareDateOnly(period.periodStart, today) <= 0);
  return started.length > 0 ? started : periods.slice(0, 1);
}

/** Shared by the same two callers as `selectRelevantPeriods` — folds a set
 * of periods (already narrowed to "relevant") plus their approved-paid
 * cents into one expected/paid/remaining/status aggregate. */
export function aggregateEnrollmentPeriods(
  periods: { id: string; expectedAmountCents: number; dueDate: string }[],
  paidByPeriod: Map<string, number>,
  today: string,
): { expectedCents: number; paidCents: number; remainingCents: number; status: EnrollmentPaymentStatus } {
  let expectedCents = 0;
  let paidCents = 0;
  let anyOverdue = false;
  for (const period of periods) {
    const periodPaid = paidByPeriod.get(period.id) ?? 0;
    expectedCents += period.expectedAmountCents;
    paidCents += Math.min(periodPaid, period.expectedAmountCents);
    if (computeFeePeriodStatus(period.expectedAmountCents, periodPaid, period.dueDate, today) === "overdue") {
      anyOverdue = true;
    }
  }

  const remainingCents = Math.max(0, expectedCents - paidCents);
  let status: EnrollmentPaymentStatus;
  if (remainingCents <= 0 && expectedCents > 0) {
    status = "paid";
  } else if (anyOverdue) {
    status = "overdue";
  } else if (paidCents > 0) {
    status = "partially_paid";
  } else {
    status = "unpaid";
  }

  return { expectedCents, paidCents, remainingCents, status };
}

/**
 * Aggregates ONLY currently-relevant fee periods (`period_start <= today`)
 * — a period that hasn't started yet isn't part of "is this student paid
 * up right now," so it never forces a false UNPAID/OVERDUE reading. Lazily
 * generates periods through today first (same as `listFeePeriodsForEnrollment`),
 * so a freshly-enrolled student's first period already exists by the time
 * this is read (see `enrollStudentInBatch`, which also generates it
 * synchronously at enrollment time so `expectedCents > 0` immediately).
 *
 * `status` mirrors `computeFeePeriodStatus`'s rules at the aggregate level:
 * fully covered -> PAID; any relevant period past due with money still
 * owed -> OVERDUE (checked before PARTIALLY_PAID/UNPAID, since being overdue
 * is the more specific, more actionable fact); some but not all paid ->
 * PARTIALLY_PAID; nothing paid (including zero periods generated yet) ->
 * UNPAID. Never PAID merely because a schedule/enrollment was created —
 * PAID requires `paidCents >= expectedCents` computed from real approved
 * allocations, and a fresh enrollment has `paidCents === 0`.
 */
export async function getEnrollmentPaymentSummary(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<GetEnrollmentPaymentSummaryResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, scope } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId, scope);
  if (!enrollment) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  await generateFeePeriodsForEnrollment(db, enrollmentId, academyId);

  const today = todayDateOnly();
  const allPeriods = await db
    .select()
    .from(feePeriods)
    .where(eq(feePeriods.enrollmentId, enrollmentId))
    .orderBy(feePeriods.periodStart);

  const relevantPeriods = selectRelevantPeriods(allPeriods, today);
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, relevantPeriods.map((row) => row.id));
  const { expectedCents, paidCents, remainingCents, status } = aggregateEnrollmentPeriods(
    relevantPeriods,
    paidByPeriod,
    today,
  );

  return {
    ok: true,
    summary: { enrollmentId, expectedCents, paidCents, remainingCents, status, periodsConsidered: relevantPeriods.length },
  };
}

// ===========================================================================
// Batched payment summary for the Students list — one call for MANY
// students, never one query per student. Same "display enrichment on an
// already-authorized read, no separate permission gate, academyId taken
// directly rather than an AuthContext" pattern as
// lib/academies/batch-assignments.ts's `getActiveCoursesForStudents` (the
// existing "Course" column's own data source) — every caller here already
// resolved its own access before reaching this. Unlike the single-enrollment
// reads above, this is a PURE read: it never calls
// `generateFeePeriodsForEnrollment` (that would be an N+1 write on a list
// page) — a period only appears here once something has already caused it
// to be generated (enrollment time, or a visit to the student's own detail
// page), which is fine since `enrollStudentInBatch` already generates the
// first period synchronously at enrollment time.
// ===========================================================================

export interface StudentPaymentSummaryRow {
  enrollmentId: string;
  /** Number of equal monthly installments — see fee-periods.ts's own
   * module comment ("Payment schedule model"). NOT a period length. */
  intervalMonths: number;
  /** The schedule's TOTAL fee — NOT a per-installment amount. Use
   * `monthlyInstallmentCents` for the per-month figure (e.g. in a compact
   * list column, where "$6.00/mo" reads far more clearly than "$36.00"
   * next to a "6 months" label — see this file's module comment on why
   * displaying a schedule's total next to its duration, unlabeled, reads
   * as one lump payment). */
  scheduleAmountCents: number;
  /** Derived, never stored: `scheduleAmountCents` split evenly across
   * `intervalMonths` installments (last one absorbs the remainder) — see
   * `splitIntoMonthlyInstallments`. */
  monthlyInstallmentCents: number;
  currency: string;
  expectedCents: number;
  paidCents: number;
  remainingCents: number;
  status: EnrollmentPaymentStatus;
  /**
   * The single fee period the Students-list "Record Payment" action targets
   * — the oldest (by `periodStart`) period, among the SAME "relevant"
   * (already-started, or the one earliest period when none have started
   * yet — see `selectRelevantPeriods`) set that `expectedCents`/`paidCents`/
   * `remainingCents`/`status` above are themselves computed from, whose own
   * `remainingCents > 0`. `null` whenever `remainingCents` above is already
   * `0` — i.e. there is deliberately no "next outstanding period" once
   * nothing in the relevant window is left unpaid, even if a later, not-yet-
   * started period exists (a future period must never look currently
   * payable merely because it exists — see this file's `selectRelevantPeriods`
   * module comment and the Students-list page's own use of this field).
   */
  nextOutstandingPeriod: FeePeriodRecord | null;
}

/** Keyed by studentId. A student with more than one active enrollment
 * contributes only their first (same convention as
 * `getActiveCoursesForStudents`'s own "Course" column); a student with none
 * is simply absent from the returned map. */
export async function getStudentPaymentSummaries(
  academyId: string,
  /** Explicit ids, or (performance plan P4) a SQL subquery selecting the
   * caller's already-scoped student ids, so a whole-academy summary never
   * ships every id over the wire. Either way the same students are matched. */
  studentIds: string[] | SQLWrapper,
): Promise<Map<string, StudentPaymentSummaryRow>> {
  const result = new Map<string, StudentPaymentSummaryRow>();
  if (Array.isArray(studentIds) && studentIds.length === 0) return result;

  const enrollmentRows = await db
    .select({ studentId: batchEnrollments.studentId, enrollmentId: batchEnrollments.id })
    .from(batchEnrollments)
    .where(
      and(
        eq(batchEnrollments.academyId, academyId),
        eq(batchEnrollments.status, "active"),
        inArray(batchEnrollments.studentId, studentIds),
      ),
    );

  const enrollmentIdByStudent = new Map<string, string>();
  for (const row of enrollmentRows) {
    if (!enrollmentIdByStudent.has(row.studentId)) enrollmentIdByStudent.set(row.studentId, row.enrollmentId);
  }
  const enrollmentIds = [...new Set(enrollmentIdByStudent.values())];
  if (enrollmentIds.length === 0) return result;

  const [schedules, periods] = await Promise.all([
    db.select().from(enrollmentFeeSchedules).where(inArray(enrollmentFeeSchedules.enrollmentId, enrollmentIds)),
    db.select().from(feePeriods).where(inArray(feePeriods.enrollmentId, enrollmentIds)),
  ]);
  const scheduleByEnrollment = new Map(schedules.map((row) => [row.enrollmentId, row]));

  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, periods.map((row) => row.id));
  const today = todayDateOnly();

  const periodsByEnrollment = new Map<string, typeof periods>();
  for (const period of periods) {
    const list = periodsByEnrollment.get(period.enrollmentId) ?? [];
    list.push(period);
    periodsByEnrollment.set(period.enrollmentId, list);
  }

  for (const [studentId, enrollmentId] of enrollmentIdByStudent) {
    const schedule = scheduleByEnrollment.get(enrollmentId);
    if (!schedule) continue; // Every enrollment gets a schedule at creation time — defensive only.

    const allForEnrollment = (periodsByEnrollment.get(enrollmentId) ?? []).sort((a, b) =>
      compareDateOnly(a.periodStart, b.periodStart),
    );
    const relevantPeriods = selectRelevantPeriods(allForEnrollment, today);
    const { expectedCents, paidCents, remainingCents, status } = aggregateEnrollmentPeriods(
      relevantPeriods,
      paidByPeriod,
      today,
    );

    // Oldest-first among the SAME relevant periods the aggregate above was
    // computed from — never a fresh scan across ALL periods, so this can
    // never pick a genuinely future period the aggregate itself excluded
    // (see this field's own doc comment on StudentPaymentSummaryRow).
    // relevantPeriods is already periodStart-sorted (sliced/filtered from
    // allForEnrollment, which was sorted above).
    const nextOutstandingPeriod =
      relevantPeriods
        .map((period) => toFeePeriodRecord(period, paidByPeriod.get(period.id) ?? 0, today))
        .find((period) => period.remainingCents > 0) ?? null;

    result.set(studentId, {
      enrollmentId,
      intervalMonths: schedule.intervalMonths,
      scheduleAmountCents: schedule.amountCents,
      monthlyInstallmentCents: splitIntoMonthlyInstallments(schedule.amountCents, schedule.intervalMonths)[0],
      currency: schedule.currency,
      expectedCents,
      paidCents,
      remainingCents,
      status,
      nextOutstandingPeriod,
    });
  }

  return result;
}

// ===========================================================================
// Academy-wide overdue summary for the dashboard's "Requires attention"
// panel. Same "display enrichment on an already-authorized read" contract as
// `getStudentPaymentSummaries` above: takes `academyId` directly, never an
// AuthContext — the only caller (lib/academies/dashboard.ts) invokes it only
// after `getFinanceReports` has already confirmed the caller can see student
// payments. PURE read (never generates periods), and only ACTIVE enrollments
// count, same as the Students list. A period is overdue by exactly
// `computeFeePeriodStatus`'s rule; its remaining balance is the overdue
// amount. Totals stay per currency — never summed across currencies.
// ===========================================================================

export interface OverdueFeeSummary {
  studentCount: number;
  periodCount: number;
  totalsByCurrency: { currency: string; amountCents: number }[];
  /** Overdue remainder per student, per currency. */
  byStudent: Record<string, { currency: string; amountCents: number }[]>;
}

export async function getOverdueFeeSummary(
  academyId: string,
  branchId?: string | null,
  /** Restrict to these students (e.g. a Trainer's visible set), as ids or a
   * SQL subquery of ids (see `getStudentPaymentSummaries`). Omit for every
   * student in the academy/branch. */
  studentIds?: string[] | SQLWrapper,
): Promise<OverdueFeeSummary> {
  if (Array.isArray(studentIds) && studentIds.length === 0) {
    return { studentCount: 0, periodCount: 0, totalsByCurrency: [], byStudent: {} };
  }
  const today = todayDateOnly();
  const conditions = [
    eq(feePeriods.academyId, academyId),
    eq(batchEnrollments.academyId, academyId),
    eq(batchEnrollments.status, "active"),
    eq(students.academyId, academyId),
    sql`${feePeriods.dueDate} < ${today}`,
  ];
  if (branchId) conditions.push(eq(students.branchId, branchId));
  if (studentIds) conditions.push(inArray(students.id, studentIds));

  const rows = await db
    .select({
      id: feePeriods.id,
      studentId: batchEnrollments.studentId,
      dueDate: feePeriods.dueDate,
      expectedAmountCents: feePeriods.expectedAmountCents,
      currency: feePeriods.currency,
    })
    .from(feePeriods)
    .innerJoin(batchEnrollments, eq(feePeriods.enrollmentId, batchEnrollments.id))
    .innerJoin(students, eq(batchEnrollments.studentId, students.id))
    .where(and(...conditions));

  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, rows.map((row) => row.id));
  const totals = new Map<string, number>();
  const perStudent = new Map<string, Map<string, number>>();
  let periodCount = 0;
  for (const row of rows) {
    const paid = paidByPeriod.get(row.id) ?? 0;
    if (computeFeePeriodStatus(row.expectedAmountCents, paid, row.dueDate, today) !== "overdue") continue;
    const remaining = row.expectedAmountCents - paid;
    periodCount += 1;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + remaining);
    const own = perStudent.get(row.studentId) ?? new Map<string, number>();
    own.set(row.currency, (own.get(row.currency) ?? 0) + remaining);
    perStudent.set(row.studentId, own);
  }

  return {
    studentCount: perStudent.size,
    periodCount,
    totalsByCurrency: [...totals].map(([currency, amountCents]) => ({ currency, amountCents })),
    byStudent: Object.fromEntries(
      [...perStudent].map(([id, byCurrency]) => [
        id,
        [...byCurrency].map(([currency, amountCents]) => ({ currency, amountCents })),
      ]),
    ),
  };
}
