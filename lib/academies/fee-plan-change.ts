import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batches,
  enrollmentFeeSchedules,
  FEE_INTERVAL_MONTHS_OPTIONS,
  feePeriods,
  paymentAllocations,
  programEnrollments,
  studentPayments,
  type ScholarshipKind,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getBranchScope, inBranchScope } from "@/lib/academies/branch-access";
import { buildMonthlyInstallmentPeriods, resolveCurrency, todayDateOnlyInAcademyTimezone } from "@/lib/academies/fee-periods";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/ui/money";

/**
 * Change fee: the fee, discount or scholarship, and the number of monthly
 * payments of ONE active enrollment, after it was created. Works the same
 * for an individual course enrollment and a whole-program enrollment.
 *
 * Money already received is never touched:
 * - An installment that has a payment allocated to it (approved or waiting
 *   for approval) is KEPT. If it was only partly paid, its amount is
 *   lowered to what was paid, so the part not yet paid moves into the new
 *   plan instead of being charged twice.
 * - Every other installment (not paid at all, started or not) is removed
 *   and replaced by the new plan.
 * - The new plan is the new fee after discount, minus everything the kept
 *   installments already charge, split into the chosen number of monthly
 *   payments. It starts the month after the last kept installment, or at
 *   the old plan's start when nothing was paid yet.
 * - When more has been paid than the new fee, the change is refused (a
 *   refund is a separate, recorded step).
 * - A full scholarship (free) or a fee equal to what was paid leaves no
 *   plan: the schedule row is removed and nothing more is ever due.
 *
 * Payments, allocations and receipts are never changed. One audit entry
 * records the before and after.
 */

export type FeePlanTarget = { kind: "course"; enrollmentId: string } | { kind: "program"; programEnrollmentId: string };

export interface FeePlanChangeError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: FeePlanChangeError = { code: "forbidden", message: "You don't have permission to change fees." };
const NOT_FOUND: FeePlanChangeError = { code: "not_found", message: "Enrollment not found." };

const installmentsSchema = z.union(
  FEE_INTERVAL_MONTHS_OPTIONS.map((value) => z.literal(value)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  { message: "Choose 1, 2, 3, 4, 6 or 12 monthly payments." },
);

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("course"), enrollmentId: z.string().uuid() }),
  z.object({ kind: z.literal("program"), programEnrollmentId: z.string().uuid() }),
]);

export const changeFeePlanSchema = z
  .object({
    target: targetSchema,
    scholarship: z.enum(["none", "partial", "full"]),
    /** The fee before discount (ignored for a full scholarship). */
    feeCents: z.number().int("Enter the fee in whole cents.").nonnegative("The fee can't be negative.").default(0),
    discountCents: z.number().int("Enter the discount in whole cents.").nonnegative("The discount can't be negative.").default(0),
    /** Monthly payments for the part not yet paid. */
    installments: installmentsSchema,
  })
  .superRefine((data, ctx) => {
    if (data.scholarship === "full") return;
    if (data.feeCents <= 0) ctx.addIssue({ code: "custom", path: ["feeCents"], message: "Enter the fee." });
    else if (data.discountCents >= data.feeCents) {
      ctx.addIssue({
        code: "custom",
        path: ["discountCents"],
        message: data.scholarship === "partial" ? "The scholarship must be less than the fee. Choose Full scholarship for free." : "The discount must be less than the fee.",
      });
    } else if (data.scholarship === "partial" && data.discountCents <= 0) {
      ctx.addIssue({ code: "custom", path: ["discountCents"], message: "Enter the scholarship amount taken off the fee." });
    }
  });

export type ChangeFeePlanInput = z.input<typeof changeFeePlanSchema>;

/** What the Change fee dialog starts from. */
export interface FeePlanPosition {
  currency: string;
  scholarship: ScholarshipKind | null;
  /** Fee before discount, as it stands (installments + discount). */
  feeCents: number;
  discountCents: number;
  /** Monthly payments of the current plan (null when there is none). */
  installments: number | null;
  /** Received or waiting for approval: kept by any change. */
  paidCents: number;
}

type Access = { academyId: string; membershipRole: AcademyRole; userId: string; scope: Awaited<ReturnType<typeof getBranchScope>> };

async function resolveAccess(actorContext: AuthContext, manage: boolean): Promise<{ ok: true; access: Access } | { ok: false; error: FeePlanChangeError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION);
  if (level === "none" || (manage && level !== "full" && level !== "manage")) return { ok: false, error: FORBIDDEN };
  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      userId: actorContext.userId,
      scope: await getBranchScope(access, actorContext.userId),
    },
  };
}

interface Owner {
  id: string;
  studentId: string;
  branchId: string;
  status: "active" | "withdrawn" | "completed";
  scholarship: ScholarshipKind | null;
  /** A course of a program enrollment (never billed on its own). */
  programCourse: boolean;
}

async function loadOwner(executor: DbClient, access: Access, target: FeePlanTarget, lock: boolean): Promise<Owner | null> {
  if (target.kind === "course") {
    const query = executor
      .select({
        id: batchEnrollments.id,
        studentId: batchEnrollments.studentId,
        status: batchEnrollments.status,
        scholarship: batchEnrollments.scholarship,
        programEnrollmentId: batchEnrollments.programEnrollmentId,
        branchId: batches.branchId,
      })
      .from(batchEnrollments)
      .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
      .where(and(eq(batchEnrollments.id, target.enrollmentId), eq(batchEnrollments.academyId, access.academyId)))
      .limit(1);
    const [row] = lock ? await query.for("update", { of: batchEnrollments }) : await query;
    if (!row || !inBranchScope(access.scope, row.branchId)) return null;
    return { ...row, scholarship: row.scholarship ?? null, programCourse: Boolean(row.programEnrollmentId) };
  }
  const query = executor
    .select({
      id: programEnrollments.id,
      studentId: programEnrollments.studentId,
      status: programEnrollments.status,
      scholarship: programEnrollments.scholarship,
      branchId: batches.branchId,
    })
    .from(programEnrollments)
    .innerJoin(batches, eq(batches.id, programEnrollments.batchId))
    .where(and(eq(programEnrollments.id, target.programEnrollmentId), eq(programEnrollments.academyId, access.academyId)))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: programEnrollments }) : await query;
  if (!row || !inBranchScope(access.scope, row.branchId)) return null;
  return { ...row, scholarship: row.scholarship ?? null, programCourse: false };
}

const scheduleOwnerColumn = (target: FeePlanTarget) =>
  target.kind === "course" ? eq(enrollmentFeeSchedules.enrollmentId, target.enrollmentId) : eq(enrollmentFeeSchedules.programEnrollmentId, target.programEnrollmentId);
const periodOwnerColumn = (target: FeePlanTarget) =>
  target.kind === "course" ? eq(feePeriods.enrollmentId, target.enrollmentId) : eq(feePeriods.programEnrollmentId, target.programEnrollmentId);

/** The owner's schedule, its installments, and per installment what is
 * allocated to it: anything at all (it can't be deleted) and what counts as
 * paid (approved or waiting for approval). */
async function loadPlan(executor: DbClient, academyId: string, target: FeePlanTarget, lock: boolean) {
  const scheduleQuery = executor
    .select()
    .from(enrollmentFeeSchedules)
    .where(and(eq(enrollmentFeeSchedules.academyId, academyId), scheduleOwnerColumn(target)))
    .limit(1);
  const [schedule] = lock ? await scheduleQuery.for("update") : await scheduleQuery;
  const periods = await executor
    .select({
      id: feePeriods.id,
      periodStart: feePeriods.periodStart,
      periodEnd: feePeriods.periodEnd,
      expectedAmountCents: feePeriods.expectedAmountCents,
      currency: feePeriods.currency,
    })
    .from(feePeriods)
    .where(and(eq(feePeriods.academyId, academyId), periodOwnerColumn(target)));
  const allocations = periods.length
    ? await executor
        .select({
          feePeriodId: paymentAllocations.feePeriodId,
          paid: sql<number>`coalesce(sum(case when ${studentPayments.status} in ('approved', 'pending_approval') then ${paymentAllocations.amountCents} else 0 end), 0)::int`,
        })
        .from(paymentAllocations)
        .innerJoin(studentPayments, eq(studentPayments.id, paymentAllocations.studentPaymentId))
        .where(inArray(paymentAllocations.feePeriodId, periods.map((period) => period.id)))
        .groupBy(paymentAllocations.feePeriodId)
    : [];
  const paidByPeriod = new Map(allocations.map((row) => [row.feePeriodId, Number(row.paid)]));
  return { schedule: schedule ?? null, periods, paidByPeriod };
}

/** For the Change fee dialog: the fee as it stands and what was paid. */
export async function getFeePlanPosition(
  actorContext: AuthContext,
  target: FeePlanTarget,
): Promise<{ ok: true; position: FeePlanPosition } | { ok: false; error: FeePlanChangeError }> {
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  const resolved = await resolveAccess(actorContext, false);
  if (!resolved.ok) return resolved;
  const owner = await loadOwner(db, resolved.access, parsed.data, false);
  if (!owner || owner.programCourse) return { ok: false, error: NOT_FOUND };
  const plan = await loadPlan(db, resolved.access.academyId, parsed.data, false);
  const totalCents = plan.periods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
  const discountCents = plan.schedule?.discountCents ?? 0;
  return {
    ok: true,
    position: {
      currency: plan.schedule?.currency ?? plan.periods[0]?.currency ?? (await resolveCurrency(db, resolved.access.academyId, undefined)),
      scholarship: owner.scholarship,
      feeCents: totalCents + discountCents,
      discountCents,
      installments: plan.schedule?.intervalMonths ?? null,
      paidCents: plan.periods.reduce((sum, period) => sum + Math.min(plan.paidByPeriod.get(period.id) ?? 0, period.expectedAmountCents), 0),
    },
  };
}

export type ChangeFeePlanResult =
  | { ok: true; studentId: string; finalFeeCents: number; keptCents: number; plannedCents: number; installmentCents: number[] }
  | { ok: false; error: FeePlanChangeError };

class Refused extends Error {
  constructor(readonly error: FeePlanChangeError) {
    super(error.message);
  }
}

function dayAfter(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

export async function changeFeePlan(actorContext: AuthContext, input: ChangeFeePlanInput): Promise<ChangeFeePlanResult> {
  const resolved = await resolveAccess(actorContext, true);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  const parsed = changeFeePlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Check the fee." } };
  const data = parsed.data;
  const target = data.target;
  const free = data.scholarship === "full";
  const discountCents = free ? 0 : data.discountCents;
  const finalFeeCents = free ? 0 : data.feeCents - data.discountCents;
  const scholarship: ScholarshipKind | null = data.scholarship === "none" ? null : data.scholarship;

  try {
    return await db.transaction(async (tx) => {
      const owner = await loadOwner(tx, access, target, true);
      if (!owner) throw new Refused(NOT_FOUND);
      if (owner.programCourse) {
        throw new Refused({ code: "validation", message: "This course is part of a program. Change the fee on the program instead." });
      }
      if (owner.status !== "active") throw new Refused({ code: "validation", message: "Only an active enrollment's fee can change." });

      const { schedule, periods, paidByPeriod } = await loadPlan(tx, access.academyId, target, true);
      const allocatedIds = new Set(
        periods.length
          ? (
              await tx
                .select({ id: paymentAllocations.feePeriodId })
                .from(paymentAllocations)
                .where(inArray(paymentAllocations.feePeriodId, periods.map((period) => period.id)))
            ).map((row) => row.id)
          : [],
      );
      const kept = periods
        .filter((period) => allocatedIds.has(period.id))
        .map((period) => ({ ...period, keptCents: Math.min(period.expectedAmountCents, paidByPeriod.get(period.id) ?? 0) }));
      const keptCents = kept.reduce((sum, period) => sum + period.keptCents, 0);
      const currency = schedule?.currency ?? periods[0]?.currency ?? (await resolveCurrency(tx, access.academyId, undefined));
      const plannedCents = finalFeeCents - keptCents;
      if (plannedCents < 0) {
        throw new Refused({
          code: "conflict",
          message: `${formatMoney(keptCents, currency)} is already paid, which is more than the new fee of ${formatMoney(finalFeeCents, currency)}. Record a refund instead, or enter a higher fee.`,
        });
      }

      // Unpaid installments go; partly paid ones keep only what was paid.
      const removeIds = periods.filter((period) => !allocatedIds.has(period.id)).map((period) => period.id);
      if (removeIds.length > 0) await tx.delete(feePeriods).where(inArray(feePeriods.id, removeIds));
      for (const period of kept) {
        if (period.keptCents !== period.expectedAmountCents) {
          await tx.update(feePeriods).set({ expectedAmountCents: period.keptCents }).where(eq(feePeriods.id, period.id));
        }
      }

      let installmentCents: number[] = [];
      let anchorDate: string | null = null;
      if (plannedCents > 0) {
        const lastKeptEnd = kept.reduce<string | null>((latest, period) => (!latest || period.periodEnd > latest ? period.periodEnd : latest), null);
        anchorDate = lastKeptEnd ? dayAfter(lastKeptEnd) : (schedule?.anchorDate ?? todayDateOnlyInAcademyTimezone());
        const plan = buildMonthlyInstallmentPeriods(anchorDate, data.installments, plannedCents);
        installmentCents = plan.map((period) => period.expectedAmountCents);
        await tx.insert(feePeriods).values(
          plan.map((period) => ({
            academyId: access.academyId,
            ...(target.kind === "course" ? { enrollmentId: target.enrollmentId } : { programEnrollmentId: target.programEnrollmentId }),
            intervalMonths: data.installments,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            dueDate: period.dueDate,
            expectedAmountCents: period.expectedAmountCents,
            currency,
          })),
        );
        // The schedule describes the plan from its anchor on (the part not
        // already kept), so course period generation finds every
        // installment present and adds nothing.
        const values = {
          intervalMonths: data.installments,
          amountCents: plannedCents,
          discountCents,
          currency,
          anchorDate,
          updatedAt: new Date(),
        };
        if (schedule) {
          await tx.update(enrollmentFeeSchedules).set(values).where(eq(enrollmentFeeSchedules.id, schedule.id));
        } else {
          await tx.insert(enrollmentFeeSchedules).values({
            academyId: access.academyId,
            ...(target.kind === "course" ? { enrollmentId: target.enrollmentId } : { programEnrollmentId: target.programEnrollmentId }),
            ...values,
            createdBy: access.userId,
          });
        }
      } else if (schedule) {
        // Nothing left to plan (free, or already paid in full).
        await tx.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.id, schedule.id));
      }

      if (owner.scholarship !== scholarship) {
        if (target.kind === "course") {
          await tx.update(batchEnrollments).set({ scholarship }).where(eq(batchEnrollments.id, target.enrollmentId));
        } else {
          await tx.update(programEnrollments).set({ scholarship }).where(eq(programEnrollments.id, target.programEnrollmentId));
        }
      }

      const beforeTotal = periods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
      await recordAudit(
        {
          actorUserId: access.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          branchId: owner.branchId,
          action: "changeEnrollmentFee",
          entityType: target.kind === "course" ? "batch_enrollment" : "program_enrollment",
          entityId: owner.id,
          before: {
            scholarship: owner.scholarship,
            finalFeeCents: beforeTotal,
            discountCents: schedule?.discountCents ?? 0,
            installments: schedule?.intervalMonths ?? null,
            currency,
          },
          after: {
            scholarship,
            finalFeeCents,
            discountCents,
            installments: plannedCents > 0 ? data.installments : null,
            keptCents,
            plannedCents,
            anchorDate,
            currency,
          },
        },
        tx,
      );

      return { ok: true as const, studentId: owner.studentId, finalFeeCents, keptCents, plannedCents, installmentCents };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.error };
    throw error;
  }
}
