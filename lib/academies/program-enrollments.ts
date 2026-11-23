import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchCourses,
  batchEnrollments,
  batches,
  courses,
  enrollmentFeeSchedules,
  FEE_INTERVAL_MONTHS_OPTIONS,
  feePeriods,
  paymentAllocations,
  programEnrollments,
  programs,
  receipts,
  staffProfiles,
  studentCourseRefundPayments,
  studentCourseRefunds,
  studentPayments,
  students,
  SCHOLARSHIP_KINDS,
  type ScholarshipKind,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getBranchScope, inBranchScope, type BranchScope } from "@/lib/academies/branch-access";
import {
  buildMonthlyInstallmentPeriods,
  computeFeePeriodStatus,
  getApprovedPaidCentsByPeriod,
  resolveCurrency,
  todayDateOnly,
  todayDateOnlyInAcademyTimezone,
  type FeePeriodStatus,
} from "@/lib/academies/fee-periods";
import { IDEMPOTENCY_INDEX, IDEMPOTENCY_KEY_REUSED, idempotencyKeyField, isIdempotencyViolation } from "@/lib/academies/idempotency";
import { findKeyedStudentPayment } from "@/lib/academies/student-payment-idempotency";
import { canRecordCourseRefund } from "@/lib/academies/course-refunds";
import {
  attributeRefund,
  checkRefundCents,
  paidForEnrollmentCents,
  refundableCents,
  refundedForEnrollmentCents,
  type EnrollmentPaymentShare,
} from "@/lib/academies/course-refund-rules";
import { WITHDRAW_REASON_MAX } from "@/lib/academies/batch-assignments";
import {
  ACADEMY_COURSES_BATCHES_ACTION,
  ACADEMY_FEE_PERIODS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/ui/money";

/**
 * Complete PROGRAM enrollment (migration 0049) — the second enrollment model,
 * beside individual course enrollment (batch-assignments.ts).
 *
 * Financial model: ONE program fee per program enrollment, billed in monthly
 * installments. It is the same billing engine as course fees — an
 * `enrollment_fee_schedules` row and its `fee_periods`, paid with ordinary
 * `student_payments` + `payment_allocations`, receipted with the ordinary
 * receipts, reversed with the ordinary reversal flow — but OWNED by the
 * program enrollment (`program_enrollment_id`) instead of a course
 * enrollment. Course-level finance code selects by course enrollment id, so
 * it never sees these rows, and vice versa.
 *
 * Academic model: the program's courses (taken from the program-based
 * batch's courses) become ordinary `batch_enrollments` rows pointing back to
 * the program enrollment (`program_enrollment_id`), so course dates,
 * instructors, exams, results and certificates stay course-specific. Those
 * course rows NEVER get a fee schedule or fee periods: the program student
 * has exactly one financial obligation.
 *
 * Fees are typed in at enrollment (no catalog prices): the full program fee,
 * an optional discount, and the number of monthly installments. The billed
 * total is fee − discount, split by the one shared installment splitter so
 * the installments always sum to it exactly (integer cents).
 *
 * Authorization mirrors the existing flows: enrolling/withdrawing uses the
 * courses/batches row (as enrollStudentInBatch does; Trainers never), money
 * uses the fee-periods row (as recordEnrollmentPayment does), refunds use the
 * course-refund authority. Every read and write is academy-scoped and
 * branch-scoped through the program batch's branch; a row outside either is
 * reported as not found.
 */

export interface ProgramEnrollmentError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_transition";
  message: string;
}

const FORBIDDEN: ProgramEnrollmentError = { code: "forbidden", message: "You don't have permission to do this." };
const ENROLLMENT_NOT_FOUND: ProgramEnrollmentError = { code: "not_found", message: "Program enrollment not found." };

function canManageLevel(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

const methodSchema = z.enum(["cash", "mobile_money", "bank_transfer"]);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));

const installmentsSchema = z.union(
  FEE_INTERVAL_MONTHS_OPTIONS.map((value) => z.literal(value)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  { message: "Number of monthly installments must be 1, 2, 3, 4, 6 or 12." },
);

const paymentFields = {
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  method: methodSchema,
  reference: optionalText(200),
  notes: optionalText(1000),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
};

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

interface ResolvedAccess {
  academyId: string;
  membershipRole: AcademyRole;
  scope: BranchScope;
  coursesLevel: AcademyPermissionLevel;
  feeLevel: AcademyPermissionLevel;
  studentsLevel: AcademyPermissionLevel;
}

async function resolveAccess(
  actorContext: AuthContext,
): Promise<{ ok: true; access: ResolvedAccess } | { ok: false; error: ProgramEnrollmentError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      scope: await getBranchScope(access, actorContext.userId),
      coursesLevel: getAcademyPermissionLevel(access.membershipRole, ACADEMY_COURSES_BATCHES_ACTION),
      feeLevel: getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION),
      studentsLevel: getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENTS_ACTION),
    },
  };
}

/** Enrolling and withdrawing: the same gate as enrollStudentInBatch. */
function canManageEnrollments(access: ResolvedAccess): boolean {
  return canManageLevel(access.coursesLevel) && access.membershipRole !== "trainer";
}

/** The program enrollment, academy- and branch-scoped (through its batch). */
async function getScopedProgramEnrollment(executor: DbClient, access: ResolvedAccess, programEnrollmentId: string) {
  if (!z.string().uuid().safeParse(programEnrollmentId).success) return null;
  const [row] = await executor
    .select({ enrollment: programEnrollments, branchId: batches.branchId })
    .from(programEnrollments)
    .innerJoin(batches, eq(batches.id, programEnrollments.batchId))
    .where(and(eq(programEnrollments.id, programEnrollmentId), eq(programEnrollments.academyId, access.academyId)))
    .limit(1);
  if (!row || !inBranchScope(access.scope, row.branchId)) return null;
  return row;
}

/** Greedy oldest-first split of an amount over outstanding installments. */
function allocateOldestFirst(
  periods: { id: string; periodStart: string; expectedAmountCents: number }[],
  paidByPeriod: Map<string, number>,
  amountCents: number,
): { allocations: { feePeriodId: string; amountCents: number }[]; outstandingCents: number; leftoverCents: number } {
  const outstanding = [...periods]
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
    .map((period) => ({ id: period.id, remaining: period.expectedAmountCents - (paidByPeriod.get(period.id) ?? 0) }))
    .filter((period) => period.remaining > 0);
  let left = amountCents;
  const allocations: { feePeriodId: string; amountCents: number }[] = [];
  for (const period of outstanding) {
    if (left <= 0) break;
    const take = Math.min(left, period.remaining);
    allocations.push({ feePeriodId: period.id, amountCents: take });
    left -= take;
  }
  return { allocations, outstandingCents: outstanding.reduce((sum, p) => sum + p.remaining, 0), leftoverCents: left };
}

/* ------------------------------------------------------------------ */
/* Enroll                                                              */
/* ------------------------------------------------------------------ */

export const enrollStudentInProgramSchema = z
  .object({
    studentId: z.string().uuid("Select a student"),
    /** A program-based batch: the program and its courses come from it. */
    batchId: z.string().uuid("Select a program batch"),
    /** Migration 0057. "full" = free: no program fee, no installments.
     * "partial" = the discount is a scholarship. */
    scholarship: z.enum(SCHOLARSHIP_KINDS).optional(),
    /** The full program fee before discount, typed in by staff (not needed
     * for a full scholarship). */
    programFeeCents: z.number().int("Fee must be a whole number of cents").nonnegative("Enter the program fee").default(0),
    discountCents: z.number().int("Discount must be a whole number of cents").nonnegative("Discount can't be negative").default(0),
    /** Number of equal monthly installments (e.g. 12 for a one-year program). */
    installments: installmentsSchema,
    currency: z.string().trim().toUpperCase().length(3, "Currency must be a 3-letter code, e.g. USD").optional(),
    /** First installment's due date; defaults to today (academy time). */
    anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid start date is required").optional(),
    /** Optional payment received at registration — never assumed. */
    initialPayment: z.object(paymentFields).optional(),
    idempotencyKey: idempotencyKeyField,
  })
  .superRefine((data, ctx) => {
    if (data.scholarship === "full") {
      if (data.initialPayment) ctx.addIssue({ code: "custom", path: ["initialPayment"], message: "A full scholarship has nothing to pay." });
      return;
    }
    if (data.programFeeCents <= 0) {
      ctx.addIssue({ code: "custom", path: ["programFeeCents"], message: "Enter the program fee" });
    } else if (data.discountCents >= data.programFeeCents) {
      ctx.addIssue({ code: "custom", path: ["discountCents"], message: "The discount must be less than the program fee." });
    } else if (data.scholarship === "partial" && data.discountCents <= 0) {
      ctx.addIssue({ code: "custom", path: ["discountCents"], message: "Enter the scholarship amount taken off the program fee." });
    }
  });

export type EnrollStudentInProgramInput = z.input<typeof enrollStudentInProgramSchema>;

export interface ProgramEnrollmentRecord {
  id: string;
  academyId: string;
  studentId: string;
  programId: string;
  batchId: string;
  status: "active" | "withdrawn" | "completed";
  enrolledAt: Date;
  /** Migration 0057: "full" (free) or "partial", null when none. */
  scholarship: ScholarshipKind | null;
}

function toRecord(row: typeof programEnrollments.$inferSelect): ProgramEnrollmentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    studentId: row.studentId,
    programId: row.programId,
    batchId: row.batchId,
    status: row.status,
    enrolledAt: row.enrolledAt,
    scholarship: row.scholarship ?? null,
  };
}

export type EnrollStudentInProgramResult =
  | {
      ok: true;
      enrollment: ProgramEnrollmentRecord;
      courseEnrollmentIds: string[];
      finalFeeCents: number;
      installmentCents: number[];
      initialPaymentId: string | null;
    }
  | { ok: false; error: ProgramEnrollmentError };

class Refused extends Error {
  constructor(readonly error: ProgramEnrollmentError) {
    super(error.message);
  }
}

export async function enrollStudentInProgram(
  actorContext: AuthContext,
  input: EnrollStudentInProgramInput,
): Promise<EnrollStudentInProgramResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!canManageEnrollments(access)) return { ok: false, error: FORBIDDEN };

  const parsed = enrollStudentInProgramSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;
  // Recording money at registration needs the payment authority too.
  if (data.initialPayment && !canManageLevel(access.feeLevel)) return { ok: false, error: FORBIDDEN };

  const free = data.scholarship === "full";
  const finalFeeCents = free ? 0 : data.programFeeCents - data.discountCents;
  if (data.initialPayment && data.initialPayment.amountCents > finalFeeCents) {
    return {
      ok: false,
      error: { code: "conflict", message: "The payment is more than the program fee after discount. Overpayment is not supported." },
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, data.batchId), eq(batches.academyId, access.academyId)))
        .limit(1);
      if (!batch || !inBranchScope(access.scope, batch.branchId)) {
        throw new Refused({ code: "not_found", message: "Batch not found." });
      }
      if (!batch.programId) {
        throw new Refused({ code: "validation", message: "Choose a program-based batch for a program enrollment." });
      }
      if (batch.status !== "planned" && batch.status !== "active") {
        throw new Refused({ code: "validation", message: "This batch is not open for enrollment." });
      }

      const [program] = await tx
        .select({ id: programs.id, name: programs.name, status: programs.status })
        .from(programs)
        .where(and(eq(programs.id, batch.programId), eq(programs.academyId, access.academyId)))
        .limit(1);
      if (!program) throw new Refused({ code: "not_found", message: "Program not found." });
      if (program.status !== "active") throw new Refused({ code: "validation", message: "This program is archived." });

      const [student] = await tx
        .select({ id: students.id, academyId: students.academyId, status: students.status })
        .from(students)
        .where(eq(students.id, data.studentId))
        .limit(1);
      if (!student || student.academyId !== access.academyId) {
        throw new Refused({ code: "not_found", message: "Student not found." });
      }

      // The program's courses are the program batch's courses.
      const courseRows = await tx
        .select({ courseId: batchCourses.courseId })
        .from(batchCourses)
        .where(and(eq(batchCourses.batchId, batch.id), eq(batchCourses.academyId, access.academyId)));
      if (courseRows.length === 0) throw new Refused({ code: "validation", message: "This program batch has no courses." });
      const courseIds = courseRows.map((row) => row.courseId);

      const [alreadyInProgram] = await tx
        .select({ id: programEnrollments.id })
        .from(programEnrollments)
        .where(
          and(
            eq(programEnrollments.studentId, student.id),
            eq(programEnrollments.programId, program.id),
            eq(programEnrollments.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      if (alreadyInProgram) {
        throw new Refused({ code: "conflict", message: `This student is already enrolled in ${program.name}.` });
      }
      const alreadyInCourses = await tx
        .select({ id: batchEnrollments.id })
        .from(batchEnrollments)
        .where(
          and(
            eq(batchEnrollments.batchId, batch.id),
            eq(batchEnrollments.studentId, student.id),
            eq(batchEnrollments.status, "active"),
            inArray(batchEnrollments.courseId, courseIds),
          ),
        )
        .limit(1);
      if (alreadyInCourses.length > 0) {
        throw new Refused({ code: "conflict", message: "This student is already enrolled in a course of this batch." });
      }

      const [enrollment] = await tx
        .insert(programEnrollments)
        .values({
          academyId: access.academyId,
          studentId: student.id,
          programId: program.id,
          batchId: batch.id,
          scholarship: data.scholarship ?? null,
          createdBy: actorContext.userId,
        })
        .returning();

      // Academic course enrollments — no fee schedule, no fee periods.
      const courseEnrollments = await tx
        .insert(batchEnrollments)
        .values(
          courseIds.map((courseId) => ({
            academyId: access.academyId,
            batchId: batch.id,
            courseId,
            studentId: student.id,
            programEnrollmentId: enrollment.id,
          })),
        )
        .returning({ id: batchEnrollments.id });

      // A full scholarship is free: no fee schedule and no installments.
      if (free) {
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: access.membershipRole,
            academyId: access.academyId,
            branchId: batch.branchId,
            action: "enrollStudentInProgram",
            entityType: "program_enrollment",
            entityId: enrollment.id,
            after: { ...toRecord(enrollment), courseEnrollmentIds: courseEnrollments.map((row) => row.id), fee: null },
          },
          tx,
        );
        return { enrollment, courseEnrollmentIds: courseEnrollments.map((row) => row.id), installmentCents: [] as number[], initialPaymentId: null };
      }

      // The one program fee.
      const currency = await resolveCurrency(tx, access.academyId, data.currency);
      const anchorDate = data.anchorDate ?? todayDateOnlyInAcademyTimezone();
      const [schedule] = await tx
        .insert(enrollmentFeeSchedules)
        .values({
          academyId: access.academyId,
          programEnrollmentId: enrollment.id,
          intervalMonths: data.installments,
          amountCents: finalFeeCents,
          discountCents: data.discountCents,
          currency,
          anchorDate,
          createdBy: actorContext.userId,
        })
        .returning();
      const plan = buildMonthlyInstallmentPeriods(anchorDate, data.installments, finalFeeCents);
      const periods = await tx
        .insert(feePeriods)
        .values(
          plan.map((period) => ({
            academyId: access.academyId,
            programEnrollmentId: enrollment.id,
            intervalMonths: data.installments,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            dueDate: period.dueDate,
            expectedAmountCents: period.expectedAmountCents,
            currency,
          })),
        )
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          branchId: batch.branchId,
          action: "enrollStudentInProgram",
          entityType: "program_enrollment",
          entityId: enrollment.id,
          after: {
            ...toRecord(enrollment),
            courseEnrollmentIds: courseEnrollments.map((row) => row.id),
            fee: {
              ...(data.scholarship ? { scholarship: data.scholarship } : {}),
              programFeeCents: data.programFeeCents,
              discountCents: data.discountCents,
              finalFeeCents,
              installments: data.installments,
              currency,
              anchorDate,
              scheduleId: schedule.id,
            },
          },
        },
        tx,
      );

      let initialPaymentId: string | null = null;
      if (data.initialPayment) {
        const split = allocateOldestFirst(periods, new Map(), data.initialPayment.amountCents);
        const now = new Date();
        const [payment] = await tx
          .insert(studentPayments)
          .values({
            academyId: access.academyId,
            studentId: student.id,
            chargeId: null,
            amountCents: data.initialPayment.amountCents,
            currency,
            method: data.initialPayment.method,
            reference: data.initialPayment.reference,
            notes: data.initialPayment.notes,
            receivedAt: data.initialPayment.receivedAt,
            recordedBy: actorContext.userId,
            status: "approved",
            approvedBy: actorContext.userId,
            approvedAt: now,
            idempotencyKey: data.idempotencyKey,
          })
          .returning();
        await tx.insert(paymentAllocations).values(
          split.allocations.map((allocation) => ({
            academyId: access.academyId,
            studentPaymentId: payment.id,
            feePeriodId: allocation.feePeriodId,
            amountCents: allocation.amountCents,
          })),
        );
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: access.membershipRole,
            academyId: access.academyId,
            branchId: batch.branchId,
            action: "recordProgramPayment",
            entityType: "student_payment",
            entityId: payment.id,
            after: { ...payment, programEnrollmentId: enrollment.id, allocations: split.allocations },
          },
          tx,
        );
        initialPaymentId = payment.id;
      }

      return {
        enrollment,
        courseEnrollmentIds: courseEnrollments.map((row) => row.id),
        installmentCents: plan.map((period) => period.expectedAmountCents),
        initialPaymentId,
      };
    });
    return {
      ok: true,
      enrollment: toRecord(result.enrollment),
      courseEnrollmentIds: result.courseEnrollmentIds,
      finalFeeCents,
      installmentCents: result.installmentCents,
      initialPaymentId: result.initialPaymentId,
    };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.error };
    if (data.idempotencyKey && isIdempotencyViolation(error, IDEMPOTENCY_INDEX.studentPayments)) {
      return { ok: false, error: IDEMPOTENCY_KEY_REUSED };
    }
    // A concurrent enrollment of the same student in the same program lost
    // the race on the partial unique index.
    if (isUniqueViolation(error)) {
      return { ok: false, error: { code: "conflict", message: "This student is already enrolled in this program." } };
    }
    throw error;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Record a program payment                                           */
/* ------------------------------------------------------------------ */

export const recordProgramPaymentSchema = z.object({
  programEnrollmentId: z.string().uuid("Invalid program enrollment"),
  ...paymentFields,
  idempotencyKey: idempotencyKeyField,
});

export type RecordProgramPaymentInput = z.input<typeof recordProgramPaymentSchema>;

export type RecordProgramPaymentResult =
  | {
      ok: true;
      payment: { id: string; studentId: string; amountCents: number; currency: string; method: "cash" | "mobile_money" | "bank_transfer"; allocations: { feePeriodId: string; amountCents: number }[] };
      duplicate?: boolean;
    }
  | { ok: false; error: ProgramEnrollmentError };

/**
 * Records money received against the program fee: the amount is applied to
 * the oldest outstanding installments first (same rule as a course's
 * recordEnrollmentPayment). Refused when there's nothing outstanding or when
 * it's more than everything outstanding (no overpayment). Never marks an
 * installment paid by itself — only recorded payments count.
 */
export async function recordProgramPayment(
  actorContext: AuthContext,
  input: RecordProgramPaymentInput,
): Promise<RecordProgramPaymentResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!canManageLevel(access.feeLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = recordProgramPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  // A retried submission (same key) returns the original payment.
  const replay = async (): Promise<RecordProgramPaymentResult | null> => {
    if (!data.idempotencyKey) return null;
    const keyed = await findKeyedStudentPayment(access.academyId, access.scope, data.idempotencyKey);
    if (keyed.kind === "none") return null;
    if (keyed.kind === "out_of_scope") return { ok: false, error: ENROLLMENT_NOT_FOUND };
    const { payment, allocations } = keyed;
    const same =
      allocations.length > 0 &&
      allocations.every((a) => a.programEnrollmentId === data.programEnrollmentId) &&
      payment.reversedPaymentId === null &&
      payment.chargeId === null &&
      payment.method === data.method &&
      payment.amountCents === data.amountCents;
    if (!same) return { ok: false, error: IDEMPOTENCY_KEY_REUSED };
    return {
      ok: true,
      duplicate: true,
      payment: {
        id: payment.id,
        studentId: payment.studentId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        method: payment.method,
        allocations: allocations.map((a) => ({ feePeriodId: a.feePeriodId, amountCents: a.amountCents })),
      },
    };
  };
  const prior = await replay();
  if (prior) return prior;

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const scoped = await getScopedProgramEnrollment(tx, access, data.programEnrollmentId);
      if (!scoped) throw new Refused(ENROLLMENT_NOT_FOUND);
      const enrollment = scoped.enrollment;

      const periods = await tx
        .select()
        .from(feePeriods)
        .where(and(eq(feePeriods.programEnrollmentId, enrollment.id), eq(feePeriods.academyId, access.academyId)))
        .for("update");
      const paidByPeriod = await getApprovedPaidCentsByPeriod(tx, periods.map((period) => period.id));
      const split = allocateOldestFirst(periods, paidByPeriod, data.amountCents);
      if (split.allocations.length === 0) {
        throw new Refused({ code: "validation", message: "There is no outstanding balance on this program to record a payment against." });
      }
      if (split.leftoverCents > 0) {
        throw new Refused({
          code: "conflict",
          message: `Amount exceeds the outstanding program balance (${formatMoney(split.outstandingCents, periods[0].currency)}). Overpayment is not supported.`,
        });
      }

      const now = new Date();
      const [payment] = await tx
        .insert(studentPayments)
        .values({
          academyId: access.academyId,
          studentId: enrollment.studentId,
          chargeId: null,
          amountCents: data.amountCents,
          currency: periods[0].currency,
          method: data.method,
          reference: data.reference,
          notes: data.notes,
          receivedAt: data.receivedAt,
          recordedBy: actorContext.userId,
          status: "approved",
          approvedBy: actorContext.userId,
          approvedAt: now,
          idempotencyKey: data.idempotencyKey,
        })
        .returning();
      await tx.insert(paymentAllocations).values(
        split.allocations.map((allocation) => ({
          academyId: access.academyId,
          studentPaymentId: payment.id,
          feePeriodId: allocation.feePeriodId,
          amountCents: allocation.amountCents,
        })),
      );
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          branchId: scoped.branchId,
          action: "recordProgramPayment",
          entityType: "student_payment",
          entityId: payment.id,
          after: { ...payment, programEnrollmentId: enrollment.id, allocations: split.allocations },
        },
        tx,
      );
      return { payment, allocations: split.allocations };
    });
  } catch (error) {
    if (error instanceof Refused) {
      // An identical request that committed first leaves no balance for this one.
      const winner = await replay();
      return winner ?? { ok: false, error: error.error };
    }
    if (data.idempotencyKey && isIdempotencyViolation(error, IDEMPOTENCY_INDEX.studentPayments)) {
      return (await replay()) ?? { ok: false, error: IDEMPOTENCY_KEY_REUSED };
    }
    throw error;
  }

  return {
    ok: true,
    payment: {
      id: result.payment.id,
      studentId: result.payment.studentId,
      amountCents: result.payment.amountCents,
      currency: result.payment.currency,
      method: result.payment.method,
      allocations: result.allocations,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Read: a student's program enrollments (student profile)            */
/* ------------------------------------------------------------------ */

export type ProgramPaymentStatus = "paid" | "partially_paid" | "unpaid";

export interface ProgramInstallment {
  id: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  expectedAmountCents: number;
  paidCents: number;
  remainingCents: number;
  status: FeePeriodStatus;
}

export interface ProgramPaymentRow {
  paymentId: string;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  receivedAt: Date;
  receiptId: string | null;
  receiptNumber: string | null;
  refundedCents: number;
}

export interface ProgramBilling {
  currency: string;
  /** What staff entered as the full program fee (final + discount). */
  programFeeCents: number;
  discountCents: number;
  /** The total actually owed: program fee − discount. */
  finalFeeCents: number;
  installments: number;
  installmentCents: number[];
  anchorDate: string;
  paidCents: number;
  refundedCents: number;
  outstandingCents: number;
  overdueCents: number;
  status: ProgramPaymentStatus;
  periods: ProgramInstallment[];
  payments: ProgramPaymentRow[];
}

export interface StudentProgramEnrollment extends ProgramEnrollmentRecord {
  programName: string;
  batchName: string;
  batchCode: string;
  branchId: string;
  courses: { enrollmentId: string; courseId: string; courseName: string; status: "active" | "withdrawn" | "completed"; startDate: string | null; endDate: string | null; instructorName: string | null }[];
  /** null when the viewer has no access to student fees. */
  billing: ProgramBilling | null;
}

export type ListStudentProgramEnrollmentsResult =
  | { ok: true; enrollments: StudentProgramEnrollment[]; canRecordPayment: boolean; canWithdraw: boolean; canRefund: boolean }
  | { ok: false; error: ProgramEnrollmentError };

export function programPaymentStatus(finalFeeCents: number, paidCents: number): ProgramPaymentStatus {
  // Nothing to pay (a full scholarship): settled.
  if (finalFeeCents <= 0) return "paid";
  if (paidCents <= 0) return "unpaid";
  return paidCents >= finalFeeCents ? "paid" : "partially_paid";
}

export async function listStudentProgramEnrollments(
  actorContext: AuthContext,
  studentId: string,
): Promise<ListStudentProgramEnrollmentsResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (access.studentsLevel === "none" && access.feeLevel === "none") return { ok: false, error: FORBIDDEN };
  const flags = {
    canRecordPayment: canManageLevel(access.feeLevel),
    canWithdraw: canManageEnrollments(access),
    canRefund: canRecordCourseRefund(access.membershipRole),
  };
  if (!z.string().uuid().safeParse(studentId).success) return { ok: true, enrollments: [], ...flags };

  const rows = await db
    .select({
      enrollment: programEnrollments,
      programName: programs.name,
      batchName: batches.name,
      batchCode: batches.code,
      branchId: batches.branchId,
    })
    .from(programEnrollments)
    .innerJoin(programs, eq(programs.id, programEnrollments.programId))
    .innerJoin(batches, eq(batches.id, programEnrollments.batchId))
    .where(and(eq(programEnrollments.academyId, access.academyId), eq(programEnrollments.studentId, studentId)))
    .orderBy(desc(programEnrollments.enrolledAt));
  const visible = rows.filter((row) => inBranchScope(access.scope, row.branchId));
  if (visible.length === 0) return { ok: true, enrollments: [], ...flags };
  const ids = visible.map((row) => row.enrollment.id);

  const courseRows = await db
    .select({
      programEnrollmentId: batchEnrollments.programEnrollmentId,
      enrollmentId: batchEnrollments.id,
      courseId: batchEnrollments.courseId,
      courseName: courses.name,
      status: batchEnrollments.status,
      startDate: batchCourses.startDate,
      endDate: batchCourses.endDate,
      instructorName: staffProfiles.fullName,
    })
    .from(batchEnrollments)
    .innerJoin(courses, eq(courses.id, batchEnrollments.courseId))
    .innerJoin(batchCourses, and(eq(batchCourses.batchId, batchEnrollments.batchId), eq(batchCourses.courseId, batchEnrollments.courseId)))
    .leftJoin(staffProfiles, eq(staffProfiles.id, courses.instructorId))
    .where(and(eq(batchEnrollments.academyId, access.academyId), inArray(batchEnrollments.programEnrollmentId, ids)))
    .orderBy(asc(batchCourses.startDate), asc(courses.name));

  const billingById = access.feeLevel === "none" ? new Map<string, ProgramBilling>() : await loadBilling(access.academyId, ids);

  return {
    ok: true,
    ...flags,
    enrollments: visible.map((row) => ({
      ...toRecord(row.enrollment),
      programName: row.programName,
      batchName: row.batchName,
      batchCode: row.batchCode,
      branchId: row.branchId,
      courses: courseRows
        .filter((course) => course.programEnrollmentId === row.enrollment.id)
        .map((course) => ({
          enrollmentId: course.enrollmentId,
          courseId: course.courseId,
          courseName: course.courseName,
          status: course.status,
          startDate: course.startDate,
          endDate: course.endDate,
          instructorName: course.instructorName,
        })),
      billing: billingById.get(row.enrollment.id) ?? null,
    })),
  };
}

/** A program enrollment's fee plan in one line's worth of data, for lists
 * (the batch roster). Empty when the viewer can't see student fees. */
export interface ProgramFeePlanSummary {
  scholarship: ScholarshipKind | null;
  /** The current plan (null: free, or nothing left to pay). */
  plan: { amountCents: number; intervalMonths: number; currency: string } | null;
}

export async function getProgramFeePlans(actorContext: AuthContext, programEnrollmentIds: string[]): Promise<Map<string, ProgramFeePlanSummary>> {
  const result = new Map<string, ProgramFeePlanSummary>();
  const ids = [...new Set(programEnrollmentIds)].filter((id) => z.string().uuid().safeParse(id).success);
  if (ids.length === 0) return result;
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok || resolved.access.feeLevel === "none") return result;
  const access = resolved.access;
  const rows = await db
    .select({
      id: programEnrollments.id,
      scholarship: programEnrollments.scholarship,
      branchId: batches.branchId,
      amountCents: enrollmentFeeSchedules.amountCents,
      intervalMonths: enrollmentFeeSchedules.intervalMonths,
      currency: enrollmentFeeSchedules.currency,
    })
    .from(programEnrollments)
    .innerJoin(batches, eq(batches.id, programEnrollments.batchId))
    .leftJoin(enrollmentFeeSchedules, eq(enrollmentFeeSchedules.programEnrollmentId, programEnrollments.id))
    .where(and(eq(programEnrollments.academyId, access.academyId), inArray(programEnrollments.id, ids)));
  for (const row of rows) {
    if (!inBranchScope(access.scope, row.branchId)) continue;
    result.set(row.id, {
      scholarship: row.scholarship ?? null,
      plan:
        row.amountCents !== null && row.intervalMonths !== null && row.currency !== null
          ? { amountCents: row.amountCents, intervalMonths: row.intervalMonths, currency: row.currency }
          : null,
    });
  }
  return result;
}

/** Program fee, installments, payments and balances for these enrollments. */
async function loadBilling(academyId: string, programEnrollmentIds: string[]): Promise<Map<string, ProgramBilling>> {
  const [schedules, periods] = await Promise.all([
    db
      .select()
      .from(enrollmentFeeSchedules)
      .where(and(eq(enrollmentFeeSchedules.academyId, academyId), inArray(enrollmentFeeSchedules.programEnrollmentId, programEnrollmentIds))),
    db
      .select()
      .from(feePeriods)
      .where(and(eq(feePeriods.academyId, academyId), inArray(feePeriods.programEnrollmentId, programEnrollmentIds))),
  ]);
  const paidByPeriod = await getApprovedPaidCentsByPeriod(db, periods.map((period) => period.id));

  const paymentRows = periods.length
    ? await db
        .select({
          programEnrollmentId: feePeriods.programEnrollmentId,
          paymentId: studentPayments.id,
          amountCents: studentPayments.amountCents,
          currency: studentPayments.currency,
          method: studentPayments.method,
          status: studentPayments.status,
          receivedAt: studentPayments.receivedAt,
        })
        .from(paymentAllocations)
        .innerJoin(feePeriods, eq(feePeriods.id, paymentAllocations.feePeriodId))
        .innerJoin(studentPayments, eq(studentPayments.id, paymentAllocations.studentPaymentId))
        .where(and(eq(studentPayments.academyId, academyId), inArray(feePeriods.programEnrollmentId, programEnrollmentIds)))
    : [];
  const paymentIds = [...new Set(paymentRows.map((row) => row.paymentId))];
  const [receiptRows, refundRows, refundTotals] = await Promise.all([
    paymentIds.length
      ? db
          .select({ paymentId: receipts.studentPaymentId, id: receipts.id, number: receipts.receiptNumber })
          .from(receipts)
          .where(and(eq(receipts.academyId, academyId), inArray(receipts.studentPaymentId, paymentIds)))
      : Promise.resolve([]),
    paymentIds.length
      ? db
          .select({
            paymentId: studentCourseRefundPayments.studentPaymentId,
            cents: sql<number>`coalesce(sum(${studentCourseRefundPayments.amountCents}), 0)::int`,
          })
          .from(studentCourseRefundPayments)
          .innerJoin(studentCourseRefunds, eq(studentCourseRefunds.id, studentCourseRefundPayments.refundId))
          .where(and(eq(studentCourseRefunds.academyId, academyId), inArray(studentCourseRefundPayments.studentPaymentId, paymentIds)))
          .groupBy(studentCourseRefundPayments.studentPaymentId)
      : Promise.resolve([]),
    db
      .select({
        programEnrollmentId: studentCourseRefunds.programEnrollmentId,
        cents: sql<number>`coalesce(sum(${studentCourseRefunds.amountCents}), 0)::int`,
      })
      .from(studentCourseRefunds)
      .where(and(eq(studentCourseRefunds.academyId, academyId), inArray(studentCourseRefunds.programEnrollmentId, programEnrollmentIds)))
      .groupBy(studentCourseRefunds.programEnrollmentId),
  ]);
  const receiptByPayment = new Map(receiptRows.map((row) => [row.paymentId, row]));
  const refundedByPayment = new Map(refundRows.map((row) => [row.paymentId, Number(row.cents)]));
  const refundedByEnrollment = new Map(refundTotals.map((row) => [row.programEnrollmentId, Number(row.cents)]));

  const today = todayDateOnly();
  const result = new Map<string, ProgramBilling>();
  const scheduleById = new Map(schedules.map((row) => [row.programEnrollmentId, row]));
  for (const id of programEnrollmentIds) {
    // No schedule = a full scholarship, or a fee already paid in full after
    // Change fee (lib/academies/fee-plan-change.ts): nothing more is due.
    const schedule = scheduleById.get(id) ?? null;
    const own = periods
      .filter((period) => period.programEnrollmentId === id)
      .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
    const installments: ProgramInstallment[] = own.map((period) => {
      const paid = paidByPeriod.get(period.id) ?? 0;
      return {
        id: period.id,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueDate: period.dueDate,
        expectedAmountCents: period.expectedAmountCents,
        paidCents: paid,
        remainingCents: Math.max(0, period.expectedAmountCents - paid),
        status: computeFeePeriodStatus(period.expectedAmountCents, paid, period.dueDate, today),
      };
    });
    const paidCents = installments.reduce((sum, p) => sum + Math.min(p.paidCents, p.expectedAmountCents), 0);
    // What is owed in total is what the installments charge: after Change
    // fee the schedule describes only the part planned from its anchor on.
    const finalFeeCents = own.reduce((sum, period) => sum + period.expectedAmountCents, 0);
    const discountCents = schedule?.discountCents ?? 0;
    const seen = new Set<string>();
    const payments: ProgramPaymentRow[] = [];
    for (const row of paymentRows.filter((payment) => payment.programEnrollmentId === id)) {
      if (seen.has(row.paymentId)) continue;
      seen.add(row.paymentId);
      const receipt = receiptByPayment.get(row.paymentId);
      payments.push({
        paymentId: row.paymentId,
        amountCents: row.amountCents,
        currency: row.currency,
        method: row.method,
        status: row.status,
        receivedAt: row.receivedAt,
        receiptId: receipt?.id ?? null,
        receiptNumber: receipt?.number ?? null,
        refundedCents: refundedByPayment.get(row.paymentId) ?? 0,
      });
    }
    payments.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    result.set(id, {
      currency: schedule?.currency ?? own[0]?.currency ?? "USD",
      programFeeCents: finalFeeCents + discountCents,
      discountCents,
      finalFeeCents,
      installments: schedule?.intervalMonths ?? own.length,
      installmentCents: own.map((period) => period.expectedAmountCents),
      anchorDate: schedule?.anchorDate ?? own[0]?.periodStart ?? "",
      paidCents,
      refundedCents: refundedByEnrollment.get(id) ?? 0,
      outstandingCents: Math.max(0, finalFeeCents - paidCents),
      overdueCents: installments.filter((p) => p.status === "overdue").reduce((sum, p) => sum + p.remainingCents, 0),
      status: programPaymentStatus(finalFeeCents, paidCents),
      periods: installments,
      payments,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Withdraw (optionally with a refund)                                 */
/* ------------------------------------------------------------------ */

export const withdrawFromProgramSchema = z.object({
  programEnrollmentId: z.string().uuid(),
  reason: z.string().trim().min(1, "A withdrawal reason is required.").max(WITHDRAW_REASON_MAX),
  refund: z
    .object({
      amountCents: z.number().int("The refund must be a whole number of cents.").positive("The refund must be more than zero."),
      method: methodSchema,
      refundedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Enter the date the money was returned."),
      reference: z.string().trim().max(200).optional(),
      reason: z.string().trim().min(1, "A refund reason is required.").max(500),
      idempotencyKey: z.string().uuid(),
    })
    .optional(),
});

export type WithdrawFromProgramInput = z.input<typeof withdrawFromProgramSchema>;

export type WithdrawFromProgramResult =
  | { ok: true; enrollment: ProgramEnrollmentRecord; refundId: string | null }
  | { ok: false; error: ProgramEnrollmentError };

/** Each payment's approved share of this program enrollment, and what was
 * already refunded from it (same shape as course refunds' loadShares). */
async function loadProgramShares(executor: DbClient, academyId: string, programEnrollmentId: string): Promise<(EnrollmentPaymentShare & { currency: string })[]> {
  const allocated = await executor
    .select({
      paymentId: studentPayments.id,
      receivedAt: studentPayments.receivedAt,
      currency: studentPayments.currency,
      allocatedCents: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)::int`,
    })
    .from(paymentAllocations)
    .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
    .innerJoin(studentPayments, eq(paymentAllocations.studentPaymentId, studentPayments.id))
    .where(and(eq(feePeriods.programEnrollmentId, programEnrollmentId), eq(studentPayments.academyId, academyId), eq(studentPayments.status, "approved")))
    .groupBy(studentPayments.id, studentPayments.receivedAt, studentPayments.currency);
  const refunded = await executor
    .select({
      paymentId: studentCourseRefundPayments.studentPaymentId,
      refundedCents: sql<number>`coalesce(sum(${studentCourseRefundPayments.amountCents}), 0)::int`,
    })
    .from(studentCourseRefundPayments)
    .innerJoin(studentCourseRefunds, eq(studentCourseRefundPayments.refundId, studentCourseRefunds.id))
    .where(and(eq(studentCourseRefunds.programEnrollmentId, programEnrollmentId), eq(studentCourseRefunds.academyId, academyId)))
    .groupBy(studentCourseRefundPayments.studentPaymentId);
  const refundedByPayment = new Map(refunded.map((row) => [row.paymentId, Number(row.refundedCents)]));
  const shares = allocated.map((row) => ({
    paymentId: row.paymentId,
    receivedAt: row.receivedAt,
    currency: row.currency,
    allocatedCents: Number(row.allocatedCents),
    refundedCents: refundedByPayment.get(row.paymentId) ?? 0,
  }));
  for (const [paymentId, refundedCents] of refundedByPayment) {
    if (!shares.some((share) => share.paymentId === paymentId)) {
      shares.push({ paymentId, receivedAt: new Date(0), currency: "", allocatedCents: 0, refundedCents });
    }
  }
  return shares;
}

export interface ProgramRefundPosition {
  currency: string | null;
  paidCents: number;
  refundedCents: number;
  refundableCents: number;
}

export async function getProgramRefundPosition(
  actorContext: AuthContext,
  programEnrollmentId: string,
): Promise<{ ok: true; position: ProgramRefundPosition } | { ok: false; error: ProgramEnrollmentError }> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  if (resolved.access.feeLevel === "none") return { ok: false, error: FORBIDDEN };
  const scoped = await getScopedProgramEnrollment(db, resolved.access, programEnrollmentId);
  if (!scoped) return { ok: false, error: ENROLLMENT_NOT_FOUND };
  const shares = await loadProgramShares(db, resolved.access.academyId, programEnrollmentId);
  const currencies = new Set(shares.filter((s) => s.currency).map((s) => s.currency));
  return {
    ok: true,
    position: {
      currency: currencies.size === 1 ? [...currencies][0] : null,
      paidCents: paidForEnrollmentCents(shares),
      refundedCents: refundedForEnrollmentCents(shares),
      refundableCents: currencies.size > 1 ? 0 : refundableCents(shares),
    },
  };
}

/**
 * Withdraws a student from a program: the program enrollment and its
 * still-active course enrollments become "withdrawn" (never deleted), with an
 * optional refund of money already returned, all in one transaction. The
 * refund cap is what was paid towards THIS program enrollment minus earlier
 * refunds of it — the same rules as course refunds. Payments, allocations,
 * receipts and installments are never changed.
 */
export async function withdrawFromProgram(
  actorContext: AuthContext,
  input: WithdrawFromProgramInput,
): Promise<WithdrawFromProgramResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!canManageEnrollments(access)) return { ok: false, error: FORBIDDEN };

  const parsed = withdrawFromProgramSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const { programEnrollmentId, reason, refund } = parsed.data;
  if (refund && !canRecordCourseRefund(access.membershipRole)) {
    return { ok: false, error: { code: "forbidden", message: "Only the Academy Owner, Academy Administrator or a Manager can record a refund." } };
  }
  const refundedAt = refund ? new Date(refund.refundedAt.length === 10 ? `${refund.refundedAt}T12:00:00Z` : refund.refundedAt) : null;
  if (refundedAt && (Number.isNaN(refundedAt.getTime()) || refundedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000)) {
    return { ok: false, error: { code: "validation", message: "Enter the date the money was returned (not in the future)." } };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ enrollment: programEnrollments, branchId: batches.branchId })
        .from(programEnrollments)
        .innerJoin(batches, eq(batches.id, programEnrollments.batchId))
        .where(and(eq(programEnrollments.id, programEnrollmentId), eq(programEnrollments.academyId, access.academyId)))
        .for("update");
      if (!locked || !inBranchScope(access.scope, locked.branchId)) throw new Refused(ENROLLMENT_NOT_FOUND);
      if (locked.enrollment.status !== "active") {
        throw new Refused({ code: "invalid_transition", message: `This program enrollment is already ${locked.enrollment.status}.` });
      }

      let refundId: string | null = null;
      if (refund && refundedAt) {
        const fundingIds = (
          await tx
            .selectDistinct({ id: paymentAllocations.studentPaymentId })
            .from(paymentAllocations)
            .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
            .where(eq(feePeriods.programEnrollmentId, programEnrollmentId))
        ).map((row) => row.id);
        if (fundingIds.length > 0) {
          await tx
            .select({ id: studentPayments.id })
            .from(studentPayments)
            .where(and(inArray(studentPayments.id, fundingIds), eq(studentPayments.academyId, access.academyId)))
            .orderBy(studentPayments.id)
            .for("update");
        }
        const shares = await loadProgramShares(tx, access.academyId, programEnrollmentId);
        const currencies = new Set(shares.filter((s) => s.currency).map((s) => s.currency));
        if (currencies.size !== 1) {
          throw new Refused({
            code: "validation",
            message: currencies.size === 0 ? "Nothing was paid for this program, so there is nothing to refund." : "This program's payments are in more than one currency.",
          });
        }
        const currency = [...currencies][0];
        const check = checkRefundCents(refund.amountCents, refundableCents(shares), (cents) => formatMoney(cents, currency));
        if (!check.ok) throw new Refused({ code: "validation", message: check.message });
        const links = attributeRefund(shares, check.amountCents);
        if (!links || links.length === 0) throw new Refused({ code: "validation", message: "Nothing paid for this program is left to refund." });

        const [row] = await tx
          .insert(studentCourseRefunds)
          .values({
            academyId: access.academyId,
            branchId: locked.branchId,
            programEnrollmentId,
            studentId: locked.enrollment.studentId,
            amountCents: check.amountCents,
            currency,
            method: refund.method,
            refundedAt,
            reference: refund.reference || null,
            reason: refund.reason,
            recordedBy: actorContext.userId,
            idempotencyKey: refund.idempotencyKey,
          })
          .returning();
        await tx
          .insert(studentCourseRefundPayments)
          .values(links.map((link) => ({ refundId: row.id, studentPaymentId: link.paymentId, amountCents: link.amountCents })));
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: access.membershipRole,
            academyId: access.academyId,
            branchId: locked.branchId,
            action: "recordProgramRefund",
            entityType: "student_course_refund",
            entityId: row.id,
            after: { programEnrollmentId, studentId: locked.enrollment.studentId, amountCents: row.amountCents, currency, method: row.method, payments: links },
            reason: refund.reason,
          },
          tx,
        );
        refundId = row.id;
      }

      const [updated] = await tx
        .update(programEnrollments)
        .set({ status: "withdrawn" })
        .where(eq(programEnrollments.id, programEnrollmentId))
        .returning();
      await tx
        .update(batchEnrollments)
        .set({ status: "withdrawn" })
        .where(and(eq(batchEnrollments.programEnrollmentId, programEnrollmentId), eq(batchEnrollments.status, "active")));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          branchId: locked.branchId,
          action: "withdrawFromProgram",
          entityType: "program_enrollment",
          entityId: programEnrollmentId,
          before: { status: locked.enrollment.status },
          after: { status: "withdrawn", refundId },
          context: { reason },
        },
        tx,
      );
      return { enrollment: updated, refundId };
    });
    return { ok: true, enrollment: toRecord(result.enrollment), refundId: result.refundId };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.error };
    if (isUniqueViolation(error)) {
      return { ok: false, error: { code: "conflict", message: "This refund was already recorded." } };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Read: program batches open for program enrollment                   */
/* ------------------------------------------------------------------ */

export interface ProgramBatchOption {
  batchId: string;
  batchName: string;
  batchCode: string;
  branchId: string;
  status: "planned" | "active";
  programId: string;
  programName: string;
  courses: { courseId: string; courseName: string; startDate: string | null; endDate: string | null }[];
}

/** Planned/active program-based batches (with their programs and courses)
 * the caller may enroll into — academy- and branch-scoped. */
export async function listProgramBatchOptions(actorContext: AuthContext): Promise<{ ok: true; batches: ProgramBatchOption[] } | { ok: false; error: ProgramEnrollmentError }> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!canManageEnrollments(access)) return { ok: true, batches: [] };

  const rows = await db
    .select({ batch: batches, programName: programs.name })
    .from(batches)
    .innerJoin(programs, eq(programs.id, batches.programId))
    .where(and(eq(batches.academyId, access.academyId), inArray(batches.status, ["planned", "active"]), eq(programs.status, "active")))
    .orderBy(asc(batches.code));
  const visible = rows.filter((row) => inBranchScope(access.scope, row.batch.branchId));
  if (visible.length === 0) return { ok: true, batches: [] };
  const courseRows = await db
    .select({ batchId: batchCourses.batchId, courseId: batchCourses.courseId, courseName: courses.name, startDate: batchCourses.startDate, endDate: batchCourses.endDate })
    .from(batchCourses)
    .innerJoin(courses, eq(courses.id, batchCourses.courseId))
    .where(inArray(batchCourses.batchId, visible.map((row) => row.batch.id)))
    .orderBy(asc(batchCourses.startDate), asc(courses.name));
  return {
    ok: true,
    batches: visible.map((row) => ({
      batchId: row.batch.id,
      batchName: row.batch.name,
      batchCode: row.batch.code,
      branchId: row.batch.branchId,
      status: row.batch.status as "planned" | "active",
      programId: row.batch.programId!,
      programName: row.programName,
      courses: courseRows
        .filter((course) => course.batchId === row.batch.id)
        .map((course) => ({ courseId: course.courseId, courseName: course.courseName, startDate: course.startDate, endDate: course.endDate })),
    })),
  };
}
