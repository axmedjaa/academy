"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveProgram as archiveProgramForActor,
  createProgram as createProgramForActor,
  deleteProgram as deleteProgramForActor,
  getProgramDeletionEligibility as getProgramDeletionEligibilityForActor,
  restoreProgram as restoreProgramForActor,
  updateProgram as updateProgramForActor,
  type CreateProgramInput,
  type GetProgramDeletionEligibilityResult,
  type ProgramActionError,
  type UpdateProgramInput,
} from "@/lib/academies/programs";

const UNAUTHENTICATED: ProgramActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface ProgramFormState {
  ok: boolean;
  error?: ProgramActionError;
}

/** FormData -> CreateProgramInput/UpdateProgramInput. Shape translation
 * only — lib/academies/programs.ts's Zod schema does the real validation,
 * same convention as branches-actions.ts's parseBranchFormData. */
function parseProgramFormData(formData: FormData): CreateProgramInput | UpdateProgramInput {
  return {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
  };
}

export async function createProgram(
  _prevState: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createProgramForActor(context, parseProgramFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/programs");
  return { ok: true };
}

export async function updateProgram(
  _prevState: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const programId = String(formData.get("programId") ?? "");
  const result = await updateProgramForActor(context, programId, parseProgramFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/programs");
  return { ok: true };
}

export async function archiveProgram(
  _prevState: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const programId = String(formData.get("programId") ?? "");
  const result = await archiveProgramForActor(context, programId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/programs");
  return { ok: true };
}

/** Plain-callable, for the programs table's "Archive"/"Restore" row action
 * — same convention as students-actions.ts's updateStudentStatus. */
export async function setProgramStatus(
  programId: string,
  status: "active" | "archived",
): Promise<{ ok: true } | { ok: false; error: ProgramActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result =
    status === "archived"
      ? await archiveProgramForActor(context, programId)
      : await restoreProgramForActor(context, programId);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/programs");
  return { ok: true };
}

/** Read-only preview for the programs table's Delete button. */
export async function getProgramDeletionEligibility(
  programId: string,
): Promise<GetProgramDeletionEligibilityResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getProgramDeletionEligibilityForActor(context, programId);
}

/** Plain-callable permanent-deletion action, for the programs table's
 * "Delete" row action. `confirmedName` must equal the program's exact
 * current name — re-checked server-side here (not just a UI affordance),
 * same convention as lib/academies/delete-academy.ts's deleteAcademy. */
export async function deleteProgram(
  programId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: ProgramActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteProgramForActor(context, programId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/academy/programs");
  return { ok: true };
}
