"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  approveResult as approveResultForActor,
  listResults as listResultsForActor,
  publishResults as publishResultsForActor,
  rejectResult as rejectResultForActor,
  submitResults as submitResultsForActor,
  type ListResultsResult,
  type PublishResultsInput,
  type ResultActionError,
  type SubmitResultsInput,
} from "@/lib/academies/results";

const UNAUTHENTICATED: ResultActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

/** Read-only wrapper — same "Server Action even for a read" convention
 * lib/academies/exams-actions.ts's `getExamResultsRoster` already
 * established for this codebase's Client Components. */
export async function getResultsList(examId?: string): Promise<ListResultsResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return listResultsForActor(context, examId);
}

export async function submitResults(
  examId: string,
  input?: SubmitResultsInput,
): Promise<{ ok: true } | { ok: false; error: ResultActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await submitResultsForActor(context, examId, input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}

export async function approveResult(
  resultId: string,
): Promise<{ ok: true } | { ok: false; error: ResultActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await approveResultForActor(context, resultId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}

export async function rejectResult(
  resultId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: ResultActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await rejectResultForActor(context, resultId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}

export async function publishResults(
  examId: string,
  input?: PublishResultsInput,
): Promise<{ ok: true } | { ok: false; error: ResultActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  const result = await publishResultsForActor(context, examId, input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/academy/results");
  return { ok: true };
}
