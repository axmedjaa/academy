import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  academies,
  batchEnrollments,
  batches,
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
 * Student Fee Periods — recurring enrollment payments, student-centered.
 * See lib/db/schema.ts's module comment above `enrollmentFeeSchedules` for
 * the schema rationale (why fee periods are their own tables, and why paid/
 * remaining/status are computed at read time instead of stored).
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
    access: { academyId: access.academyId, membershipRole: access.membershipRole, permissionLevel },
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

function compareDateOnly(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function todayDateOnly(): string {
  const now = new Date();
  return formatDateOnly({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() });
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
  intervalMonths: intervalMonthsSchema,
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
  intervalMonths: number;
  amountCents: number;
  currency: string;
  anchorDate: string;
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
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batchEnrollments.batchId, batches.id))
    .innerJoin(courses, eq(batches.courseId, courses.id))
    .where(eq(batchEnrollments.id, enrollmentId))
    .limit(1);
  if (!row || row.academyId !== academyId) return null;
  if (studentId && row.studentId !== studentId) return null;
  return row;
}

export type SetEnrollmentFeeScheduleResult =
  | { ok: true; schedule: EnrollmentFeeScheduleRecord }
  | { ok: false; error: FeePeriodActionError };

/** Creates or updates the one fee schedule an enrollment may have. Manager/
 * Finance Officer only (`canManage`). */
export async function setEnrollmentFeeSchedule(
  actorContext: AuthContext,
  input: SetEnrollmentFeeScheduleInput,
): Promise<SetEnrollmentFeeScheduleResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = setEnrollmentFeeScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const enrollment = await getScopedEnrollment(tx, data.enrollmentId, academyId);
    if (!enrollment) return { kind: "not_found" as const };

    const currency = await resolveCurrency(tx, academyId, data.currency);

    // For the audit log's "before" value only — never branched on for the
    // write itself (see the onConflictDoUpdate below), so a stale read here
    // can at worst mislabel one audit entry, never corrupt data or race.
    const [existingForAudit] = await tx
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, data.enrollmentId))
      .limit(1);

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
        amountCents: data.amountCents,
        currency,
        anchorDate: data.anchorDate,
        createdBy: actorContext.userId,
      })
      .onConflictDoUpdate({
        target: enrollmentFeeSchedules.enrollmentId,
        set: {
          intervalMonths: data.intervalMonths,
          amountCents: data.amountCents,
          currency,
          anchorDate: data.anchorDate,
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

    return { kind: "ok" as const, row };
  });

  if (result.kind === "not_found") return { ok: false, error: ENROLLMENT_NOT_FOUND };
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
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId);
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

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

/**
 * Generates any fee periods due to exist for this enrollment, from the
 * schedule's `anchorDate` (or the day after the latest existing period,
 * whichever is later — see "Resume point" below) up through `throughDate`
 * plus one extra period ahead (so the next not-yet-due period is always
 * already selectable when recording a payment that covers upcoming periods
 * too — see spec §19). A no-op when the enrollment has no fee schedule.
 * Safe to call repeatedly — already-existing periods are left untouched.
 *
 * ---------------------------------------------------------------------
 * Resume point — bug fix: a schedule change could previously generate a
 * period that overlaps an already-existing (possibly already-paid) one
 * ---------------------------------------------------------------------
 * `enrollment_fee_schedules` holds exactly ONE row per enrollment
 * (`setEnrollmentFeeSchedule` upserts onto it) — changing the interval/
 * amount does not move `anchorDate` unless the caller explicitly supplies
 * a new one (and the "Edit fee schedule" form pre-fills it from the
 * existing schedule, so in practice it usually doesn't move). Before this
 * fix, this function always restarted its walk at `schedule.anchorDate`
 * using the CURRENT interval on every call — so changing e.g. Monthly ->
 * Every 6 Months on an enrollment that already had paid monthly periods
 * would, on the next read, generate a brand-new 6-month period starting on
 * that same old anchor date. The `(enrollment_id, period_start,
 * period_end)` unique index does NOT catch this: a 6-month period sharing
 * a start date with an existing 1-month period has a different `period_end`,
 * so it's a genuinely new row, not a duplicate — it just overlaps the
 * existing one's date range and expected/paid figures got double-counted.
 *
 * Fix: before walking, find the latest `period_end` already generated for
 * this enrollment (across ALL periods regardless of which schedule shape
 * produced them) and start the walk the day after it — never earlier,
 * regardless of `intervalMonths`/`amountCents` changes. Falls back to
 * `schedule.anchorDate` when no periods exist yet (unchanged from before),
 * and never regresses BEFORE `schedule.anchorDate` either, so a genuinely
 * intentional forward anchor-date change (skipping ahead) still works.
 * Since every subsequent period in the loop is strictly later than the one
 * before it, resuming after the latest existing period makes a new
 * overlap structurally impossible — no separate overlap scan is needed.
 * This never touches, rewrites, or deletes an existing `fee_periods` row —
 * historical periods (paid or not) are exactly as untouched as before.
 */
export async function generateFeePeriodsForEnrollment(
  executor: DbClient,
  enrollmentId: string,
  academyId: string,
  throughDate: string = todayDateOnly(),
): Promise<void> {
  const [schedule] = await executor
    .select()
    .from(enrollmentFeeSchedules)
    .where(eq(enrollmentFeeSchedules.enrollmentId, enrollmentId))
    .limit(1);
  if (!schedule) return;

  // Never generate through less than the schedule's own anchor date — a
  // schedule anchored in the future (e.g. a batch that hasn't started yet)
  // would otherwise generate ZERO periods when `throughDate` defaults to
  // today, leaving a freshly-enrolled student with no first period at all
  // and violating the "Expected > 0 immediately after enrollment" contract
  // (see enrollStudentInBatch, which calls this synchronously at enrollment
  // time with no explicit throughDate).
  const effectiveThroughDate =
    compareDateOnly(throughDate, schedule.anchorDate) > 0 ? throughDate : schedule.anchorDate;

  const months = schedule.intervalMonths;
  const stopAt = formatDateOnly(addMonths(parseDateOnly(effectiveThroughDate), months)); // one extra period ahead

  let cursor = parseDateOnly(schedule.anchorDate);

  const existingPeriods = await executor
    .select({ periodEnd: feePeriods.periodEnd })
    .from(feePeriods)
    .where(eq(feePeriods.enrollmentId, enrollmentId));
  if (existingPeriods.length > 0) {
    const latestPeriodEnd = existingPeriods.reduce(
      (latest, row) => (compareDateOnly(row.periodEnd, latest) > 0 ? row.periodEnd : latest),
      existingPeriods[0].periodEnd,
    );
    const dayAfterLatest = addDays(parseDateOnly(latestPeriodEnd), 1);
    if (compareDateOnly(formatDateOnly(dayAfterLatest), formatDateOnly(cursor)) > 0) {
      cursor = dayAfterLatest;
    }
  }

  const MAX_PERIODS_PER_CALL = 500; // generous safety ceiling against a runaway loop
  for (let i = 0; i < MAX_PERIODS_PER_CALL; i += 1) {
    const periodStart = formatDateOnly(cursor);
    if (compareDateOnly(periodStart, stopAt) > 0) break;

    const periodEndParts = addDays(addMonths(cursor, months), -1);
    const periodEnd = formatDateOnly(periodEndParts);

    try {
      await executor
        .insert(feePeriods)
        .values({
          academyId,
          enrollmentId,
          intervalMonths: schedule.intervalMonths,
          periodStart,
          periodEnd,
          dueDate: periodStart,
          expectedAmountCents: schedule.amountCents,
          currency: schedule.currency,
        })
        .onConflictDoNothing();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    cursor = addMonths(cursor, months);
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
async function getApprovedPaidCentsByPeriod(
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
  const { academyId, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId);
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
  batchName: string;
  courseName: string;
  status: "active" | "withdrawn" | "completed";
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
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) return { ok: false, error: STUDENT_NOT_FOUND };

  const [student] = await db
    .select({ id: students.id, academyId: students.academyId })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!student || student.academyId !== academyId) return { ok: false, error: STUDENT_NOT_FOUND };

  const rows = await db
    .select({
      id: batchEnrollments.id,
      status: batchEnrollments.status,
      batchName: batches.name,
      courseName: courses.name,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batchEnrollments.batchId, batches.id))
    .innerJoin(courses, eq(batches.courseId, courses.id))
    .where(and(eq(batchEnrollments.studentId, studentId), eq(batchEnrollments.academyId, academyId)));

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
  const { academyId, membershipRole, permissionLevel } = resolved.access;
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
      .select({ id: students.id, academyId: students.academyId })
      .from(students)
      .where(eq(students.id, data.studentId))
      .limit(1);
    if (!student || student.academyId !== academyId) {
      return { kind: "student_not_found" as const };
    }

    const enrollment = await getScopedEnrollment(tx, data.enrollmentId, academyId, data.studentId);
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
  periods: { feePeriodId: string; periodStart: string; periodEnd: string; amountCents: number }[];
}

export type ListFeePeriodPaymentHistoryResult =
  | { ok: true; rows: FeePeriodPaymentHistoryRow[] }
  | { ok: false; error: FeePeriodActionError };

export async function listFeePeriodPaymentHistory(
  actorContext: AuthContext,
  filters: { studentId?: string; enrollmentId?: string } = {},
): Promise<ListFeePeriodPaymentHistoryResult> {
  const resolved = await resolveFeePeriodsAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const conditions = [eq(studentPayments.academyId, academyId)];
  if (filters.studentId) conditions.push(eq(studentPayments.studentId, filters.studentId));
  if (filters.enrollmentId) conditions.push(eq(feePeriods.enrollmentId, filters.enrollmentId));

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
    .innerJoin(courses, eq(batches.courseId, courses.id))
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
    entry.periods.push({ feePeriodId: row.feePeriodId, periodStart: row.periodStart, periodEnd: row.periodEnd, amountCents: row.allocationAmountCents });
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
function selectRelevantPeriods<T extends { periodStart: string }>(periods: T[], today: string): T[] {
  const started = periods.filter((period) => compareDateOnly(period.periodStart, today) <= 0);
  return started.length > 0 ? started : periods.slice(0, 1);
}

/** Shared by the same two callers as `selectRelevantPeriods` — folds a set
 * of periods (already narrowed to "relevant") plus their approved-paid
 * cents into one expected/paid/remaining/status aggregate. */
function aggregateEnrollmentPeriods(
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
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) return { ok: false, error: ENROLLMENT_NOT_FOUND };

  const enrollment = await getScopedEnrollment(db, enrollmentId, academyId);
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
  intervalMonths: number;
  scheduleAmountCents: number;
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
  studentIds: string[],
): Promise<Map<string, StudentPaymentSummaryRow>> {
  const result = new Map<string, StudentPaymentSummaryRow>();
  if (studentIds.length === 0) return result;

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
