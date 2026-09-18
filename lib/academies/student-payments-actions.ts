"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  approveStudentPayment as approveStudentPaymentForActor,
  createStudentCharge as createStudentChargeForActor,
  issueReceipt as issueReceiptForActor,
  recordStudentPayment as recordStudentPaymentForActor,
  rejectStudentPayment as rejectStudentPaymentForActor,
  type CreateStudentChargeInput,
  type RecordStudentPaymentInput,
  type StudentPaymentsActionError,
} from "@/lib/academies/student-payments";

/**
 * PLAN.md Phase 4, Item 51's three server actions
 * (createStudentCharge/recordStudentPayment/issueReceipt) plus Item 52's
 * two approval actions (approveStudentPayment/rejectStudentPayment), thin
 * `"use server"` wrappers over lib/academies/student-payments.ts — same
 * convention as lib/academies/expense-records-actions.ts's
 * approveExpenseAction/rejectExpenseAction. Consumed by
 * app/academy/finance/page.tsx's charges/payments tab client component.
 */
const UNAUTHENTICATED: StudentPaymentsActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface StudentPaymentsFormState {
  ok: boolean;
  error?: StudentPaymentsActionError;
}

function parseCreateStudentChargeFormData(formData: FormData): CreateStudentChargeInput {
  const currency = String(formData.get("currency") ?? "").trim();
  const dueDate = String(formData.get("dueDate") ?? "").trim();
  return {
    studentId: String(formData.get("studentId") ?? ""),
    description: String(formData.get("description") ?? ""),
    amountCents: Number(formData.get("amountCents") ?? 0),
    currency: currency.length > 0 ? currency : undefined,
    dueDate: dueDate.length > 0 ? dueDate : undefined,
  };
}

export async function createStudentChargeAction(
  _prevState: StudentPaymentsFormState,
  formData: FormData,
): Promise<StudentPaymentsFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createStudentChargeForActor(context, parseCreateStudentChargeFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

function parseRecordStudentPaymentFormData(formData: FormData): RecordStudentPaymentInput {
  const chargeId = String(formData.get("chargeId") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  return {
    studentId: String(formData.get("studentId") ?? ""),
    chargeId: chargeId.length > 0 ? chargeId : undefined,
    amountCents: Number(formData.get("amountCents") ?? 0),
    currency: currency.length > 0 ? currency : undefined,
    method: String(formData.get("method") ?? "cash") as RecordStudentPaymentInput["method"],
    reference: reference.length > 0 ? reference : undefined,
    receivedAt: String(formData.get("receivedAt") ?? ""),
  };
}

export async function recordStudentPaymentAction(
  _prevState: StudentPaymentsFormState,
  formData: FormData,
): Promise<StudentPaymentsFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await recordStudentPaymentForActor(
    context,
    parseRecordStudentPaymentFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export type IssueReceiptActionResult =
  | { ok: true }
  | { ok: false; error: StudentPaymentsActionError };

/** Single confirm-and-fire button action (no real form fields beyond the
 * target id) — same direct-call convention as
 * lib/academies/grade-configurations-actions.ts's lifecycle actions. */
export async function issueReceiptAction(studentPaymentId: string): Promise<IssueReceiptActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await issueReceiptForActor(context, studentPaymentId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

export type StudentPaymentLifecycleActionResult =
  | { ok: true }
  | { ok: false; error: StudentPaymentsActionError };

/** Item 52 — single confirm-and-fire button action, same direct-call
 * convention as lib/academies/expense-records-actions.ts's
 * `approveExpenseAction`. */
export async function approveStudentPaymentAction(
  studentPaymentId: string,
): Promise<StudentPaymentLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await approveStudentPaymentForActor(context, studentPaymentId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  revalidatePath("/academy/finance/approvals");
  return { ok: true };
}

/** Item 52 — same convention as
 * lib/academies/expense-records-actions.ts's `rejectExpenseAction`. */
export async function rejectStudentPaymentAction(
  studentPaymentId: string,
  reason: string,
): Promise<StudentPaymentLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await rejectStudentPaymentForActor(context, studentPaymentId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  revalidatePath("/academy/finance/approvals");
  return { ok: true };
}
