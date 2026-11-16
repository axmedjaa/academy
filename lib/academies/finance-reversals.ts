import { and, asc, eq } from "drizzle-orm";
import { getBranchScope, inBranchScope, isStudentInScope, type BranchScope } from "@/lib/academies/branch-access";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  bookSalePayments,
  expenseRecords,
  feePeriods,
  incomeRecords,
  paymentAllocations,
  studentCharges,
  studentCourseRefundPayments,
  studentPayments,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { recalculateStudentChargeStatus } from "@/lib/academies/student-payments";

/**
 * PLAN.md Phase 4, Item 54 — `reverseTransaction`/`adjustTransaction` for
 * `student_payments`, `income_records`, and `expense_records`, plus the
 * no-hard-delete guarantee those three entities' own Finance Lifecycle
 * table row ("Reversed/Voided" column) and §6's security note both require:
 * "no posted financial record is ever deleted under any code path... —
 * reversal only, original row untouched."
 *
 * =========================================================================
 * Design: what "untouched" and "new linked row" mean, exactly
 * =========================================================================
 * Each of the three self-FK columns this item's brief points at
 * (`studentPayments.reversedPaymentId`, `incomeRecords.reversedRecordId`,
 * `expenseRecords.reversedRecordId`) already carries its own schema.ts
 * comment from the Item 51/53 wave that declared them, e.g.
 * studentPayments's: "Item 52/54's reversal action populates this on the
 * NEW row it creates — the original approved row is left untouched." That
 * sentence resolves the exact row semantics PLAN.md's own schema line
 * otherwise leaves terse:
 *
 *   - The ORIGINAL row is updated in place to `status: "reversed"` and
 *     nothing else — no amount change, no self-FK populated on it, no
 *     other column touched. This is what "original untouched" means: the
 *     financial facts it recorded (who, when, how much) are never
 *     mutated or deleted, only its lifecycle status advances exactly the
 *     way every other status transition in this codebase already works
 *     (e.g. `approved -> rejected` doesn't delete the row either). This
 *     matches the Finance Lifecycle table's own phrasing for these three
 *     entities: "reversed **from** approved/posted", i.e. a transition
 *     the original row itself undergoes, not an unrelated side effect.
 *   - A brand NEW row is inserted, carrying the *self-FK back to the
 *     original* (`reversedPaymentId`/`reversedRecordId` = original.id)
 *     plus a copy of the original's core financial fields (student/
 *     academy/branch/category/amount/currency/etc.), and its own
 *     `status` is set to `"reversed"` directly — never `"approved"`/
 *     `"posted"`, which would double-count the amount in any report that
 *     sums by status. Every table's `amount_cents >= 0` CHECK constraint
 *     also forecloses the "insert a negative-amount offsetting row"
 *     design outright — Postgres would reject it — so a same-status,
 *     same-sign linked row is the only mechanic the schema actually
 *     allows. Net effect on any status-based report: the original's
 *     amount stops counting (it's no longer `approved`/`posted`) and the
 *     new row never counts either (it's born `reversed`) — the reversal
 *     nets to zero without ever needing a negative or deleted row.
 *   - The reversal reason is recorded on the NEW row for `student_payments`
 *     (which has a real `reversal_reason` column — populated on the new
 *     row, mirroring where its `reversed_payment_id` FK also lives, since
 *     both describe *this row's own act of reversing something else*).
 *     `income_records`/`expense_records` have no dedicated reversal-reason
 *     column at all (only `expense_records.rejection_reason`, a distinct
 *     concept for a distinct transition) — for those two, the reason is
 *     captured in the new row's own `description` field (prefixed, so it
 *     stays human-legible) AND, for all three entities, in the audit log's
 *     `reason` field (`lib/audit.ts`'s `RecordAuditInput.reason`), which
 *     exists precisely for this and is never lost regardless of schema.
 *     This is a deviation from "no schema change" only in the sense of
 *     "no new column" — no schema.ts edit was made or needed.
 *
 * =========================================================================
 * Full reversal vs. partial reversal (and the expense-only adjust)
 * =========================================================================
 * Every correction uses the one mechanism the schema has: flip the original
 * to "reversed" and insert a linked row (born "reversed", so it never
 * counts). A record never changes amount.
 *
 *   - `reverseX(actor, id, reason)`: the linked row copies the original's
 *     amount. Nothing of the original counts any more.
 *   - `partiallyReverseStudentPayment` / `partiallyReverseIncomeRecord`
 *     (actor, id, reason, reverseAmountCents): the linked row carries only
 *     the reversed part, and a NEW approved payment / posted income record
 *     for the remainder is written in the same transaction (same student,
 *     charge, method, reference, date and recorder; a payment also keeps
 *     its fee-period allocations up to the remainder). Totals fall by
 *     exactly the reversed part, and the remainder can be partly reversed
 *     again. This replaced the old "adjust to a corrected amount", whose
 *     corrected row was itself born reversed — it silently removed the
 *     whole payment from every total (production: a $4 payment "adjusted"
 *     with $1 dropped all $4).
 *   - `adjustExpenseRecord` keeps the old adjust model for now: the
 *     corrected expense row is recorded for the audit trail only.
 *
 * =========================================================================
 * Permission gating — reuses the exact "approve"-equivalent authority
 * =========================================================================
 * Per the Master Permission Matrix's "Reversal / adjustment" row: "Same
 * approval authority as the underlying transaction type; the recorder can
 * never approve their own." Concretely:
 *
 *   - `student_payments`: any payment — `ACADEMY_STUDENT_PAYMENTS_ACTION`
 *     level `"full"` (Manager). A payment the actor recorded THEMSELVES —
 *     any level that can record one (`"full"` or `"manage"`: Manager,
 *     Finance Officer, Academy Administrator). Revised at the academy's
 *     request: whoever recorded a payment can correct it; see below.
 *   - `expense_records`: any expense — `ACADEMY_EXPENSES_ACTION` level
 *     `"approve"` (Academy Administrator or Manager), the level
 *     `approveExpense` requires. An expense the actor submitted THEMSELVES
 *     — any level that can submit one (`"manage"` or `"approve"`).
 *   - `income_records`: no approval step exists anywhere for this entity
 *     (`ACADEMY_INCOME_ACTION` has no `"approve"` level at all — see that
 *     row's own comment in academy-permissions.ts), so per this item's
 *     brief this file reuses the same authority that *creates* income,
 *     `ACADEMY_INCOME_ACTION` level `"manage"` (Manager or Finance
 *     Officer — the Wave 2 fix that corrected Manager from "view" to
 *     "manage" is load-bearing here; re-read live, not from memory).
 *
 * =========================================================================
 * Self-reversal rule — read as extending self-approval, not just approval
 * =========================================================================
 * The Master Permission Matrix's sentence above ("the recorder can never
 * approve their own") is quoted directly under the "Reversal / adjustment"
 * row itself (not merely inherited from the plain approval row), so this
 * file reads it as restating the self-approval prohibition specifically
 * for reversal/adjustment too: the person who *recorded* the original
 * transaction (`recordedBy` for student_payments/income_records,
 * `submittedBy` for expense_records) may never be the one who reverses or
 * adjusts it, even if their role otherwise holds the required approval
 * authority (e.g. a Manager who personally recorded a payment cannot also
 * reverse it). This is enforced explicitly in each function below (there
 * is no `approval_requests` row for a direct reversal to route through and
 * inherit `decideApprovalRequest`'s guard from, unlike `approveExpense`),
 * using the same `"self_approval"` error code as
 * `decideApprovalRequest`/`approveExpense`/`rejectExpense` for a
 * consistent error surface across the codebase. A reasonable alternative
 * reading would confine "the recorder can never approve their own" to the
 * plain approval transition only and leave reversal unrestricted; this
 * file takes the stricter reading since the sentence appears directly on
 * the reversal row and a self-serviced reversal is the more dangerous
 * direction to leave open.
 *
 * SUPERSEDED at the academy's explicit request: for student payments,
 * income and expenses alike, the person who recorded (or submitted) a
 * record MAY reverse or adjust it. Authority over OTHER people's records
 * is unchanged (payments: Manager; expenses: Administrator or Manager;
 * income: Manager or Finance Officer). Every correction still keeps the
 * original row, adds the linked reversal row, requires a reason and writes
 * the audit entry naming who did it. `SELF_REVERSAL` / "self_approval" is
 * no longer returned by this file.
 *
 * =========================================================================
 * Row locking / concurrency
 * =========================================================================
 * Same `SELECT ... FOR UPDATE` + single `db.transaction` shape as
 * `issueReceipt` (lib/academies/student-payments.ts): the target row is
 * locked before its status is checked, so two concurrent reversal attempts
 * on the same row can't both observe `"approved"`/`"posted"` and both
 * insert a linked row — the second transaction blocks on the lock, then
 * (after the first commits) re-reads `"reversed"` and is refused with
 * `invalid_state`.
 *
 * =========================================================================
 * Confirmed Phase 4 post-implementation audit gap fix — charge-status
 * recalculation on payment reversal/adjustment
 * =========================================================================
 * `approveStudentPayment` (lib/academies/student-payments.ts) recalculates
 * a charge-linked payment's `student_charges.status` inside its own
 * transaction, but until this fix, reversing or adjusting that same
 * payment never re-triggered that recalculation — the charge could keep
 * reading `"paid"`/`"partially_paid"` after the payment funding that status
 * was reversed. `reverseOrAdjustStudentPaymentInternal` below now calls the
 * SAME exported `recalculateStudentChargeStatus` helper (reused, not
 * duplicated) whenever the reversed/adjusted payment has a `chargeId`,
 * inside the same transaction as the reversal itself — exactly mirroring
 * how `approveStudentPayment` already calls it. Only `student_payments` has
 * a linked-charge concept; `income_records`/`expense_records` have no
 * analogous derived-status entity, so neither of their reversal paths needs
 * an equivalent call.
 */

export interface FinanceReversalError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "invalid_state" | "self_approval";
  message: string;
}

const REASON_REQUIRED: FinanceReversalError = {
  code: "validation",
  message: "A reason is required.",
};

const reasonSchema = z.string().trim().min(1, "A reason is required.").max(2000);
const idSchema = z.string().uuid();

function parseReason(reason: string): { ok: true; value: string } | { ok: false } {
  const parsed = reasonSchema.safeParse(reason);
  if (!parsed.success) return { ok: false };
  return { ok: true, value: parsed.data };
}

/** Shared access resolution: blocked-membership check only. Each
 * function below applies its own entity-specific permission-level gate
 * on top, since the three entities check three different permission rows
 * at three different required levels (this mirrors resolveExpenseAccess/
 * resolveIncomeAccess/resolveStudentPaymentsAccess's own shape, just
 * generic across the three since this file spans all of them). */
async function resolveMembership(
  actorContext: AuthContext,
): Promise<
  | { ok: true; academyId: string; membershipRole: AcademyRole; scope: BranchScope }
  | { ok: false; error: FinanceReversalError }
> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  // Multi-branch: a record outside the caller's branches is treated as
  // missing (lib/academies/branch-access.ts).
  return {
    ok: true,
    academyId: access.academyId,
    membershipRole: access.membershipRole,
    scope: await getBranchScope(access, actorContext.userId),
  };
}

// ===========================================================================
// student_payments
// ===========================================================================

export interface StudentPaymentReversalResult {
  ok: true;
  original: typeof studentPayments.$inferSelect;
  reversal: typeof studentPayments.$inferSelect;
  /** Partial reversal only: the new approved payment for what remains. */
  remainder: typeof studentPayments.$inferSelect | null;
}
export type ReverseStudentPaymentResult =
  | StudentPaymentReversalResult
  | { ok: false; error: FinanceReversalError };

const PAYMENT_NOT_FOUND: FinanceReversalError = {
  code: "not_found",
  message: "Payment not found.",
};
const PAYMENT_FORBIDDEN: FinanceReversalError = {
  code: "forbidden",
  message: "You can reverse or adjust only payments you recorded yourself. Ask a Manager to correct someone else's payment.",
};
const PAYMENT_INVALID_STATE: FinanceReversalError = {
  code: "invalid_state",
  message: "Only an approved payment can be reversed.",
};

/** Reversing or adjusting ANY student payment — Manager ("full") only. */
function canReversePayment(level: AcademyPermissionLevel): boolean {
  return level === "full";
}

/** Reversing or adjusting a student payment the actor recorded THEMSELVES:
 * any role allowed to record payments ("full" or "manage": Manager,
 * Finance Officer, Academy Administrator). The person who recorded a
 * payment can correct it; anyone else's payment still needs a Manager. */
function canCorrectOwnPayment(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/** Partial-reversal amount check shared by payments and income: a whole,
 * positive number of cents. "Less than the original" is checked on the
 * locked row inside each transaction. */
function parsePartialAmount(amountCents: number | undefined): { ok: true } | { ok: false; error: FinanceReversalError } {
  if (amountCents === undefined) return { ok: true };
  const parsed = z.number().int().positive().safeParse(amountCents);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: "Enter the amount to reverse, more than zero." } };
  }
  return { ok: true };
}

function partialTooLarge(originalCents: number): FinanceReversalError {
  return {
    code: "validation",
    message: `The amount to reverse must be less than the original ${(originalCents / 100).toFixed(2)}. To reverse all of it, use Reverse in full.`,
  };
}

/**
 * Splits `remainingCents` over a reversed payment's fee-period allocations,
 * oldest period first, each up to what the original put on it. The
 * remainder therefore keeps paying the same installments it paid before,
 * minus the reversed part taken from the latest ones.
 */
function remainderAllocations(
  originals: { feePeriodId: string; amountCents: number }[],
  remainingCents: number,
): { feePeriodId: string; amountCents: number }[] {
  const result: { feePeriodId: string; amountCents: number }[] = [];
  let left = remainingCents;
  for (const allocation of originals) {
    if (left <= 0) break;
    const amountCents = Math.min(left, allocation.amountCents);
    result.push({ feePeriodId: allocation.feePeriodId, amountCents });
    left -= amountCents;
  }
  return result;
}

/**
 * Full or partial reversal of a student payment.
 *
 * Full (`partialCents` undefined): the original flips to "reversed" and a
 * linked reversal row of the same amount is added. Nothing of it counts.
 *
 * Partial (`partialCents` = the part to reverse, 0 < part < amount): the
 * original still flips to "reversed" (one record never changes amount), the
 * linked reversal row carries the reversed part, and a NEW approved payment
 * for the remainder is posted in the same transaction — same student,
 * charge, method, reference, received date and recorder, with the
 * original's fee-period allocations carried over up to the remainder. So
 * every total (which counts approved payments only) falls by exactly the
 * reversed part, and the remainder can itself be partly reversed later.
 */
async function reverseOrAdjustStudentPaymentInternal(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
  partialCents: number | undefined,
): Promise<ReverseStudentPaymentResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole, scope } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION);
  if (!canCorrectOwnPayment(permissionLevel)) {
    return { ok: false, error: PAYMENT_FORBIDDEN };
  }

  const parsedId = idSchema.safeParse(studentPaymentId);
  if (!parsedId.success) return { ok: false, error: PAYMENT_NOT_FOUND };

  const parsedReason = parseReason(reason);
  if (!parsedReason.ok) return { ok: false, error: REASON_REQUIRED };

  const amountCheck = parsePartialAmount(partialCents);
  if (!amountCheck.ok) return amountCheck;

  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(studentPayments)
      .where(and(eq(studentPayments.id, studentPaymentId), eq(studentPayments.academyId, academyId)))
      .for("update");
    if (!original || !(await isStudentInScope(scope, academyId, original.studentId, tx))) return { kind: "not_found" as const };
    if (original.status !== "approved") return { kind: "invalid_state" as const };
    // Checked on the locked row: a Manager may correct any payment; other
    // recording roles only a payment they recorded themselves.
    if (!canReversePayment(permissionLevel) && original.recordedBy !== actorContext.userId) {
      return { kind: "forbidden" as const };
    }
    // A refund was recorded out of this payment (migration 0036): reversing
    // or adjusting it now would leave more refunded than was paid. The
    // payment row is locked, and the refund path locks it too, so this
    // can't race a refund being recorded.
    const [refundLink] = await tx
      .select({ id: studentCourseRefundPayments.id })
      .from(studentCourseRefundPayments)
      .where(eq(studentCourseRefundPayments.studentPaymentId, original.id))
      .limit(1);
    if (refundLink) return { kind: "refunded" as const };
    if (partialCents !== undefined && partialCents >= original.amountCents) {
      return { kind: "too_large" as const, originalCents: original.amountCents };
    }
    // Lock the linked charge before inserting the reversal row (whose FK
    // takes a key-share lock on it) — same deadlock-avoidance order as
    // recordStudentPayment: two corrections on one charge queue on this
    // lock instead of each holding key-share and waiting for FOR UPDATE.
    if (original.chargeId) {
      await tx.select({ id: studentCharges.id }).from(studentCharges).where(eq(studentCharges.id, original.chargeId)).for("update");
    }

    const [updatedOriginal] = await tx
      .update(studentPayments)
      .set({ status: "reversed" })
      .where(eq(studentPayments.id, studentPaymentId))
      .returning();

    const [reversal] = await tx
      .insert(studentPayments)
      .values({
        academyId,
        studentId: original.studentId,
        chargeId: original.chargeId,
        amountCents: partialCents ?? original.amountCents,
        currency: original.currency,
        method: original.method,
        reference: original.reference
          ? `Reversal of ${original.reference}`
          : `Reversal of payment ${original.id}`,
        receivedAt: new Date(),
        recordedBy: actorContext.userId,
        status: "reversed",
        approvedBy: actorContext.userId,
        approvedAt: new Date(),
        reversedPaymentId: original.id,
        reversalReason: parsedReason.value,
      })
      .returning();

    let remainder: typeof studentPayments.$inferSelect | null = null;
    if (partialCents !== undefined) {
      const remainingCents = original.amountCents - partialCents;
      [remainder] = await tx
        .insert(studentPayments)
        .values({
          academyId,
          studentId: original.studentId,
          chargeId: original.chargeId,
          amountCents: remainingCents,
          currency: original.currency,
          method: original.method,
          reference: original.reference,
          notes: original.notes,
          // Kept on the original's date and recorder: the remainder is the
          // same money received that day, not a new receipt of cash.
          receivedAt: original.receivedAt,
          recordedBy: original.recordedBy,
          status: "approved",
          approvedBy: actorContext.userId,
          approvedAt: new Date(),
        })
        .returning();

      const originalAllocations = await tx
        .select({ feePeriodId: paymentAllocations.feePeriodId, amountCents: paymentAllocations.amountCents })
        .from(paymentAllocations)
        .innerJoin(feePeriods, eq(feePeriods.id, paymentAllocations.feePeriodId))
        .where(eq(paymentAllocations.studentPaymentId, original.id))
        .orderBy(asc(feePeriods.periodStart), asc(feePeriods.dueDate));
      const carried = remainderAllocations(originalAllocations, remainingCents);
      if (carried.length > 0) {
        await tx.insert(paymentAllocations).values(
          carried.map((allocation) => ({ academyId, studentPaymentId: remainder!.id, ...allocation })),
        );
      }
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: partialCents !== undefined ? "partiallyReverseStudentPayment" : "reverseStudentPayment",
        entityType: "student_payment",
        entityId: original.id,
        before: { status: original.status, amountCents: original.amountCents },
        after: {
          status: updatedOriginal.status,
          reversalRowId: reversal.id,
          reversedAmountCents: reversal.amountCents,
          ...(remainder ? { remainderPaymentId: remainder.id, remainderAmountCents: remainder.amountCents } : {}),
        },
        reason: parsedReason.value,
      },
      tx,
    );

    // Confirmed Phase 4 audit gap fix — see this file's module comment.
    // The reversed/adjusted payment no longer counts as "approved," so the
    // linked charge (if any) must be re-derived in the same transaction,
    // exactly as approveStudentPayment already does on the opposite
    // transition.
    if (original.chargeId) {
      await recalculateStudentChargeStatus(tx, original.chargeId, actorContext.userId, membershipRole);
    }

    return { kind: "ok" as const, original: updatedOriginal, reversal, remainder };
  });

  if (result.kind === "not_found") return { ok: false, error: PAYMENT_NOT_FOUND };
  if (result.kind === "invalid_state") return { ok: false, error: PAYMENT_INVALID_STATE };
  if (result.kind === "forbidden") return { ok: false, error: PAYMENT_FORBIDDEN };
  if (result.kind === "too_large") return { ok: false, error: partialTooLarge(result.originalCents) };
  if (result.kind === "refunded") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: "A refund has been recorded out of this payment, so it can no longer be reversed or adjusted.",
      },
    };
  }
  return { ok: true, original: result.original, reversal: result.reversal, remainder: result.remainder };
}

/** Full reversal: the new linked row copies the original's amount exactly. */
export async function reverseStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
): Promise<ReverseStudentPaymentResult> {
  return reverseOrAdjustStudentPaymentInternal(actorContext, studentPaymentId, reason, undefined);
}

/** Partial reversal: reverses `reverseAmountCents` of the payment (more
 * than zero, less than the payment) and posts the rest as a new approved
 * payment — see `reverseOrAdjustStudentPaymentInternal`. */
export async function partiallyReverseStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
  reverseAmountCents: number,
): Promise<ReverseStudentPaymentResult> {
  return reverseOrAdjustStudentPaymentInternal(actorContext, studentPaymentId, reason, reverseAmountCents);
}

// ===========================================================================
// income_records
// ===========================================================================

export interface IncomeRecordReversalResult {
  ok: true;
  original: typeof incomeRecords.$inferSelect;
  reversal: typeof incomeRecords.$inferSelect;
  /** Partial reversal only: the new posted record for what remains. */
  remainder: typeof incomeRecords.$inferSelect | null;
}
export type ReverseIncomeRecordResult =
  | IncomeRecordReversalResult
  | { ok: false; error: FinanceReversalError };

const INCOME_NOT_FOUND: FinanceReversalError = { code: "not_found", message: "Income record not found." };
const INCOME_FORBIDDEN: FinanceReversalError = {
  code: "forbidden",
  message: "You don't have permission to reverse this academy's income records.",
};
const INCOME_INVALID_STATE: FinanceReversalError = {
  code: "invalid_state",
  message: "Only a posted income record can be reversed.",
};
const INCOME_FROM_BOOK_SALE: FinanceReversalError = {
  code: "invalid_state",
  message:
    "This income came from a book sale. Record a refund on the sale in Books instead, so the receipt, stock and income stay in step.",
};

/** No approve step exists for income at all — this item's brief: reuse the
 * same "manage" level that creates it (Manager or Finance Officer). */
function canReverseIncome(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

/** Full or partial reversal of an income record — the same model as
 * `reverseOrAdjustStudentPaymentInternal`: a partial reversal reverses the
 * original, records the reversed part on the linked reversal row, and posts
 * the remainder as a new record dated like the original. */
async function reverseOrAdjustIncomeRecordInternal(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
  partialCents: number | undefined,
): Promise<ReverseIncomeRecordResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole, scope } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_INCOME_ACTION);
  if (!canReverseIncome(permissionLevel)) {
    return { ok: false, error: INCOME_FORBIDDEN };
  }

  const parsedId = idSchema.safeParse(incomeRecordId);
  if (!parsedId.success) return { ok: false, error: INCOME_NOT_FOUND };

  const parsedReason = parseReason(reason);
  if (!parsedReason.ok) return { ok: false, error: REASON_REQUIRED };

  const amountCheck = parsePartialAmount(partialCents);
  if (!amountCheck.ok) return amountCheck;

  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(incomeRecords)
      .where(and(eq(incomeRecords.id, incomeRecordId), eq(incomeRecords.academyId, academyId)))
      .for("update");
    if (!original || !inBranchScope(scope, original.branchId)) return { kind: "not_found" as const };
    if (original.status !== "posted") return { kind: "invalid_state" as const };

    // Book-sale income is corrected through refundBookSale (lib/academies/
    // book-sales.ts), which also updates the sale's paid/refunded amounts,
    // its receipt and stock. Reversing it here would leave the sale saying
    // "paid" while Finance said otherwise.
    const [bookSaleLink] = await tx
      .select({ id: bookSalePayments.id })
      .from(bookSalePayments)
      .where(eq(bookSalePayments.incomeRecordId, original.id))
      .limit(1);
    if (bookSaleLink) return { kind: "book_sale" as const };
    if (partialCents !== undefined && partialCents >= original.amountCents) {
      return { kind: "too_large" as const, originalCents: original.amountCents };
    }

    const [updatedOriginal] = await tx
      .update(incomeRecords)
      .set({ status: "reversed" })
      .where(eq(incomeRecords.id, incomeRecordId))
      .returning();

    // income_records has no dedicated reversal-reason column (unlike
    // student_payments) — the reason is embedded in the new row's own
    // description (in addition to always being recorded in the audit log
    // below, which is never schema-limited).
    const reversalDescription = original.description
      ? `Reversal of "${original.description}": ${parsedReason.value}`
      : `Reversal of income record ${original.id}: ${parsedReason.value}`;

    const [reversal] = await tx
      .insert(incomeRecords)
      .values({
        academyId,
        branchId: original.branchId,
        category: original.category,
        description: reversalDescription,
        amountCents: partialCents ?? original.amountCents,
        currency: original.currency,
        recordedBy: actorContext.userId,
        status: "reversed",
        reversedRecordId: original.id,
      })
      .returning();

    let remainder: typeof incomeRecords.$inferSelect | null = null;
    if (partialCents !== undefined) {
      [remainder] = await tx
        .insert(incomeRecords)
        .values({
          academyId,
          branchId: original.branchId,
          category: original.category,
          description: original.description,
          amountCents: original.amountCents - partialCents,
          currency: original.currency,
          recordedBy: original.recordedBy,
          status: "posted",
          // Reports count income by created_at: the remainder stays in the
          // original's period instead of moving to today.
          createdAt: original.createdAt,
        })
        .returning();
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: partialCents !== undefined ? "partiallyReverseIncomeRecord" : "reverseIncomeRecord",
        entityType: "income_record",
        entityId: original.id,
        before: { status: original.status, amountCents: original.amountCents },
        after: {
          status: updatedOriginal.status,
          reversalRowId: reversal.id,
          reversedAmountCents: reversal.amountCents,
          ...(remainder ? { remainderRecordId: remainder.id, remainderAmountCents: remainder.amountCents } : {}),
        },
        reason: parsedReason.value,
      },
      tx,
    );

    return { kind: "ok" as const, original: updatedOriginal, reversal, remainder };
  });

  if (result.kind === "not_found") return { ok: false, error: INCOME_NOT_FOUND };
  if (result.kind === "invalid_state") return { ok: false, error: INCOME_INVALID_STATE };
  if (result.kind === "book_sale") return { ok: false, error: INCOME_FROM_BOOK_SALE };
  if (result.kind === "too_large") return { ok: false, error: partialTooLarge(result.originalCents) };
  return { ok: true, original: result.original, reversal: result.reversal, remainder: result.remainder };
}

export async function reverseIncomeRecord(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
): Promise<ReverseIncomeRecordResult> {
  return reverseOrAdjustIncomeRecordInternal(actorContext, incomeRecordId, reason, undefined);
}

/** Partial reversal: reverses `reverseAmountCents` of the record (more
 * than zero, less than the record) and posts the rest as a new record. */
export async function partiallyReverseIncomeRecord(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
  reverseAmountCents: number,
): Promise<ReverseIncomeRecordResult> {
  return reverseOrAdjustIncomeRecordInternal(actorContext, incomeRecordId, reason, reverseAmountCents);
}

// ===========================================================================
// expense_records
// ===========================================================================

export interface ExpenseRecordReversalResult {
  ok: true;
  original: typeof expenseRecords.$inferSelect;
  reversal: typeof expenseRecords.$inferSelect;
}
export type ReverseExpenseRecordResult =
  | ExpenseRecordReversalResult
  | { ok: false; error: FinanceReversalError };

const EXPENSE_NOT_FOUND: FinanceReversalError = { code: "not_found", message: "Expense record not found." };
const EXPENSE_FORBIDDEN: FinanceReversalError = {
  code: "forbidden",
  message: "You can reverse or adjust only expenses you submitted yourself. Ask a Manager or Academy Administrator to correct someone else's expense.",
};
const EXPENSE_INVALID_STATE: FinanceReversalError = {
  code: "invalid_state",
  message: "Only an approved expense can be reversed.",
};

/** `approveExpense`'s required level — Academy Administrator or Manager. */
/** Reversing or adjusting ANY approved expense — "approve" (Academy
 * Administrator, Manager), the same authority that approves expenses. */
function canReverseExpense(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

/** Reversing or adjusting an expense the actor SUBMITTED themselves — any
 * level that can submit one ("manage" or "approve"), as expense-records.ts
 * `canCreate`. */
function canCorrectOwnExpense(level: AcademyPermissionLevel): boolean {
  return level === "manage" || level === "approve";
}

async function reverseOrAdjustExpenseRecordInternal(
  actorContext: AuthContext,
  expenseRecordId: string,
  reason: string,
  overrideAmountCents: number | undefined,
): Promise<ReverseExpenseRecordResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole, scope } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXPENSES_ACTION);
  if (!canCorrectOwnExpense(permissionLevel)) {
    return { ok: false, error: EXPENSE_FORBIDDEN };
  }

  const parsedId = idSchema.safeParse(expenseRecordId);
  if (!parsedId.success) return { ok: false, error: EXPENSE_NOT_FOUND };

  const parsedReason = parseReason(reason);
  if (!parsedReason.ok) return { ok: false, error: REASON_REQUIRED };

  if (overrideAmountCents !== undefined) {
    const parsedAmount = z.number().int().nonnegative().safeParse(overrideAmountCents);
    if (!parsedAmount.success) {
      return {
        ok: false,
        error: { code: "validation", message: "Adjusted amount must be a nonnegative whole number of cents." },
      };
    }
  }

  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(expenseRecords)
      .where(and(eq(expenseRecords.id, expenseRecordId), eq(expenseRecords.academyId, academyId)))
      .for("update");
    if (!original || !inBranchScope(scope, original.branchId)) return { kind: "not_found" as const };
    if (original.status !== "approved") return { kind: "invalid_state" as const };
    // Checked on the locked row: approvers may correct any expense; other
    // submitting roles only an expense they submitted themselves.
    if (!canReverseExpense(permissionLevel) && original.submittedBy !== actorContext.userId) {
      return { kind: "forbidden" as const };
    }

    const [updatedOriginal] = await tx
      .update(expenseRecords)
      .set({ status: "reversed", updatedAt: new Date() })
      .where(eq(expenseRecords.id, expenseRecordId))
      .returning();

    // expense_records has no dedicated reversal-reason column either
    // (rejection_reason is a distinct concept for a distinct transition)
    // — same description-embedding convention as income_records above.
    const reversalDescription = original.description
      ? `Reversal of "${original.description}": ${parsedReason.value}`
      : `Reversal of expense record ${original.id}: ${parsedReason.value}`;

    const [reversal] = await tx
      .insert(expenseRecords)
      .values({
        academyId,
        branchId: original.branchId,
        category: original.category,
        description: reversalDescription,
        amountCents: overrideAmountCents ?? original.amountCents,
        currency: original.currency,
        submittedBy: actorContext.userId,
        status: "reversed",
        approvedBy: actorContext.userId,
        approvedAt: new Date(),
        reversedRecordId: original.id,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: overrideAmountCents !== undefined ? "adjustExpenseRecord" : "reverseExpenseRecord",
        entityType: "expense_record",
        entityId: original.id,
        before: { status: original.status, amountCents: original.amountCents },
        after: { status: updatedOriginal.status, reversalRowId: reversal.id, amountCents: reversal.amountCents },
        reason: parsedReason.value,
      },
      tx,
    );

    return { kind: "ok" as const, original: updatedOriginal, reversal };
  });

  if (result.kind === "not_found") return { ok: false, error: EXPENSE_NOT_FOUND };
  if (result.kind === "invalid_state") return { ok: false, error: EXPENSE_INVALID_STATE };
  if (result.kind === "forbidden") return { ok: false, error: EXPENSE_FORBIDDEN };
  return { ok: true, original: result.original, reversal: result.reversal };
}

export async function reverseExpenseRecord(
  actorContext: AuthContext,
  expenseRecordId: string,
  reason: string,
): Promise<ReverseExpenseRecordResult> {
  return reverseOrAdjustExpenseRecordInternal(actorContext, expenseRecordId, reason, undefined);
}

export async function adjustExpenseRecord(
  actorContext: AuthContext,
  expenseRecordId: string,
  reason: string,
  correctedAmountCents: number,
): Promise<ReverseExpenseRecordResult> {
  return reverseOrAdjustExpenseRecordInternal(actorContext, expenseRecordId, reason, correctedAmountCents);
}
