"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveBatch as archiveBatchForActor,
  createBatch as createBatchForActor,
  deleteBatch as deleteBatchForActor,
  getBatchDeletionEligibility as getBatchDeletionEligibilityForActor,
  restoreBatch as restoreBatchForActor,
  updateBatch as updateBatchForActor,
  type BatchActionError,
  type CreateBatchInput,
  type GetBatchDeletionEligibilityResult,
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

/** Read-only preview for the batches table's Delete button. */
export async function getBatchDeletionEligibility(
  batchId: string,
): Promise<GetBatchDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getBatchDeletionEligibilityForActor(context, batchId);
}

/** Plain-callable permanent-deletion action. `confirmedName` must equal
 * the batch's exact current name — re-checked server-side here, same
 * convention as lib/academies/delete-academy.ts's deleteAcademy. */
export async function deleteBatch(
  batchId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: BatchActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteBatchForActor(context, batchId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/batches");
  return { ok: true };
}
