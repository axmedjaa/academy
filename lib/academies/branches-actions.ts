"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archiveBranch as archiveBranchForActor,
  createBranch as createBranchForActor,
  updateBranch as updateBranchForActor,
  type BranchActionError,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "@/lib/academies/branches";

const UNAUTHENTICATED: BranchActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface BranchFormState {
  ok: boolean;
  error?: BranchActionError;
}

/**
 * FormData -> CreateBranchInput/UpdateBranchInput. Same "just shape
 * translation, not validation" convention as
 * lib/academies/settings-actions.ts's parseAcademySettingsFormData — the
 * real validation is lib/academies/branches.ts's Zod schema, run again
 * right after this.
 */
function parseBranchFormData(formData: FormData): CreateBranchInput | UpdateBranchInput {
  return {
    name: String(formData.get("name") ?? ""),
    code: String(formData.get("code") ?? ""),
    address: String(formData.get("address") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  };
}

/** PLAN.md §4 server action name. */
export async function createBranch(
  _prevState: BranchFormState,
  formData: FormData,
): Promise<BranchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createBranchForActor(context, parseBranchFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/branches");
  return { ok: true };
}

/** PLAN.md §4 server action name. Branch id is read from the form itself
 * (a hidden field), never trusted from any other client-suppliable
 * source — same IDOR-safe posture as every other tenant-scoped action in
 * this codebase; lib/academies/branches.ts's updateBranch still re-checks
 * it belongs to the caller's own academy regardless. */
export async function updateBranch(
  _prevState: BranchFormState,
  formData: FormData,
): Promise<BranchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const branchId = String(formData.get("branchId") ?? "");
  const result = await updateBranchForActor(context, branchId, parseBranchFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/branches");
  return { ok: true };
}

/** PLAN.md §4 server action name. */
export async function archiveBranch(
  _prevState: BranchFormState,
  formData: FormData,
): Promise<BranchFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const branchId = String(formData.get("branchId") ?? "");
  const result = await archiveBranchForActor(context, branchId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/branches");
  return { ok: true };
}
