"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  deleteAcademy as deleteAcademyForActor,
  getAcademyDeletionEligibility as getAcademyDeletionEligibilityForActor,
  type AcademyDeletionActionError,
  type AcademyDeletionEligibility,
} from "@/lib/academies/delete-academy";

const UNAUTHENTICATED: AcademyDeletionActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export async function getAcademyDeletionEligibility(
  academyId: string,
): Promise<{ ok: true; eligibility: AcademyDeletionEligibility } | { ok: false; error: AcademyDeletionActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return getAcademyDeletionEligibilityForActor(context, academyId);
}

/**
 * Called directly from the confirmation dialog (not useActionState — this
 * is a one-shot destructive action with a single result, same convention
 * as e.g. lib/academies/staff-actions.ts's removeStaffMembership).
 */
export async function deleteAcademy(
  academyId: string,
  confirmedName: string,
): Promise<{ ok: true } | { ok: false; error: AcademyDeletionActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await deleteAcademyForActor(context, academyId, confirmedName);
  if (!result.ok) {
    return result;
  }

  revalidatePath("/platform/academies");
  return { ok: true };
}
