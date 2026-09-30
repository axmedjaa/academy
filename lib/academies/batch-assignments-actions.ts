"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  assignTrainerToBatch as assignTrainerToBatchForActor,
  deleteBatchEnrollment as deleteBatchEnrollmentForActor,
  enrollStudentInBatch as enrollStudentInBatchForActor,
  unassignTrainerFromBatch as unassignTrainerFromBatchForActor,
  updateStudentEnrollment as updateStudentEnrollmentForActor,
  withdrawStudentFromBatch as withdrawStudentFromBatchForActor,
  type AssignTrainerInput,
  type BatchAssignmentActionError,
  type EnrollStudentInput,
} from "@/lib/academies/batch-assignments";
import { dollarsToCents } from "@/lib/ui/money";

const UNAUTHENTICATED: BatchAssignmentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface BatchAssignmentFormState {
  ok: boolean;
  error?: BatchAssignmentActionError;
}

function parseAssignTrainerFormData(formData: FormData): AssignTrainerInput {
  return {
    batchId: String(formData.get("batchId") ?? ""),
    staffProfileId: String(formData.get("staffProfileId") ?? ""),
  };
}

/** The "Amount per period" field is entered in dollars, not cents — see
 * lib/ui/money.ts's dollarsToCents. Shared by both enrollStudentInBatch
 * (roster-panel.tsx's enroll form) and updateStudentEnrollment
 * (students-list.tsx's "change course" form). */
function parsePaymentPlanFormData(formData: FormData): EnrollStudentInput["paymentPlan"] {
  const currency = String(formData.get("paymentPlanCurrency") ?? "").trim();
  const anchorDate = String(formData.get("paymentPlanAnchorDate") ?? "").trim();
  return {
    intervalMonths: Number(formData.get("paymentPlanIntervalMonths") ?? 0),
    amountCents: dollarsToCents(String(formData.get("paymentPlanAmountDollars") ?? "")) ?? NaN,
    currency: currency.length > 0 ? currency : undefined,
    anchorDate: anchorDate.length > 0 ? anchorDate : undefined,
  };
}

function parseEnrollStudentFormData(formData: FormData): EnrollStudentInput {
  return {
    batchId: String(formData.get("batchId") ?? ""),
    studentId: String(formData.get("studentId") ?? ""),
    paymentPlan: parsePaymentPlanFormData(formData),
  };
}

export async function assignTrainerToBatch(
  _prevState: BatchAssignmentFormState,
  formData: FormData,
): Promise<BatchAssignmentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await assignTrainerToBatchForActor(context, parseAssignTrainerFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/batches/${result.assignment.batchId}`);
  return { ok: true };
}

export async function unassignTrainerFromBatch(
  _prevState: BatchAssignmentFormState,
  formData: FormData,
): Promise<BatchAssignmentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const assignmentId = String(formData.get("assignmentId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  const result = await unassignTrainerFromBatchForActor(context, assignmentId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/batches/${batchId}`);
  return { ok: true };
}

export async function enrollStudentInBatch(
  _prevState: BatchAssignmentFormState,
  formData: FormData,
): Promise<BatchAssignmentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await enrollStudentInBatchForActor(context, parseEnrollStudentFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/batches/${result.enrollment.batchId}`);
  return { ok: true };
}

export async function withdrawStudentFromBatch(
  _prevState: BatchAssignmentFormState,
  formData: FormData,
): Promise<BatchAssignmentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const enrollmentId = String(formData.get("enrollmentId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  const result = await withdrawStudentFromBatchForActor(context, enrollmentId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/academy/batches/${batchId}`);
  return { ok: true };
}

/** Plain-callable, for the roster panel's "Delete" row action — permanent,
 * distinct from the withdraw form action above. See
 * lib/academies/batch-assignments.ts's deleteBatchEnrollment doc comment
 * for the eligibility rule (no exam results/certificates for this
 * student+batch pair). */
export async function deleteBatchEnrollment(
  enrollmentId: string,
  batchId: string,
): Promise<{ ok: true } | { ok: false; error: BatchAssignmentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteBatchEnrollmentForActor(context, enrollmentId);
  if (!result.ok) {
    return result;
  }

  revalidatePath(`/academy/batches/${batchId}`);
  return { ok: true };
}

/** `/academy/students`'s "change course" control — see
 * lib/academies/batch-assignments.ts's updateStudentEnrollment for the
 * withdraw-then-enroll orchestration this wraps. An empty `batchId`
 * withdraws the student's current course without enrolling in a new one. */
export async function updateStudentEnrollment(
  _prevState: BatchAssignmentFormState,
  formData: FormData,
): Promise<BatchAssignmentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const studentId = String(formData.get("studentId") ?? "");
  const batchId = String(formData.get("batchId") ?? "").trim();
  // Only relevant when enrolling into a NEW course (a plain withdraw, empty
  // batchId, needs no plan) — parsed unconditionally since it's harmless
  // when unused, and updateStudentEnrollment itself only requires it when
  // batchId is present.
  const paymentPlan = batchId ? parsePaymentPlanFormData(formData) : undefined;
  const result = await updateStudentEnrollmentForActor(context, studentId, batchId || undefined, paymentPlan);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/students");
  return { ok: true };
}
