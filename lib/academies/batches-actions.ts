"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveBatch as archiveBatchForActor,
  createBatch as createBatchForActor,
  restoreBatch as restoreBatchForActor,
  updateBatch as updateBatchForActor,
  type BatchActionError,
  type CreateBatchInput,
  type UpdateBatchInput,
} from "@/lib/academies/batches";

const UNAUTHENTICATED: BatchActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface BatchFormState {
  ok: boolean;
  error?: BatchActionError;
}

function parseBatchFormData(formData: FormData): CreateBatchInput | UpdateBatchInput {
  return {
    branchId: String(formData.get("branchId") ?? ""),
    courseId: String(formData.get("courseId") ?? ""),
    name: String(formData.get("name") ?? ""),
    code: String(formData.get("code") ?? ""),
    startDate: String(formData.get("startDate") ?? ""),
    endDate: String(formData.get("endDate") ?? ""),
  };
}

export async function createBatch(
  _prevState: BatchFormState,
  formData: FormData,
): Promise<BatchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createBatchForActor(context, parseBatchFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/batches");
  return { ok: true };
}

export async function updateBatch(
  _prevState: BatchFormState,
  formData: FormData,
): Promise<BatchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const batchId = String(formData.get("batchId") ?? "");
  const result = await updateBatchForActor(context, batchId, parseBatchFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/batches");
  return { ok: true };
}

export async function archiveBatch(
  _prevState: BatchFormState,
  formData: FormData,
): Promise<BatchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const batchId = String(formData.get("batchId") ?? "");
  const result = await archiveBatchForActor(context, batchId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/batches");
  return { ok: true };
}

/** Plain-callable, for the batches table's "Archive"/"Restore" row action
 * — same convention as students-actions.ts's updateStudentStatus. */
export async function setBatchStatus(
  batchId: string,
  status: "active" | "archived",
): Promise<{ ok: true } | { ok: false; error: BatchActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result =
    status === "archived"
      ? await archiveBatchForActor(context, batchId)
      : await restoreBatchForActor(context, batchId);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/batches");
  return { ok: true };
}
