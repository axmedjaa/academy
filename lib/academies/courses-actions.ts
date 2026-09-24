"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveCourse as archiveCourseForActor,
  createCourse as createCourseForActor,
  deleteCourse as deleteCourseForActor,
  getCourseDeletionEligibility as getCourseDeletionEligibilityForActor,
  restoreCourse as restoreCourseForActor,
  updateCourse as updateCourseForActor,
  type CourseActionError,
  type CreateCourseInput,
  type GetCourseDeletionEligibilityResult,
  type UpdateCourseInput,
} from "@/lib/academies/courses";

const UNAUTHENTICATED: CourseActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface CourseFormState {
  ok: boolean;
  error?: CourseActionError;
}

function parseCourseFormData(formData: FormData): CreateCourseInput | UpdateCourseInput {
  return {
    programId: String(formData.get("programId") ?? ""),
    name: String(formData.get("name") ?? ""),
    code: String(formData.get("code") ?? ""),
    description: String(formData.get("description") ?? ""),
    durationWeeks: String(formData.get("durationWeeks") ?? ""),
    startDate: String(formData.get("startDate") ?? ""),
    endDate: String(formData.get("endDate") ?? ""),
    imageRef: String(formData.get("imageRef") ?? ""),
    instructorId: String(formData.get("instructorId") ?? ""),
  };
}

export async function createCourse(
  _prevState: CourseFormState,
  formData: FormData,
): Promise<CourseFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createCourseForActor(context, parseCourseFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/courses");
  return { ok: true };
}

export async function updateCourse(
  _prevState: CourseFormState,
  formData: FormData,
): Promise<CourseFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const courseId = String(formData.get("courseId") ?? "");
  const result = await updateCourseForActor(context, courseId, parseCourseFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/courses");
  return { ok: true };
}

export async function archiveCourse(
  _prevState: CourseFormState,
  formData: FormData,
): Promise<CourseFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const courseId = String(formData.get("courseId") ?? "");
  const result = await archiveCourseForActor(context, courseId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/courses");
  return { ok: true };
}

/** Plain-callable, for the courses table's "Archive"/"Restore" row action
 * — same convention as students-actions.ts's updateStudentStatus. */
export async function setCourseStatus(
  courseId: string,
  status: "active" | "archived",
): Promise<{ ok: true } | { ok: false; error: CourseActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result =
    status === "archived"
      ? await archiveCourseForActor(context, courseId)
      : await restoreCourseForActor(context, courseId);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/courses");
  return { ok: true };
}

/** Read-only preview for the courses table's Delete button. */
export async function getCourseDeletionEligibility(
  courseId: string,
): Promise<GetCourseDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getCourseDeletionEligibilityForActor(context, courseId);
}

/** Plain-callable permanent-deletion action. `confirmedName` must equal
 * the course's exact current name — re-checked server-side here, same
 * convention as lib/academies/delete-academy.ts's deleteAcademy. */
export async function deleteCourse(
  courseId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: CourseActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteCourseForActor(context, courseId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/courses");
  return { ok: true };
}
