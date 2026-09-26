"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  updateAcademySettings as updateAcademySettingsForActor,
  type AcademySettingsActionError,
  type UpdateAcademySettingsInput,
} from "@/lib/academies/settings";

const UNAUTHENTICATED: AcademySettingsActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface AcademySettingsFormState {
  ok: boolean;
  error?: AcademySettingsActionError;
}

/**
 * FormData -> UpdateAcademySettingsInput. Left loose/untyped-looking on
 * purpose — every field is re-validated by lib/academies/settings.ts's
 * Zod schema right after this runs, same convention as
 * lib/subscriptions/plans-actions.ts's parsePlanFormData ("this is just
 * shape translation, not validation").
 */
function parseAcademySettingsFormData(formData: FormData): UpdateAcademySettingsInput {
  return {
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? ""),
    address: String(formData.get("address") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    website: String(formData.get("website") ?? ""),
    registrationNumber: String(formData.get("registrationNumber") ?? ""),
    primaryContactName: String(formData.get("primaryContactName") ?? ""),
    primaryContactPhone: String(formData.get("primaryContactPhone") ?? ""),
  };
}

/**
 * PLAN.md §4 server action name. Form-bound via useActionState (same
 * pattern as lib/subscriptions/plans-actions.ts's updateSubscriptionPlan)
 * since settings edits have field-level validation errors to surface.
 */
export async function updateAcademySettings(
  _prevState: AcademySettingsFormState,
  formData: FormData,
): Promise<AcademySettingsFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateAcademySettingsForActor(
    context,
    parseAcademySettingsFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/settings");
  return { ok: true };
}
