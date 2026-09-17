"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  activateGradeConfiguration as activateGradeConfigurationForActor,
  approveGradeConfig as approveGradeConfigForActor,
  createGradeConfiguration as createGradeConfigurationForActor,
  rejectGradeConfig as rejectGradeConfigForActor,
  submitGradeConfigForApproval as submitGradeConfigForApprovalForActor,
  updateGradeBands as updateGradeBandsForActor,
  type CreateGradeConfigurationInput,
  type GradeBandInput,
  type GradeConfigActionError,
} from "@/lib/academies/grade-configurations";

/**
 * PLAN.md Item 46 (createGradeConfiguration/updateGradeBands) plus Item 47's
 * four lifecycle-transition actions added below. `/academy/grades`
 * (app/academy/grades/page.tsx + grade-configurations-list.tsx) is Item
 * 47's page, and it calls every action in this file.
 */
const UNAUTHENTICATED: GradeConfigActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface GradeConfigFormState {
  ok: boolean;
  error?: GradeConfigActionError;
}

function parseCreateGradeConfigurationFormData(formData: FormData): CreateGradeConfigurationInput {
  return { name: String(formData.get("name") ?? "") };
}

export async function createGradeConfiguration(
  _prevState: GradeConfigFormState,
  formData: FormData,
): Promise<GradeConfigFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createGradeConfigurationForActor(
    context,
    parseCreateGradeConfigurationFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}

/** `bandsJson` is a JSON-encoded `GradeBandInput[]` — a plain FormData
 * shape has no native way to submit a variable-length list of structured
 * rows, so (like several other array-shaped forms elsewhere in this
 * codebase's plan) the client is expected to serialize the band editor's
 * rows into one hidden field before submit. */
function parseUpdateGradeBandsFormData(formData: FormData): GradeBandInput[] {
  const raw = String(formData.get("bandsJson") ?? "[]");
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GradeBandInput[]) : [];
  } catch {
    return [];
  }
}

export async function updateGradeBands(
  _prevState: GradeConfigFormState,
  formData: FormData,
): Promise<GradeConfigFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const gradeConfigurationId = String(formData.get("gradeConfigurationId") ?? "");
  const result = await updateGradeBandsForActor(
    context,
    gradeConfigurationId,
    parseUpdateGradeBandsFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}

/**
 * PLAN.md Item 47's four lifecycle-transition server actions. Unlike
 * `createGradeConfiguration`/`updateGradeBands` above (form submissions with
 * real field data, so they use `useActionState`'s `(prevState, formData)`
 * shape), these are single confirm-and-fire button actions with at most one
 * scalar argument each — same direct-call convention as
 * lib/academies/lifecycle-actions.ts's `activateAcademyAction`/
 * `suspendAcademyAction`, called straight from the client component
 * (app/academy/grades/grade-configurations-list.tsx), not via a `<form>`.
 */
export type GradeConfigLifecycleActionResult =
  | { ok: true }
  | { ok: false; error: GradeConfigActionError };

export async function submitGradeConfigForApprovalAction(
  gradeConfigurationId: string,
): Promise<GradeConfigLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await submitGradeConfigForApprovalForActor(context, gradeConfigurationId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}

export async function approveGradeConfigAction(
  gradeConfigurationId: string,
): Promise<GradeConfigLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await approveGradeConfigForActor(context, gradeConfigurationId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}

export async function rejectGradeConfigAction(
  gradeConfigurationId: string,
  reason: string,
): Promise<GradeConfigLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await rejectGradeConfigForActor(context, gradeConfigurationId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}

export async function activateGradeConfigurationAction(
  gradeConfigurationId: string,
): Promise<GradeConfigLifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await activateGradeConfigurationForActor(context, gradeConfigurationId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/grades");
  return { ok: true };
}
