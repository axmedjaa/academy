"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createGradeConfiguration as createGradeConfigurationForActor,
  updateGradeBands as updateGradeBandsForActor,
  type CreateGradeConfigurationInput,
  type GradeBandInput,
  type GradeConfigActionError,
} from "@/lib/academies/grade-configurations";

/**
 * PLAN.md Item 46. No `/academy/grades` page exists yet (that's the later
 * approval-flow item's UI to build — see grade-configurations.ts's module
 * comment) so these server actions have no client component calling them
 * today; they exist so that later item can wire a form up to this item's
 * already-built, already-tested logic without having to write the
 * FormData-parsing glue itself.
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
