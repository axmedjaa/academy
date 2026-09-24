"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveProgram as archiveProgramForActor,
  createProgram as createProgramForActor,
  restoreProgram as restoreProgramForActor,
  updateProgram as updateProgramForActor,
  type CreateProgramInput,
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
