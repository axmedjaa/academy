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

function parseEnrollStudentFormData(formData: FormData): EnrollStudentInput {
  return {
    batchId: String(formData.get("batchId") ?? ""),
    studentId: String(formData.get("studentId") ?? ""),
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
  const result = await updateStudentEnrollmentForActor(context, studentId, batchId || undefined);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/students");
  return { ok: true };
}
