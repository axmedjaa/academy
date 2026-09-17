"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  approveResultCorrection as approveResultCorrectionForActor,
  listResultCorrections as listResultCorrectionsForActor,
  rejectResultCorrection as rejectResultCorrectionForActor,
  requestResultCorrection as requestResultCorrectionForActor,
  type ListResultCorrectionsResult,
  type RequestResultCorrectionInput,
  type ResultCorrectionActionError,
} from "@/lib/academies/result-corrections";

const UNAUTHENTICATED: ResultCorrectionActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export async function getResultCorrectionsList(
  originalResultId?: string,
): Promise<ListResultCorrectionsResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return listResultCorrectionsForActor(context, originalResultId);
}

export async function requestResultCorrection(
  originalResultId: string,
  input: RequestResultCorrectionInput,
): Promise<{ ok: true } | { ok: false; error: ResultCorrectionActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await requestResultCorrectionForActor(context, originalResultId, input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}

export async function approveResultCorrection(
  correctionId: string,
): Promise<{ ok: true } | { ok: false; error: ResultCorrectionActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await approveResultCorrectionForActor(context, correctionId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}

export async function rejectResultCorrection(
  correctionId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: ResultCorrectionActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await rejectResultCorrectionForActor(context, correctionId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}
