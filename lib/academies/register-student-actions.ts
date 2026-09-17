"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  registerStudent as registerStudentForActor,
  type RegisterStudentActionError,
  type RegisterStudentInput,
} from "@/lib/academies/register-student";

const UNAUTHENTICATED: RegisterStudentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface RegisterStudentFormState {
  ok: boolean;
  error?: RegisterStudentActionError;
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

/** PLAN.md §4 server action name, form-bound via useActionState for /academy/students/new. */
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
  return { ok: true };
}
