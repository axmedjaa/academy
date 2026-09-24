"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  deleteStudent as deleteStudentForActor,
  getStudentDeletionEligibility as getStudentDeletionEligibilityForActor,
  updateStudent as updateStudentForActor,
  type GetStudentDeletionEligibilityResult,
  type StudentActionError,
  type UpdateStudentInput,
} from "@/lib/academies/students";

const UNAUTHENTICATED: StudentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface StudentFormState {
  ok: boolean;
  error?: StudentActionError;
}

/**
 * FormData -> UpdateStudentInput. Same "just shape translation, not
 * validation" convention as lib/academies/branches-actions.ts's
 * parseBranchFormData — real validation is students.ts's Zod schema, run
 * again right after this.
 *
 * `branchId` is read only when the form actually included that field —
 * the edit form (app/academy/students/students-list.tsx) only renders a
 * branch selector for academy-wide (Owner/Admin/Manager) callers, and
 * deliberately omits the field entirely for branch-limited callers
 * (Admissions Officer) so their submission never carries a `branchId` key
 * at all. That matters: `updateStudent` treats *any* `branchId` key
 * (even one resubmitting the student's current, unchanged branch) as a
 * transfer attempt and refuses it outright for branch-limited callers —
 * so `formData.has("branchId")` must gate this, not just an empty-string
 * check, or a branch-limited caller's own valid edits would fail here.
 */
function parseStudentFormData(formData: FormData): UpdateStudentInput {
  const input: UpdateStudentInput = {
    fullName: String(formData.get("fullName") ?? ""),
    dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    gender: String(formData.get("gender") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    guardianName: String(formData.get("guardianName") ?? ""),
    guardianPhone: String(formData.get("guardianPhone") ?? ""),
    status: (formData.get("status") as "active" | "archived" | null) ?? undefined,
  };
  if (formData.has("branchId")) {
    input.branchId = String(formData.get("branchId") ?? "");
  }
  return input;
}

/** PLAN.md §4 server action name. Student id is read from the form itself
 * (a hidden field), never trusted from any other client-suppliable
 * source; lib/academies/students.ts's updateStudent still re-checks it
 * belongs to the caller's own academy (and, for branch-limited callers,
 * their assigned branch) regardless. */
export async function updateStudent(
  _prevState: StudentFormState,
  formData: FormData,
): Promise<StudentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const studentId = String(formData.get("studentId") ?? "");
  const result = await updateStudentForActor(context, studentId, parseStudentFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/students");
  revalidatePath("/academy/admissions");
  return { ok: true };
}

/**
 * Plain-callable variant of the action above, for a one-click row action
 * (the students table's own "Archive"/"Restore" button) rather than a
 * `useActionState`-bound form submission — same convention as
 * lib/academies/staff-actions.ts's `updateStaff`. The caller (students-
 * list.tsx) resubmits the row's own current field values alongside the new
 * `status`, since `updateStudent` (lib/academies/students.ts) sets every
 * field it's given rather than merging a partial patch — never includes
 * `branchId`, so a branch-limited caller's own scoping is untouched
 * regardless of who clicks this.
 */
export async function updateStudentStatus(
  studentId: string,
  input: UpdateStudentInput,
): Promise<{ ok: true } | { ok: false; error: StudentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateStudentForActor(context, studentId, input);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/students");
  revalidatePath("/academy/admissions");
  return { ok: true };
}

/** Read-only preview for the students table's Delete button. */
export async function getStudentDeletionEligibility(
  studentId: string,
): Promise<GetStudentDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getStudentDeletionEligibilityForActor(context, studentId);
}

/** Plain-callable permanent-deletion action. `confirmedName` must equal
 * the student's exact current full name — re-checked server-side here,
 * same convention as lib/academies/delete-academy.ts's deleteAcademy. */
export async function deleteStudent(
  studentId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: StudentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteStudentForActor(context, studentId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/students");
  revalidatePath("/academy/admissions");
  return { ok: true };
}
