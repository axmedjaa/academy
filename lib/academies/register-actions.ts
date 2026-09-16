"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  registerAcademy as registerAcademyForActor,
  type RegisterAcademyActionError,
} from "@/lib/academies/register";

const UNAUTHENTICATED: RegisterAcademyActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface RegisterAcademyState {
  ok: boolean;
  error?: RegisterAcademyActionError;
}

/** Default state for the client form's useActionState call. */
export const REGISTER_ACADEMY_INITIAL_STATE: RegisterAcademyState = { ok: false };

/**
 * PLAN.md §4 server action name ("registerAcademy"), form-bound via
 * useActionState (same pattern as lib/platform-staff/actions.ts's
 * createPlatformAdminAccount) since registration has field-level validation
 * errors (name, currency, owner email/password, branch fields) to surface
 * back into the multi-step form.
 */
export async function registerAcademy(
  _prevState: RegisterAcademyState,
  formData: FormData,
): Promise<RegisterAcademyState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await registerAcademyForActor(context, {
    name: String(formData.get("name") ?? ""),
    defaultCurrency: String(formData.get("defaultCurrency") ?? ""),
    type: String(formData.get("type") ?? ""),
    address: String(formData.get("address") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    website: String(formData.get("website") ?? ""),
    logoRef: String(formData.get("logoRef") ?? ""),
    registrationNumber: String(formData.get("registrationNumber") ?? ""),
    primaryContactName: String(formData.get("primaryContactName") ?? ""),
    primaryContactPhone: String(formData.get("primaryContactPhone") ?? ""),
    ownerEmail: String(formData.get("ownerEmail") ?? ""),
    ownerPassword: String(formData.get("ownerPassword") ?? ""),
    branchName: String(formData.get("branchName") ?? ""),
    branchCode: String(formData.get("branchCode") ?? ""),
    branchAddress: String(formData.get("branchAddress") ?? ""),
    branchPhone: String(formData.get("branchPhone") ?? ""),
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // The academy list/detail pages (/platform/academies, /platform/academies/
  // [id]) belong to Item 21, a different agent — revalidate their paths so
  // the newly-registered academy shows up immediately without touching
  // those files ourselves.
  revalidatePath("/platform/academies");
  redirect(`/platform/academies/${result.academyId}`);
}
