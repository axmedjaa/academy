import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { expenseRecords, incomeRecords, studentPayments } from "@/lib/db/schema";
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
 * reverseTransaction vs. adjustTransaction — judgment call
 * =========================================================================
 * PLAN.md never gives these separate schemas, separate statuses, or
 * separate described behaviors anywhere (no "adjusted" state exists in any
 * of the three status enums — only "reversed"), and DESIGN.md's
 * `/academy/finance` route table entry treats "Reversal/Adjustment" as one
 * combined UI affordance. Given that, and given the schema has exactly one
 * mechanism available (insert a linked row, flip the original to
 * "reversed"), this file treats them as the SAME underlying mechanism with
 * a different amount semantic:
 *
 *   - `reverseX(actor, id, reason)`      — the new row's amount is always
 *     an exact copy of the original's amount: a full, unconditional
 *     reversal ("this transaction should not have counted at all").
 *   - `adjustX(actor, id, reason, correctedAmountCents)` — the new row's
 *     amount is the caller-supplied corrected figure instead of a copy of
 *     the original ("this transaction should have been recorded as this
 *     other, correct amount"). The original is still flipped to
 *     `"reversed"` exactly as in a full reversal (no third status exists
 *     to express "partially corrected"), so from a reporting standpoint an
 *     adjustment is "reverse the wrong figure, then separately re-enter
 *     the corrected one as its own new linked-and-already-reversed record
 *     for audit purposes" — NOT a live re-approved replacement row, since
 *     minting a fresh `approved`/`posted` row here would silently bypass
 *     the same approval authority this item's own permission gate exists
 *     to enforce. A caller wanting a corrected figure to actually count
 *     again must separately record and re-approve a brand new transaction
 *     through the normal create/approve flow (Items 51/52/53) — this
 *     item's `adjustX` only fixes the audit trail's *record* of what the
 *     right amount should have been, it does not re-inject money into any
 *     report. This is a genuine judgment call: PLAN.md doesn't spell out
 *     the distinction, and a reasonable alternative reading would drop
 *     `adjustX` entirely as a no-op alias of `reverseX`. Kept separate
 *     (with `adjustX` internally delegating to the same helper as
 *     `reverseX`, just with a different amount argument) since the item's
 *     own brief explicitly asks for "adjustX variants if you determine
 *     they're meaningfully different."
 *
 * =========================================================================
 * Permission gating — reuses the exact "approve"-equivalent authority
 * =========================================================================
 * Per the Master Permission Matrix's "Reversal / adjustment" row: "Same
 * approval authority as the underlying transaction type; the recorder can
 * never approve their own." Concretely:
 *
 *   - `student_payments`: `ACADEMY_STUDENT_PAYMENTS_ACTION` level `"full"`
 *     only (Manager) — the same level `approveStudentPayment` (Item 52)
 *     requires. Finance Officer's `"manage"` level records/creates but
 *     does not approve, so it does not reverse either.
 *   - `expense_records`: `ACADEMY_EXPENSES_ACTION` level `"approve"` only
 *     (Academy Administrator or Manager) — the same level `approveExpense`
 *     requires.
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

const SELF_REVERSAL: FinanceReversalError = {
  code: "self_approval",
  message: "You cannot reverse or adjust a transaction you recorded yourself.",
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
  | { ok: true; academyId: string; membershipRole: AcademyRole }
  | { ok: false; error: FinanceReversalError }
> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  return { ok: true, academyId: access.academyId, membershipRole: access.membershipRole };
}

// ===========================================================================
// student_payments
// ===========================================================================

export interface StudentPaymentReversalResult {
  ok: true;
  original: typeof studentPayments.$inferSelect;
  reversal: typeof studentPayments.$inferSelect;
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
  message: "You don't have permission to reverse this academy's student payments.",
};
const PAYMENT_INVALID_STATE: FinanceReversalError = {
  code: "invalid_state",
  message: "Only an approved payment can be reversed.",
};

/** `approveStudentPayment` (Item 52)'s required level — Manager only. */
function canReversePayment(level: AcademyPermissionLevel): boolean {
  return level === "full";
}

async function reverseOrAdjustStudentPaymentInternal(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
  overrideAmountCents: number | undefined,
): Promise<ReverseStudentPaymentResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENT_PAYMENTS_ACTION);
  if (!canReversePayment(permissionLevel)) {
    return { ok: false, error: PAYMENT_FORBIDDEN };
  }

  const parsedId = idSchema.safeParse(studentPaymentId);
  if (!parsedId.success) return { ok: false, error: PAYMENT_NOT_FOUND };

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
      .from(studentPayments)
      .where(and(eq(studentPayments.id, studentPaymentId), eq(studentPayments.academyId, academyId)))
      .for("update");
    if (!original) return { kind: "not_found" as const };
    if (original.status !== "approved") return { kind: "invalid_state" as const };
    if (original.recordedBy === actorContext.userId) return { kind: "self_approval" as const };

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
        amountCents: overrideAmountCents ?? original.amountCents,
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

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: overrideAmountCents !== undefined ? "adjustStudentPayment" : "reverseStudentPayment",
        entityType: "student_payment",
        entityId: original.id,
        before: { status: original.status, amountCents: original.amountCents },
        after: { status: updatedOriginal.status, reversalRowId: reversal.id, amountCents: reversal.amountCents },
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

    return { kind: "ok" as const, original: updatedOriginal, reversal };
  });

  if (result.kind === "not_found") return { ok: false, error: PAYMENT_NOT_FOUND };
  if (result.kind === "invalid_state") return { ok: false, error: PAYMENT_INVALID_STATE };
  if (result.kind === "self_approval") return { ok: false, error: SELF_REVERSAL };
  return { ok: true, original: result.original, reversal: result.reversal };
}

/** Full reversal: the new linked row copies the original's amount exactly. */
export async function reverseStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
): Promise<ReverseStudentPaymentResult> {
  return reverseOrAdjustStudentPaymentInternal(actorContext, studentPaymentId, reason, undefined);
}

/** Adjustment: the new linked row records a corrected amount instead of a
 * copy of the original's — see this file's module comment for why the
 * original is still flipped to "reversed" either way. */
export async function adjustStudentPayment(
  actorContext: AuthContext,
  studentPaymentId: string,
  reason: string,
  correctedAmountCents: number,
): Promise<ReverseStudentPaymentResult> {
  return reverseOrAdjustStudentPaymentInternal(actorContext, studentPaymentId, reason, correctedAmountCents);
}

// ===========================================================================
// income_records
// ===========================================================================

export interface IncomeRecordReversalResult {
  ok: true;
  original: typeof incomeRecords.$inferSelect;
  reversal: typeof incomeRecords.$inferSelect;
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

/** No approve step exists for income at all — this item's brief: reuse the
 * same "manage" level that creates it (Manager or Finance Officer). */
function canReverseIncome(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

async function reverseOrAdjustIncomeRecordInternal(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
  overrideAmountCents: number | undefined,
): Promise<ReverseIncomeRecordResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_INCOME_ACTION);
  if (!canReverseIncome(permissionLevel)) {
    return { ok: false, error: INCOME_FORBIDDEN };
  }

  const parsedId = idSchema.safeParse(incomeRecordId);
  if (!parsedId.success) return { ok: false, error: INCOME_NOT_FOUND };

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
      .from(incomeRecords)
      .where(and(eq(incomeRecords.id, incomeRecordId), eq(incomeRecords.academyId, academyId)))
      .for("update");
    if (!original) return { kind: "not_found" as const };
    if (original.status !== "posted") return { kind: "invalid_state" as const };
    if (original.recordedBy === actorContext.userId) return { kind: "self_approval" as const };

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
        amountCents: overrideAmountCents ?? original.amountCents,
        currency: original.currency,
        recordedBy: actorContext.userId,
        status: "reversed",
        reversedRecordId: original.id,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: overrideAmountCents !== undefined ? "adjustIncomeRecord" : "reverseIncomeRecord",
        entityType: "income_record",
        entityId: original.id,
        before: { status: original.status, amountCents: original.amountCents },
        after: { status: updatedOriginal.status, reversalRowId: reversal.id, amountCents: reversal.amountCents },
        reason: parsedReason.value,
      },
      tx,
    );

    return { kind: "ok" as const, original: updatedOriginal, reversal };
  });

  if (result.kind === "not_found") return { ok: false, error: INCOME_NOT_FOUND };
  if (result.kind === "invalid_state") return { ok: false, error: INCOME_INVALID_STATE };
  if (result.kind === "self_approval") return { ok: false, error: SELF_REVERSAL };
  return { ok: true, original: result.original, reversal: result.reversal };
}

export async function reverseIncomeRecord(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
): Promise<ReverseIncomeRecordResult> {
  return reverseOrAdjustIncomeRecordInternal(actorContext, incomeRecordId, reason, undefined);
}

export async function adjustIncomeRecord(
  actorContext: AuthContext,
  incomeRecordId: string,
  reason: string,
  correctedAmountCents: number,
): Promise<ReverseIncomeRecordResult> {
  return reverseOrAdjustIncomeRecordInternal(actorContext, incomeRecordId, reason, correctedAmountCents);
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
  message: "You don't have permission to reverse this academy's expense records.",
};
const EXPENSE_INVALID_STATE: FinanceReversalError = {
  code: "invalid_state",
  message: "Only an approved expense can be reversed.",
};

/** `approveExpense`'s required level — Academy Administrator or Manager. */
function canReverseExpense(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

async function reverseOrAdjustExpenseRecordInternal(
  actorContext: AuthContext,
  expenseRecordId: string,
  reason: string,
  overrideAmountCents: number | undefined,
): Promise<ReverseExpenseRecordResult> {
  const membership = await resolveMembership(actorContext);
  if (!membership.ok) return membership;
  const { academyId, membershipRole } = membership;

  const permissionLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXPENSES_ACTION);
  if (!canReverseExpense(permissionLevel)) {
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
    if (!original) return { kind: "not_found" as const };
    if (original.status !== "approved") return { kind: "invalid_state" as const };
    if (original.submittedBy === actorContext.userId) return { kind: "self_approval" as const };

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
  if (result.kind === "self_approval") return { ok: false, error: SELF_REVERSAL };
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
