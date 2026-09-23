"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  registerStudent as registerStudentForActor,
  type RegisterStudentActionError,
  type RegisterStudentInput,
} from "@/lib/academies/register-student";
import { enrollStudentInBatch } from "@/lib/academies/batch-assignments";

const UNAUTHENTICATED: RegisterStudentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface RegisterStudentFormState {
  ok: boolean;
  error?: RegisterStudentActionError;
  /** Set only when the student WAS created but the optional course/batch
   * enrollment step afterward failed (e.g. the batch filled up or was
   * archived between page load and submit) — the registration itself
   * still succeeded, so this is a warning, not `error`. The admin can
   * enroll the student from the batch's own roster page instead. */
  enrollmentWarning?: string;
}

/**
 * FormData -> RegisterStudentInput. Shape translation only — every field
 * is re-validated by lib/academies/register-student.ts's Zod schema right
 * after this runs, same convention as
 * lib/academies/staff-actions.ts's parseCreateStaffFormData.
 */
function parseRegisterStudentFormData(formData: FormData): RegisterStudentInput {
  return {
    branchId: String(formData.get("branchId") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    gender: String(formData.get("gender") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    guardianName: String(formData.get("guardianName") ?? ""),
    guardianPhone: String(formData.get("guardianPhone") ?? ""),
  };
}

/**
 * PLAN.md §4 server action name, form-bound via useActionState for
 * /academy/students/new. `batchId` is a new, optional field added for the
 * simple course/enrollment workflow: the admin picks the course (really a
 * specific batch of it — see student-form.tsx's module comment on why) at
 * registration time, and this action enrolls the newly-created student
 * into it right after, reusing `enrollStudentInBatch`
 * (lib/academies/batch-assignments.ts) unmodified — no new enrollment
 * logic. `registerStudent` itself is untouched; this only orchestrates two
 * already-existing, separately-tested actions in sequence, matching PLAN's
 * "Student -> Batch -> Course" relationship exactly as already built.
 */
export async function registerStudent(
  _prevState: RegisterStudentFormState,
  formData: FormData,
): Promise<RegisterStudentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await registerStudentForActor(context, parseRegisterStudentFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Item 39's /academy/students and /academy/admissions views aren't this
  // item's to build/import, but revalidating their paths here is harmless
  // (a no-op today if those routes don't exist yet) and keeps them fresh
  // once Item 39 lands, same "revalidate the list page this create feeds"
  // convention as branches-actions.ts/staff-actions.ts.
  revalidatePath("/academy/students");
  revalidatePath("/academy/admissions");

  const batchId = String(formData.get("batchId") ?? "").trim();
  if (batchId) {
    const enrollResult = await enrollStudentInBatch(context, { batchId, studentId: result.student.id });
    if (!enrollResult.ok) {
      // The student row was already created successfully — this is a
      // secondary, recoverable failure (e.g. a race on the batch), not a
      // reason to report the whole registration as failed.
      return {
        ok: true,
        enrollmentWarning: `Student registered, but could not be enrolled in the selected course: ${enrollResult.error.message}`,
      };
    }
  }

  return { ok: true };
}
