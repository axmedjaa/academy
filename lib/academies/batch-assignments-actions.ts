"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  assignTrainerToBatch as assignTrainerToBatchForActor,
  enrollStudentInBatch as enrollStudentInBatchForActor,
  unassignTrainerFromBatch as unassignTrainerFromBatchForActor,
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
