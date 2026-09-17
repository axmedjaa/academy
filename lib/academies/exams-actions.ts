"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createExam as createExamForActor,
  enterMarks as enterMarksForActor,
  listExamResults as listExamResultsForActor,
  type CreateExamInput,
  type EnterMarksInput,
  type ExamActionError,
  type ListExamResultsResult,
} from "@/lib/academies/exams";

const UNAUTHENTICATED: ExamActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface ExamFormState {
  ok: boolean;
  error?: ExamActionError;
}

function parseCreateExamFormData(formData: FormData): CreateExamInput {
  const examDate = String(formData.get("examDate") ?? "");
  return {
    batchId: String(formData.get("batchId") ?? ""),
    name: String(formData.get("name") ?? ""),
    maxMarks: String(formData.get("maxMarks") ?? ""),
    examDate: examDate || null,
  };
}

export async function createExam(
  _prevState: ExamFormState,
  formData: FormData,
): Promise<ExamFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createExamForActor(context, parseCreateExamFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/exams");
  revalidatePath(`/academy/batches/${result.exam.batchId}`);
  return { ok: true };
}

/**
 * Not a `useActionState`-bound form action (unlike `createExam` above) —
 * `enterMarks` takes a variable-length roster of `{ studentId,
 * marksObtained }` entries, which doesn't map onto a single `FormData`
 * submission the way a fixed-field create form does. Called directly from
 * a client component via a transition, the same shape
 * `deleteTimetableEntry`/`withdrawStudentFromBatch` already use for
 * non-form actions in this codebase.
 */
export async function enterMarks(
  examId: string,
  entries: EnterMarksInput,
): Promise<{ ok: true } | { ok: false; error: ExamActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await enterMarksForActor(context, examId, entries);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/exams");
  revalidatePath(`/academy/exams/${examId}`);
  return { ok: true };
}

/** Read-only wrapper so the client-side "Enter marks" panel can fetch an
 * exam's roster on demand without a full page navigation — a Server Action
 * is the standard way to call server-only logic from a Client Component in
 * this codebase, even for a read (no mutation happens here). */
export async function getExamResultsRoster(examId: string): Promise<ListExamResultsResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return listExamResultsForActor(context, examId);
}
