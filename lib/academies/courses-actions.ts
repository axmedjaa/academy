"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveCourse as archiveCourseForActor,
  createCourse as createCourseForActor,
  updateCourse as updateCourseForActor,
  type CourseActionError,
  type CreateCourseInput,
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
