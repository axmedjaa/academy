"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  archivePlatformStaff as archivePlatformStaffForActor,
  createPlatformStaffAccount as createPlatformStaffAccountForActor,
  deletePlatformStaffPermanently as deletePlatformStaffPermanentlyForActor,
  grantPlatformPermission as grantPlatformPermissionForActor,
  restorePlatformStaff as restorePlatformStaffForActor,
  revokePlatformPermission as revokePlatformPermissionForActor,
  updatePlatformStaff as updatePlatformStaffForActor,
  type StaffActionError,
} from "@/lib/platform-staff/staff";

const UNAUTHENTICATED: StaffActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

type PlainResult = { ok: true } | { ok: false; error: StaffActionError };

export interface PlatformStaffFormState {
  ok: boolean;
  error?: StaffActionError;
}

/** Kept for existing imports; same shape as PlatformStaffFormState. */
export type CreatePlatformAdminAccountState = PlatformStaffFormState;

/**
 * Add staff dialog, form-bound via useActionState (same pattern as
 * lib/auth/mfa-actions.ts's verifyMfaEnrollment) since account creation
 * has field-level validation errors to surface. Every rule (owner-only,
 * validation, duplicate email) is enforced in lib/platform-staff/staff.ts.
 */
export async function createPlatformStaffAccount(
  _prevState: PlatformStaffFormState,
  formData: FormData,
): Promise<PlatformStaffFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await createPlatformStaffAccountForActor(context, {
    fullName: String(formData.get("fullName") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    role: String(formData.get("role") ?? ""),
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/platform/staff");
  return { ok: true };
}

/** Edit staff dialog (name, email, role). */
export async function updatePlatformStaff(
  _prevState: PlatformStaffFormState,
  formData: FormData,
): Promise<PlatformStaffFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await updatePlatformStaffForActor(context, {
    userId: String(formData.get("userId") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    email: String(formData.get("email") ?? ""),
    role: String(formData.get("role") ?? ""),
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/platform/staff");
  return { ok: true };
}

/** signInDisabled=false means the person keeps academy sign-in (see archivePlatformStaff in staff.ts). */
export async function archivePlatformStaff(
  userId: string,
  reason?: string,
): Promise<{ ok: true; signInDisabled: boolean } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await archivePlatformStaffForActor(context, { userId, reason });
  if (!result.ok) return result;
  revalidatePath("/platform/staff");
  return { ok: true, signInDisabled: result.signInDisabled };
}

export async function restorePlatformStaff(userId: string): Promise<PlainResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await restorePlatformStaffForActor(context, { userId });
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}

export async function deletePlatformStaffPermanently(userId: string, confirmEmail: string): Promise<PlainResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await deletePlatformStaffPermanentlyForActor(context, { userId, confirmEmail });
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}

/**
 * PLAN.md §4 server action name. Called directly (not through
 * useActionState) from the capability-toggle/preset UI, which needs to
 * fire several grants in a row rather than manage one form's pending
 * state.
 */
export async function grantPlatformPermission(
  targetUserId: string,
  capability: string,
): Promise<PlainResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await grantPlatformPermissionForActor(context, targetUserId, capability);
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}

/** PLAN.md §4 server action name. See grantPlatformPermission above. */
export async function revokePlatformPermission(
  targetUserId: string,
  capability: string,
): Promise<PlainResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await revokePlatformPermissionForActor(context, targetUserId, capability);
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}
