"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  approveExpense as approveExpenseForActor,
  createExpenseRecord as createExpenseRecordForActor,
  rejectExpense as rejectExpenseForActor,
  submitExpenseForApproval as submitExpenseForApprovalForActor,
  type CreateExpenseRecordInput,
  type ExpenseRecordActionError,
} from "@/lib/academies/expense-records";

/**
 * PLAN.md Phase 4, Item 53's four expense server actions — thin
 * `"use server"` wrappers, same convention as
 * lib/academies/grade-configurations-actions.ts.
 */
const UNAUTHENTICATED: ExpenseRecordActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface ExpenseRecordFormState {
  ok: boolean;
  error?: ExpenseRecordActionError;
}

function parseCreateExpenseRecordFormData(formData: FormData): CreateExpenseRecordInput {
  const branchId = String(formData.get("branchId") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  return {
    branchId: branchId.length > 0 ? branchId : undefined,
    category: String(formData.get("category") ?? ""),
    description: description.length > 0 ? description : undefined,
    amountCents: Number(formData.get("amountCents") ?? 0),
    currency: currency.length > 0 ? currency : undefined,
  };
}

export async function createExpenseRecordAction(
  _prevState: ExpenseRecordFormState,
  formData: FormData,
): Promise<ExpenseRecordFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createExpenseRecordForActor(context, parseCreateExpenseRecordFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export type ExpenseLifecycleActionResult =
  | { ok: true }
  | { ok: false; error: ExpenseRecordActionError };

/** Single confirm-and-fire button actions — same direct-call convention as
 * lib/academies/grade-configurations-actions.ts's lifecycle actions. */
export async function submitExpenseForApprovalAction(
  expenseRecordId: string,
): Promise<ExpenseLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await submitExpenseForApprovalForActor(context, expenseRecordId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export async function approveExpenseAction(
  expenseRecordId: string,
): Promise<ExpenseLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await approveExpenseForActor(context, expenseRecordId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export async function rejectExpenseAction(
  expenseRecordId: string,
  reason: string,
): Promise<ExpenseLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await rejectExpenseForActor(context, expenseRecordId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}
