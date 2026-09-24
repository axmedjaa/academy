"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveExam as archiveExamForActor,
  createExam as createExamForActor,
  deleteExam as deleteExamForActor,
  enterMarks as enterMarksForActor,
  getExamDeletionEligibility as getExamDeletionEligibilityForActor,
  listExamResults as listExamResultsForActor,
  restoreExam as restoreExamForActor,
  type CreateExamInput,
  type EnterMarksInput,
  type ExamActionError,
  type GetExamDeletionEligibilityResult,
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

/** Plain-callable, for the exams table's "Archive"/"Restore" row action —
 * same convention as students-actions.ts's updateStudentStatus and this
 * file's own enterMarks. */
export async function setExamStatus(
  examId: string,
  status: "scheduled" | "archived",
): Promise<{ ok: true } | { ok: false; error: ExamActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result =
    status === "archived"
      ? await archiveExamForActor(context, examId)
      : await restoreExamForActor(context, examId);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/exams");
  return { ok: true };
}

/** Plain-callable, for the exams table's "Delete" row action. Permanent —
 * see lib/academies/exams.ts's deleteExam doc comment for the eligibility
 * rule (no results attached) that keeps this from ever touching a
 * protected exam_results row. */
export async function deleteExam(examId: string): Promise<{ ok: true } | { ok: false; error: ExamActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteExamForActor(context, examId);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/exams");
  return { ok: true };
}

/** Read-only wrapper so the exams table can preview whether a given exam
 * qualifies for permanent deletion (enabled/disabled Delete button) before
 * the confirmation dialog opens. */
export async function getExamDeletionEligibility(examId: string): Promise<GetExamDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getExamDeletionEligibilityForActor(context, examId);
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
