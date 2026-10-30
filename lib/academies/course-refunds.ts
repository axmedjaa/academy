import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batches,
  courses,
  feePeriods,
  paymentAllocations,
  studentCourseRefundPayments,
  studentCourseRefunds,
  studentPayments,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STUDENT_PAYMENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/ui/money";
import { getAssignedBranchIds } from "@/lib/academies/students";
import { WITHDRAW_REASON_MAX, withdrawStudentFromBatch, type BatchAssignmentActionError } from "@/lib/academies/batch-assignments";
import {
  attributeRefund,
  checkRefundCents,
  paidForEnrollmentCents,
  refundableCents,
  refundedForEnrollmentCents,
  type EnrollmentPaymentShare,
} from "@/lib/academies/course-refund-rules";

/**
 * Course-withdrawal refunds (approved policy, migration 0036).
 *
 * - Only when a student withdraws from a course: the refund is recorded in
 *   the SAME transaction as the withdrawal (`withdrawStudentFromBatch`'s
 *   `withinTransaction` step), so both commit or neither does, and a
 *   withdrawn enrollment can't be refunded again through this path.
 * - Cap: net paid for that enrollment (approved allocations to its fee
 *   periods) minus refunds already recorded for it — recomputed inside the
 *   transaction from locked rows (course-refund-rules.ts).
 * - Who: the Academy Owner or a Manager (student-payments level "full"),
 *   one operator, no second approver. Branch-limited roles never qualify.
 * - What it records: money the academy already returned manually. It is not
 *   a payment (never counted as received) and not a reversal; original
 *   payments, allocations, receipts and fee periods are never changed.
 *
 * Every id other than the enrollment's is derived on the server (academy,
 * branch, student, the original payments); none is taken from the client.
 */

export const COURSE_REFUND_REASON_MAX = 500;
export const COURSE_REFUND_REFERENCE_MAX = 200;

export interface CourseRefundError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "invalid_transition" | "conflict";
  message: string;
}

const FORBIDDEN: CourseRefundError = {
  code: "forbidden",
  message: "Only the Academy Owner or a Manager can record a refund.",
};
const NOT_FOUND: CourseRefundError = { code: "not_found", message: "Enrollment not found." };

const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set(["admissions_officer", "trainer"]);

/** The approved refund authority: Academy Owner, or Manager. */
export function canRecordCourseRefund(role: AcademyRole): boolean {
  return role === "academy_owner" || getAcademyPermissionLevel(role, ACADEMY_STUDENT_PAYMENTS_ACTION) === "full";
}

/** Each payment's approved share of this enrollment, and what was already refunded from it. */
async function loadShares(executor: DbClient, academyId: string, enrollmentId: string): Promise<(EnrollmentPaymentShare & { currency: string })[]> {
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
    .where(
      and(
        eq(feePeriods.enrollmentId, enrollmentId),
        eq(studentPayments.academyId, academyId),
        eq(studentPayments.status, "approved"),
      ),
    )
    .groupBy(studentPayments.id, studentPayments.receivedAt, studentPayments.currency);

  const refunded = await executor
    .select({
      paymentId: studentCourseRefundPayments.studentPaymentId,
      refundedCents: sql<number>`coalesce(sum(${studentCourseRefundPayments.amountCents}), 0)::int`,
    })
    .from(studentCourseRefundPayments)
    .innerJoin(studentCourseRefunds, eq(studentCourseRefundPayments.refundId, studentCourseRefunds.id))
    .where(and(eq(studentCourseRefunds.enrollmentId, enrollmentId), eq(studentCourseRefunds.academyId, academyId)))
    .groupBy(studentCourseRefundPayments.studentPaymentId);
  const refundedByPayment = new Map(refunded.map((row) => [row.paymentId, Number(row.refundedCents)]));

  const shares = allocated.map((row) => ({
    paymentId: row.paymentId,
    receivedAt: row.receivedAt,
    currency: row.currency,
    allocatedCents: Number(row.allocatedCents),
    refundedCents: refundedByPayment.get(row.paymentId) ?? 0,
  }));
  // Refunds against a payment whose allocation no longer counts (e.g. it was
  // reversed before the guard existed) still count as refunded.
  for (const [paymentId, refundedCents] of refundedByPayment) {
    if (!shares.some((share) => share.paymentId === paymentId)) {
      shares.push({ paymentId, receivedAt: new Date(0), currency: "", allocatedCents: 0, refundedCents });
    }
  }
  return shares;
}

/** The one currency of this enrollment's fee periods, or null when there are none or several. */
async function enrollmentCurrency(executor: DbClient, enrollmentId: string): Promise<string | null | "mixed"> {
  const rows = await executor
    .selectDistinct({ currency: feePeriods.currency })
    .from(feePeriods)
    .where(eq(feePeriods.enrollmentId, enrollmentId));
  if (rows.length === 0) return null;
  return rows.length === 1 ? rows[0].currency : "mixed";
}

/* ------------------------------------------------------------------ */
/* Read: the refund position the withdraw dialog shows                 */
/* ------------------------------------------------------------------ */

export interface CourseRefundPosition {
  currency: string | null;
  paidCents: number;
  refundedCents: number;
  refundableCents: number;
  /** Whether this viewer may record a refund (Owner or Manager). */
  canRecord: boolean;
  /** Why a refund can't be recorded for this enrollment, if it can't. */
  blockedReason: string | null;
}

export type GetCourseRefundPositionResult = { ok: true; position: CourseRefundPosition } | { ok: false; error: CourseRefundError };

export async function getCourseRefundPosition(actorContext: AuthContext, enrollmentId: string): Promise<GetCourseRefundPositionResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have access to student payments." } };
  }
  if (!z.string().uuid().safeParse(enrollmentId).success) return { ok: false, error: NOT_FOUND };

  const [enrollment] = await db
    .select({ id: batchEnrollments.id, branchId: batches.branchId })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .where(and(eq(batchEnrollments.id, enrollmentId), eq(batchEnrollments.academyId, academyId)))
    .limit(1);
  if (!enrollment) return { ok: false, error: NOT_FOUND };
  if (BRANCH_LIMITED_ROLES.has(membershipRole)) {
    const assigned = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assigned.includes(enrollment.branchId)) return { ok: false, error: NOT_FOUND };
  }

  const [shares, currency] = await Promise.all([loadShares(db, academyId, enrollmentId), enrollmentCurrency(db, enrollmentId)]);
  const mixedPayments = new Set(shares.filter((s) => s.currency).map((s) => s.currency)).size > 1;
  const blockedReason =
    currency === "mixed" || mixedPayments
      ? "This course's fees or payments are in more than one currency, so the refundable amount can't be worked out reliably."
      : null;
  return {
    ok: true,
    position: {
      currency: currency === "mixed" ? null : currency,
      paidCents: paidForEnrollmentCents(shares),
      refundedCents: refundedForEnrollmentCents(shares),
      refundableCents: blockedReason ? 0 : refundableCents(shares),
      canRecord: canRecordCourseRefund(membershipRole),
      blockedReason,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Write: withdraw and record a refund, in one transaction             */
/* ------------------------------------------------------------------ */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/, "Enter the date the money was returned.");

export const withdrawWithRefundSchema = z.object({
  enrollmentId: z.string().uuid(),
  withdrawReason: z.string().trim().min(1, "A withdrawal reason is required.").max(WITHDRAW_REASON_MAX),
  refund: z.object({
    amountCents: z.number().int("The refund must be a whole number of cents.").positive("The refund must be more than zero."),
    method: z.enum(["cash", "mobile_money", "bank_transfer"]),
    refundedAt: isoDate,
    reference: z.string().trim().max(COURSE_REFUND_REFERENCE_MAX).optional(),
    reason: z.string().trim().min(1, "A refund reason is required.").max(COURSE_REFUND_REASON_MAX),
    idempotencyKey: z.string().uuid(),
  }),
});
export type WithdrawWithRefundInput = z.input<typeof withdrawWithRefundSchema>;

export interface CourseRefundRecord {
  id: string;
  enrollmentId: string;
  studentId: string;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  refundedAt: Date;
  reference: string | null;
  reason: string;
  recordedBy: string;
  createdAt: Date;
  payments: { studentPaymentId: string; amountCents: number }[];
}

export type WithdrawWithRefundResult =
  | { ok: true; refund: CourseRefundRecord; alreadyRecorded: boolean }
  | { ok: false; error: CourseRefundError | BatchAssignmentActionError };

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

async function refundByKey(academyId: string, idempotencyKey: string): Promise<CourseRefundRecord | null> {
  const [row] = await db
    .select()
    .from(studentCourseRefunds)
    .where(and(eq(studentCourseRefunds.academyId, academyId), eq(studentCourseRefunds.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!row) return null;
  const links = await db
    .select({ studentPaymentId: studentCourseRefundPayments.studentPaymentId, amountCents: studentCourseRefundPayments.amountCents })
    .from(studentCourseRefundPayments)
    .where(eq(studentCourseRefundPayments.refundId, row.id));
  return { ...toRecord(row), payments: links };
}

function toRecord(row: typeof studentCourseRefunds.$inferSelect): Omit<CourseRefundRecord, "payments"> {
  return {
    id: row.id,
    enrollmentId: row.enrollmentId,
    studentId: row.studentId,
    amountCents: row.amountCents,
    currency: row.currency,
    method: row.method,
    refundedAt: row.refundedAt,
    reference: row.reference,
    reason: row.reason,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
  };
}

export async function withdrawStudentWithRefund(
  actorContext: AuthContext,
  input: WithdrawWithRefundInput,
): Promise<WithdrawWithRefundResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  if (!canRecordCourseRefund(membershipRole)) return { ok: false, error: FORBIDDEN };

  const parsed = withdrawWithRefundSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid refund." } };
  }
  const { enrollmentId, withdrawReason, refund } = parsed.data;
  const refundedAt = new Date(refund.refundedAt.length === 10 ? `${refund.refundedAt}T12:00:00Z` : refund.refundedAt);
  if (Number.isNaN(refundedAt.getTime())) return { ok: false, error: { code: "validation", message: "Enter the date the money was returned." } };
  if (refundedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return { ok: false, error: { code: "validation", message: "The refund date can't be in the future: record a refund only after the money was returned." } };
  }

  // A retried submission (same key) returns what the first one recorded.
  const earlier = await refundByKey(academyId, refund.idempotencyKey);
  if (earlier) {
    return earlier.enrollmentId === enrollmentId
      ? { ok: true, refund: earlier, alreadyRecorded: true }
      : { ok: false, error: { code: "conflict", message: "This submission was already used for another refund." } };
  }

  let recorded: CourseRefundRecord | null = null;
  let result;
  try {
    result = await withdrawStudentFromBatch(actorContext, enrollmentId, {
      reason: withdrawReason,
      withinTransaction: async (tx, locked) => {
        // Lock every payment that funded this enrollment (id order, so two
        // transactions never wait on each other in opposite orders); a
        // concurrent reversal of one of them waits until this commits.
        const fundingIds = (
          await tx
            .selectDistinct({ id: paymentAllocations.studentPaymentId })
            .from(paymentAllocations)
            .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
            .where(eq(feePeriods.enrollmentId, locked.enrollmentId))
        ).map((row) => row.id);
        if (fundingIds.length > 0) {
          await tx
            .select({ id: studentPayments.id })
            .from(studentPayments)
            .where(and(inArray(studentPayments.id, fundingIds), eq(studentPayments.academyId, locked.academyId)))
            .orderBy(studentPayments.id)
            .for("update");
        }

        const [shares, currency] = await Promise.all([
          loadShares(tx, locked.academyId, locked.enrollmentId),
          enrollmentCurrency(tx, locked.enrollmentId),
        ]);
        const paymentCurrencies = new Set(shares.filter((s) => s.currency).map((s) => s.currency));
        if (currency === null) return { code: "validation", message: "This course has no fee periods, so nothing was paid for it to refund." };
        if (currency === "mixed" || paymentCurrencies.size > 1 || (paymentCurrencies.size === 1 && !paymentCurrencies.has(currency))) {
          return {
            code: "validation",
            message: "This course's fees or payments are in more than one currency, so the refundable amount can't be worked out reliably.",
          };
        }

        const format = (cents: number) => formatMoney(cents, currency);
        const check = checkRefundCents(refund.amountCents, refundableCents(shares), format);
        if (!check.ok) return { code: "validation", message: check.message };
        const links = attributeRefund(shares, check.amountCents);
        if (!links || links.length === 0) return { code: "validation", message: "Nothing paid for this course is left to refund." };

        const [row] = await tx
          .insert(studentCourseRefunds)
          .values({
            academyId: locked.academyId,
            branchId: locked.branchId,
            enrollmentId: locked.enrollmentId,
            studentId: locked.studentId,
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
            actorRole: locked.membershipRole,
            academyId: locked.academyId,
            branchId: locked.branchId,
            action: "recordCourseRefund",
            entityType: "student_course_refund",
            entityId: row.id,
            after: {
              enrollmentId: locked.enrollmentId,
              studentId: locked.studentId,
              amountCents: row.amountCents,
              currency,
              method: row.method,
              refundedAt: row.refundedAt.toISOString(),
              reference: row.reference,
              payments: links,
            },
            reason: refund.reason,
          },
          tx,
        );

        recorded = { ...toRecord(row), payments: links.map((link) => ({ studentPaymentId: link.paymentId, amountCents: link.amountCents })) };
        return null;
      },
    });
  } catch (error) {
    // A concurrent duplicate submission lost the race on the unique key.
    if (isUniqueViolation(error)) {
      const winner = await refundByKey(academyId, refund.idempotencyKey);
      if (winner && winner.enrollmentId === enrollmentId) return { ok: true, refund: winner, alreadyRecorded: true };
      return { ok: false, error: { code: "conflict", message: "This refund was already recorded." } };
    }
    throw error;
  }

  if (!result.ok) return result;
  if (!recorded) return { ok: false, error: { code: "validation", message: "The refund could not be recorded." } };
  return { ok: true, refund: recorded, alreadyRecorded: false };
}

/* ------------------------------------------------------------------ */
/* Read: refunds recorded for a student (student page)                 */
/* ------------------------------------------------------------------ */

export interface StudentRefundRow extends CourseRefundRecord {
  courseName: string;
  batchName: string;
}

export type ListStudentRefundsResult = { ok: true; refunds: StudentRefundRow[] } | { ok: false; error: CourseRefundError };

export async function listStudentRefunds(actorContext: AuthContext, studentId: string): Promise<ListStudentRefundsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const { academyId, membershipRole } = access;
  if (getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION) === "none") {
    return { ok: false, error: { code: "forbidden", message: "You don't have access to student payments." } };
  }
  if (!z.string().uuid().safeParse(studentId).success) return { ok: true, refunds: [] };

  const conditions = [eq(studentCourseRefunds.academyId, academyId), eq(studentCourseRefunds.studentId, studentId)];
  if (BRANCH_LIMITED_ROLES.has(membershipRole)) {
    const assigned = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (assigned.length === 0) return { ok: true, refunds: [] };
    conditions.push(inArray(studentCourseRefunds.branchId, assigned));
  }
  const rows = await db
    .select({ refund: studentCourseRefunds, courseName: courses.name, batchName: batches.name })
    .from(studentCourseRefunds)
    .innerJoin(batchEnrollments, eq(batchEnrollments.id, studentCourseRefunds.enrollmentId))
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(courses, eq(courses.id, batchEnrollments.courseId))
    .where(and(...conditions))
    .orderBy(desc(studentCourseRefunds.refundedAt));
  if (rows.length === 0) return { ok: true, refunds: [] };
  const links = await db
    .select()
    .from(studentCourseRefundPayments)
    .where(inArray(studentCourseRefundPayments.refundId, rows.map((row) => row.refund.id)));
  return {
    ok: true,
    refunds: rows.map((row) => ({
      ...toRecord(row.refund),
      courseName: row.courseName,
      batchName: row.batchName,
      payments: links
        .filter((link) => link.refundId === row.refund.id)
        .map((link) => ({ studentPaymentId: link.studentPaymentId, amountCents: link.amountCents })),
    })),
  };
}

/**
 * How much has been refunded out of each of these payments (academy-scoped;
 * payments with no refund are absent). For payment lists: a refunded
 * payment stays "Posted" with its amount, and shows what was refunded from
 * it; it can no longer be reversed or adjusted (finance-reversals.ts).
 */
export async function getRefundedAmountsForPayments(academyId: string, paymentIds: string[]): Promise<Map<string, number>> {
  if (paymentIds.length === 0) return new Map();
  const rows = await db
    .select({
      paymentId: studentCourseRefundPayments.studentPaymentId,
      refundedCents: sql<number>`coalesce(sum(${studentCourseRefundPayments.amountCents}), 0)::int`,
    })
    .from(studentCourseRefundPayments)
    .innerJoin(studentCourseRefunds, eq(studentCourseRefundPayments.refundId, studentCourseRefunds.id))
    .where(and(eq(studentCourseRefunds.academyId, academyId), inArray(studentCourseRefundPayments.studentPaymentId, paymentIds)))
    .groupBy(studentCourseRefundPayments.studentPaymentId);
  return new Map(rows.map((row) => [row.paymentId, Number(row.refundedCents)]));
}
