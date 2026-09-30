"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createStudentCharge as createStudentChargeForActor,
  issueReceipt as issueReceiptForActor,
  recordStudentPayment as recordStudentPaymentForActor,
  type CreateStudentChargeInput,
  type RecordStudentPaymentInput,
  type StudentPaymentsActionError,
} from "@/lib/academies/student-payments";
import { dollarsToCents } from "@/lib/ui/money";

/**
 * PLAN.md Phase 4, Item 51's three server actions
 * (createStudentCharge/recordStudentPayment/issueReceipt), thin
 * `"use server"` wrappers over lib/academies/student-payments.ts. Consumed
 * by app/academy/finance/page.tsx's charges/payments tab client component.
 *
 * There are no approve/reject actions anymore — recordStudentPaymentAction
 * is immediately effective (see student-payments.ts's own module comment
 * on the "no approval workflow for student payments" architecture
 * decision); the approval queue this file used to also expose
 * (`approveStudentPaymentAction`/`rejectStudentPaymentAction`) has been
 * removed along with `/academy/finance/approvals`.
 */
const UNAUTHENTICATED: StudentPaymentsActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface StudentPaymentsFormState {
  ok: boolean;
  error?: StudentPaymentsActionError;
}

/** The form's "Amount" field is entered in dollars — see
 * lib/academies/expense-records-actions.ts's identical parse function for
 * the full rationale (lib/ui/money.ts's dollarsToCents). */
function parseCreateStudentChargeFormData(formData: FormData): CreateStudentChargeInput {
  const currency = String(formData.get("currency") ?? "").trim();
  const dueDate = String(formData.get("dueDate") ?? "").trim();
  return {
    studentId: String(formData.get("studentId") ?? ""),
    description: String(formData.get("description") ?? ""),
    amountCents: dollarsToCents(String(formData.get("amountDollars") ?? "")) ?? NaN,
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
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

/** The form's "Amount" field is entered in dollars — see
 * parseCreateStudentChargeFormData above. */
function parseRecordStudentPaymentFormData(formData: FormData): RecordStudentPaymentInput {
  const chargeId = String(formData.get("chargeId") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  return {
    studentId: String(formData.get("studentId") ?? ""),
    chargeId: chargeId.length > 0 ? chargeId : undefined,
    amountCents: dollarsToCents(String(formData.get("amountDollars") ?? "")) ?? NaN,
    currency: currency.length > 0 ? currency : undefined,
    method: String(formData.get("method") ?? "cash") as RecordStudentPaymentInput["method"],
    reference: reference.length > 0 ? reference : undefined,
    notes: notes.length > 0 ? notes : undefined,
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
  revalidatePath("/academy/students", "layout");
  return { ok: true };
}

export type IssueReceiptActionResult =
  | { ok: true; receiptId: string; receiptNumber: string }
  | { ok: false; error: StudentPaymentsActionError };

/** Single confirm-and-fire button action (no real form fields beyond the
 * target id) — same direct-call convention as
 * lib/academies/grade-configurations-actions.ts's lifecycle actions.
 * Returns the new receipt's id/number so the caller can link straight to
 * `/academy/receipts/[id]` without a full page reload. */
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
  revalidatePath("/academy/students", "layout");
  return { ok: true, receiptId: result.receipt.id, receiptNumber: result.receipt.receiptNumber };
}

