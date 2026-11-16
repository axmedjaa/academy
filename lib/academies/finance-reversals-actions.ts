"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  adjustExpenseRecord as adjustExpenseRecordForActor,
  partiallyReverseIncomeRecord as partiallyReverseIncomeRecordForActor,
  partiallyReverseStudentPayment as partiallyReverseStudentPaymentForActor,
  reverseExpenseRecord as reverseExpenseRecordForActor,
  reverseIncomeRecord as reverseIncomeRecordForActor,
  reverseStudentPayment as reverseStudentPaymentForActor,
  type FinanceReversalError,
} from "@/lib/academies/finance-reversals";

/**
 * PLAN.md Phase 4, Item 54 — thin `"use server"` wrappers over
 * lib/academies/finance-reversals.ts, same convention as
 * lib/academies/expense-records-actions.ts's approve/reject actions.
 * Deliberately its own file, not an addition to
 * student-payments-actions.ts/income-records-actions.ts/
 * expense-records-actions.ts — this item's brief calls those three
 * "-actions.ts" files off-limits for edits (a concurrent agent may be
 * extending them for other items) and only asks for a matching actions
 * file for what this item itself creates.
 */
const UNAUTHENTICATED: FinanceReversalError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type FinanceReversalActionResult =
  | { ok: true }
  | { ok: false; error: FinanceReversalError };

/** Single confirm-and-fire button actions (target id + required reason,
 * no larger form) — same direct-call convention as
 * lib/academies/expense-records-actions.ts's `rejectExpenseAction`. */
export async function reverseStudentPaymentAction(
  studentPaymentId: string,
  reason: string,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await reverseStudentPaymentForActor(context, studentPaymentId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

/** Reverses part of a payment; the rest stays as a new approved payment. */
export async function partiallyReverseStudentPaymentAction(
  studentPaymentId: string,
  reason: string,
  reverseAmountCents: number,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await partiallyReverseStudentPaymentForActor(context, studentPaymentId, reason, reverseAmountCents);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

export async function reverseIncomeRecordAction(
  incomeRecordId: string,
  reason: string,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await reverseIncomeRecordForActor(context, incomeRecordId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

/** Reverses part of an income record; the rest stays as a new record. */
export async function partiallyReverseIncomeRecordAction(
  incomeRecordId: string,
  reason: string,
  reverseAmountCents: number,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await partiallyReverseIncomeRecordForActor(context, incomeRecordId, reason, reverseAmountCents);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export async function reverseExpenseRecordAction(
  expenseRecordId: string,
  reason: string,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await reverseExpenseRecordForActor(context, expenseRecordId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export async function adjustExpenseRecordAction(
  expenseRecordId: string,
  reason: string,
  correctedAmountCents: number,
): Promise<FinanceReversalActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await adjustExpenseRecordForActor(context, expenseRecordId, reason, correctedAmountCents);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}
