"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import { issueReceipt as issueReceiptForActor } from "@/lib/academies/student-payments";
import {
  enrollStudentInProgram as enrollStudentInProgramForActor,
  getProgramRefundPosition as getProgramRefundPositionForActor,
  recordProgramPayment as recordProgramPaymentForActor,
  withdrawFromProgram as withdrawFromProgramForActor,
  type EnrollStudentInProgramInput,
  type ProgramEnrollmentError,
  type ProgramRefundPosition,
  type RecordProgramPaymentInput,
  type WithdrawFromProgramInput,
} from "@/lib/academies/program-enrollments";

/** Thin "use server" wrappers — same convention as fee-periods-actions.ts. */
const UNAUTHENTICATED: ProgramEnrollmentError = { code: "forbidden", message: "You must be signed in." };

export interface ProgramActionState {
  ok: boolean;
  error?: ProgramEnrollmentError;
  /** Set by a successful payment: the recorded payment and its receipt. */
  paymentId?: string;
  receiptId?: string;
}

function revalidateStudent(studentId?: string) {
  revalidatePath("/academy/students", "layout");
  if (studentId) revalidatePath(`/academy/students/${studentId}`);
  revalidatePath("/academy/finance", "layout");
}

export async function enrollStudentInProgramAction(input: EnrollStudentInProgramInput): Promise<ProgramActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await enrollStudentInProgramForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateStudent(result.enrollment.studentId);
  revalidatePath(`/academy/batches/${result.enrollment.batchId}`);
  return { ok: true, paymentId: result.initialPaymentId ?? undefined };
}

/** Records a program payment and issues its receipt (same receipt flow as
 * any other student payment). A receipt failure never undoes the payment;
 * the receipt can be issued again from the payment history. */
export async function recordProgramPaymentAction(input: RecordProgramPaymentInput): Promise<ProgramActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await recordProgramPaymentForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  const receipt = await issueReceiptForActor(context, result.payment.id);
  revalidateStudent(result.payment.studentId);
  return { ok: true, paymentId: result.payment.id, receiptId: receipt.ok ? receipt.receipt.id : undefined };
}

export async function withdrawFromProgramAction(input: WithdrawFromProgramInput, studentId?: string): Promise<ProgramActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await withdrawFromProgramForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateStudent(studentId ?? result.enrollment.studentId);
  return { ok: true };
}

export async function getProgramRefundPositionAction(
  programEnrollmentId: string,
): Promise<{ ok: true; position: ProgramRefundPosition } | { ok: false; error: ProgramEnrollmentError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  return getProgramRefundPositionForActor(context, programEnrollmentId);
}
