import { and, asc, count, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { LIST_PAGE_SIZE_MAX } from "@/lib/ui/pagination";
import { db } from "@/lib/db";
import { batchEnrollments, batches, courses, enrollmentFeeSchedules, feePeriods, programEnrollments, programs, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { resolveScope } from "@/lib/academies/students";
import {
  aggregateEnrollmentPeriods,
  compareDateOnly,
  computeFeePeriodStatus,
  getApprovedPaidCentsByPeriod,
  selectRelevantPeriods,
  todayDateOnly,
  type EnrollmentPaymentStatus,
} from "@/lib/academies/fee-periods";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Fee periods page (design A14): one row per ACTIVE enrollment the caller
 * can see, with its payment plan and where it stands today.
 *
 * Gated on the fee-periods permission row (view or above) and scoped with
 * the students list's own `resolveScope`, so branch-limited roles and
 * trainers only ever see their own students. A PURE read: periods are never
 * generated here (same contract as `getStudentPaymentSummaries`), and the
 * figures use the same shared aggregation the Students list and the
 * student's own page use — the periods that have started so far.
 */

export interface FeePeriodOverviewRow {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  studentNumber: string;
  batchCode: string;
  batchName: string;
  courseName: string;
  /** Null only for a legacy enrollment without a schedule. */
  schedule: { intervalMonths: number; amountCents: number; currency: string; anchorDate: string } | null;
  /** Expected / paid / remaining over the periods that have started. */
  dueCents: number;
  paidCents: number;
  remainingCents: number;
  overdueCents: number;
  status: EnrollmentPaymentStatus;
  /** Any installment has started — from then on a schedule change keeps the
   * started ones and the server sets the new total and start itself. */
  hasStarted: boolean;
}

export type ListFeePeriodOverviewResult =
  | { ok: true; rows: FeePeriodOverviewRow[]; totalCount: number; page: number; pageSize: number; canManage: boolean }
  | { ok: false; error: { code: "blocked" | "forbidden"; message: string } };

export async function listFeePeriodOverview(
  actorContext: AuthContext,
  options: { searchTerm?: string; status?: EnrollmentPaymentStatus; page?: number; pageSize?: number } = {},
): Promise<ListFeePeriodOverviewResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_FEE_PERIODS_ACTION);
  if (level === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to view fee periods." } };
  }
  const canManage = level === "full" || level === "manage";
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(LIST_PAGE_SIZE_MAX, Math.max(1, options.pageSize ?? LIST_PAGE_SIZE_MAX));
  const empty = { ok: true as const, rows: [], totalCount: 0, page, pageSize, canManage };

  const scope = await resolveScope(access, actorContext.userId, undefined);
  if (scope.unreachable) return empty;

  const conditions: SQL[] = [
    ...scope.conditions,
    eq(batchEnrollments.academyId, academyId),
    eq(batchEnrollments.status, "active"),
  ];
  const term = options.searchTerm?.trim();
  if (term) {
    const pattern = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(students.fullName, pattern), ilike(students.studentNumber, pattern))!);
  }

  const base = db
    .select({
      enrollmentId: batchEnrollments.id,
      studentId: students.id,
      studentName: students.fullName,
      studentNumber: students.studentNumber,
      batchCode: batches.code,
      batchName: batches.name,
      courseName: courses.name,
    })
    .from(batchEnrollments)
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .innerJoin(batches, and(eq(batches.id, batchEnrollments.batchId), eq(batches.academyId, academyId)))
    .innerJoin(courses, and(eq(courses.id, batchEnrollments.courseId), eq(courses.academyId, academyId)))
    .where(and(...conditions))
    .orderBy(asc(students.fullName), asc(batches.code), asc(courses.name));

  // A status filter needs every row's figures first; otherwise only the page.
  const enrollmentRows = options.status ? await base : await base.limit(pageSize).offset((page - 1) * pageSize);
  let totalCount = enrollmentRows.length;
  if (!options.status) {
    const [{ value }] = await db
      .select({ value: count() })
      .from(batchEnrollments)
      .innerJoin(students, eq(students.id, batchEnrollments.studentId))
      .innerJoin(batches, and(eq(batches.id, batchEnrollments.batchId), eq(batches.academyId, academyId)))
      .innerJoin(courses, and(eq(courses.id, batchEnrollments.courseId), eq(courses.academyId, academyId)))
      .where(and(...conditions));
    totalCount = Number(value);
  }
  if (enrollmentRows.length === 0) return { ...empty, totalCount };

  const enrollmentIds = enrollmentRows.map((row) => row.enrollmentId);
  const [schedules, periods] = await Promise.all([
    db
      .select()
      .from(enrollmentFeeSchedules)
      .where(and(eq(enrollmentFeeSchedules.academyId, academyId), inArray(enrollmentFeeSchedules.enrollmentId, enrollmentIds))),
    db
      .select()
      .from(feePeriods)
      .where(and(eq(feePeriods.academyId, academyId), inArray(feePeriods.enrollmentId, enrollmentIds))),
  ]);
  const scheduleByEnrollment = new Map(schedules.map((row) => [row.enrollmentId, row]));
  const periodsByEnrollment = new Map<string, typeof periods>();
  for (const period of periods) {
    // Selected by course enrollment id above; the guard only narrows the type.
    if (!period.enrollmentId) continue;
    const list = periodsByEnrollment.get(period.enrollmentId) ?? [];
    list.push(period);
    periodsByEnrollment.set(period.enrollmentId, list);
  }
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, periods.map((row) => row.id));
  const today = todayDateOnly();

  let rows: FeePeriodOverviewRow[] = enrollmentRows.map((row) => {
    const schedule = scheduleByEnrollment.get(row.enrollmentId) ?? null;
    const relevant = selectRelevantPeriods(
      (periodsByEnrollment.get(row.enrollmentId) ?? []).sort((a, b) => compareDateOnly(a.periodStart, b.periodStart)),
      today,
    );
    const aggregate = aggregateEnrollmentPeriods(relevant, paidByPeriod, today);
    const overdueCents = relevant.reduce((sum, period) => {
      const paid = paidByPeriod.get(period.id) ?? 0;
      return computeFeePeriodStatus(period.expectedAmountCents, paid, period.dueDate, today) === "overdue"
        ? sum + Math.max(0, period.expectedAmountCents - paid)
        : sum;
    }, 0);
    return {
      ...row,
      schedule: schedule
        ? { intervalMonths: schedule.intervalMonths, amountCents: schedule.amountCents, currency: schedule.currency, anchorDate: schedule.anchorDate }
        : null,
      dueCents: aggregate.expectedCents,
      paidCents: aggregate.paidCents,
      remainingCents: aggregate.remainingCents,
      overdueCents,
      status: aggregate.status,
      hasStarted: relevant.some((period) => compareDateOnly(period.periodStart, today) <= 0),
    };
  });

  if (options.status) {
    rows = rows.filter((row) => row.status === options.status);
    totalCount = rows.length;
    rows = rows.slice((page - 1) * pageSize, page * pageSize);
  }
  return { ok: true, rows, totalCount, page, pageSize, canManage };
}

export interface FeeCollectionTotals {
  currency: string;
  /** Paid towards fee periods (approved payments, capped at each period's amount). */
  collectedCents: number;
  /** Still owed on periods whose due date has passed. */
  overdueCents: number;
  /** Still owed on periods that are not due yet. */
  notYetDueCents: number;
}

export type GetFeeCollectionResult =
  | { ok: true; totals: FeeCollectionTotals[] }
  | { ok: false; error: { code: "blocked" | "forbidden"; message: string } };

/**
 * Fee collection across every fee period of the active enrollments in the
 * caller's scope (Reports, design "Fee collection"): collected, overdue and
 * not yet due, per currency, as of today. Same permission, scope and
 * period-status rule (`computeFeePeriodStatus`, UTC today) as the Fee
 * periods page. Read only.
 */
export async function getFeeCollectionSummary(actorContext: AuthContext): Promise<GetFeeCollectionResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_FEE_PERIODS_ACTION) === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to view fee periods." } };
  }
  const scope = await resolveScope(access, actorContext.userId, undefined);
  if (scope.unreachable) return { ok: true, totals: [] };

  const periods = await db
    .select({ id: feePeriods.id, expectedAmountCents: feePeriods.expectedAmountCents, dueDate: feePeriods.dueDate, currency: feePeriods.currency })
    .from(feePeriods)
    .innerJoin(batchEnrollments, eq(batchEnrollments.id, feePeriods.enrollmentId))
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .where(and(...scope.conditions, eq(feePeriods.academyId, academyId), eq(batchEnrollments.academyId, academyId), eq(batchEnrollments.status, "active")));
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, periods.map((row) => row.id));
  const today = todayDateOnly();

  const byCurrency = new Map<string, FeeCollectionTotals>();
  for (const period of periods) {
    const totals = byCurrency.get(period.currency) ?? { currency: period.currency, collectedCents: 0, overdueCents: 0, notYetDueCents: 0 };
    const paid = paidByPeriod.get(period.id) ?? 0;
    const remaining = Math.max(0, period.expectedAmountCents - paid);
    totals.collectedCents += Math.min(paid, period.expectedAmountCents);
    if (computeFeePeriodStatus(period.expectedAmountCents, paid, period.dueDate, today) === "overdue") totals.overdueCents += remaining;
    else totals.notYetDueCents += remaining;
    byCurrency.set(period.currency, totals);
  }
  return { ok: true, totals: [...byCurrency.values()] };
}

export interface ProgramFeeCollectionRow extends FeeCollectionTotals {
  programId: string;
  programName: string;
  /** Active complete-program enrollments of this program in scope. */
  enrollments: number;
  /** Sum of their final program fees (after discount). */
  finalFeeCents: number;
}

export type GetProgramFeeCollectionResult =
  | { ok: true; totals: (FeeCollectionTotals & { enrollments: number; finalFeeCents: number })[]; byProgram: ProgramFeeCollectionRow[] }
  | { ok: false; error: { code: "blocked" | "forbidden"; message: string } };

/**
 * Program fee collection (Stage 6): the same collected / overdue / not yet
 * due figures as `getFeeCollectionSummary`, but over the installments of
 * ACTIVE complete-program enrollments only (migration 0049) — the ONE
 * program fee, never split per course. Kept apart from the course figures:
 * `getFeeCollectionSummary` inner-joins `fee_periods.enrollment_id`, so it
 * never sees a program installment, and this function reads only
 * `fee_periods.program_enrollment_id` — every installment is counted in
 * exactly one of the two (the table's one-owner check guarantees it).
 * Same permission row, student scope and period-status rule. Read only.
 */
export async function getProgramFeeCollectionSummary(actorContext: AuthContext): Promise<GetProgramFeeCollectionResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_FEE_PERIODS_ACTION) === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have permission to view fee periods." } };
  }
  const scope = await resolveScope(access, actorContext.userId, undefined);
  if (scope.unreachable) return { ok: true, totals: [], byProgram: [] };

  const periods = await db
    .select({
      id: feePeriods.id,
      programEnrollmentId: programEnrollments.id,
      programId: programs.id,
      programName: programs.name,
      expectedAmountCents: feePeriods.expectedAmountCents,
      dueDate: feePeriods.dueDate,
      currency: feePeriods.currency,
    })
    .from(feePeriods)
    .innerJoin(programEnrollments, eq(programEnrollments.id, feePeriods.programEnrollmentId))
    .innerJoin(programs, and(eq(programs.id, programEnrollments.programId), eq(programs.academyId, academyId)))
    .innerJoin(students, eq(students.id, programEnrollments.studentId))
    .where(and(...scope.conditions, eq(feePeriods.academyId, academyId), eq(programEnrollments.academyId, academyId), eq(programEnrollments.status, "active")));
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, periods.map((row) => row.id));
  const today = todayDateOnly();

  const byCurrency = new Map<string, FeeCollectionTotals & { enrollments: number; finalFeeCents: number; ids: Set<string> }>();
  const byProgram = new Map<string, ProgramFeeCollectionRow & { ids: Set<string> }>();
  for (const period of periods) {
    const paid = paidByPeriod.get(period.id) ?? 0;
    const remaining = Math.max(0, period.expectedAmountCents - paid);
    const overdue = computeFeePeriodStatus(period.expectedAmountCents, paid, period.dueDate, today) === "overdue";
    const currencyTotals = byCurrency.get(period.currency) ?? {
      currency: period.currency, collectedCents: 0, overdueCents: 0, notYetDueCents: 0, enrollments: 0, finalFeeCents: 0, ids: new Set<string>(),
    };
    const programKey = `${period.programId}:${period.currency}`;
    const programTotals = byProgram.get(programKey) ?? {
      programId: period.programId, programName: period.programName, currency: period.currency,
      collectedCents: 0, overdueCents: 0, notYetDueCents: 0, enrollments: 0, finalFeeCents: 0, ids: new Set<string>(),
    };
    for (const totals of [currencyTotals, programTotals]) {
      // The installments of one enrollment add up exactly to its final fee.
      totals.finalFeeCents += period.expectedAmountCents;
      totals.collectedCents += Math.min(paid, period.expectedAmountCents);
      if (overdue) totals.overdueCents += remaining;
      else totals.notYetDueCents += remaining;
      totals.ids.add(period.programEnrollmentId);
      totals.enrollments = totals.ids.size;
    }
    byCurrency.set(period.currency, currencyTotals);
    byProgram.set(programKey, programTotals);
  }
  return {
    ok: true,
    totals: [...byCurrency.values()].map((row) => ({
      currency: row.currency,
      collectedCents: row.collectedCents,
      overdueCents: row.overdueCents,
      notYetDueCents: row.notYetDueCents,
      enrollments: row.enrollments,
      finalFeeCents: row.finalFeeCents,
    })),
    byProgram: [...byProgram.values()]
      .map((row) => ({
        programId: row.programId,
        programName: row.programName,
        currency: row.currency,
        collectedCents: row.collectedCents,
        overdueCents: row.overdueCents,
        notYetDueCents: row.notYetDueCents,
        enrollments: row.enrollments,
        finalFeeCents: row.finalFeeCents,
      }))
      .sort((a, b) => a.programName.localeCompare(b.programName)),
  };
}
