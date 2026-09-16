"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createPlatformAdminAccount as createPlatformAdminAccountForActor,
  grantPlatformPermission as grantPlatformPermissionForActor,
  revokePlatformPermission as revokePlatformPermissionForActor,
  type StaffActionError,
} from "@/lib/platform-staff/staff";

const UNAUTHENTICATED: StaffActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface CreatePlatformAdminAccountState {
  ok: boolean;
  error?: StaffActionError;
}

/**
 * PLAN.md §4 server action name, form-bound via useActionState (same
 * pattern as lib/auth/mfa-actions.ts's verifyMfaEnrollment) since account
 * creation has field-level validation errors to surface.
 */
export async function createPlatformAdminAccount(
  _prevState: CreatePlatformAdminAccountState,
  formData: FormData,
): Promise<CreatePlatformAdminAccountState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const result = await createPlatformAdminAccountForActor(context, {
    email,
    password,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/staff");
  return { ok: true };
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
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await grantPlatformPermissionForActor(
    context,
    targetUserId,
    capability,
  );
  if (result.ok) {
    revalidatePath("/platform/staff");
  }
  return result;
}

/** PLAN.md §4 server action name. See grantPlatformPermission above. */
export async function revokePlatformPermission(
  targetUserId: string,
  capability: string,
): Promise<{ ok: true } | { ok: false; error: StaffActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await revokePlatformPermissionForActor(
    context,
    targetUserId,
    capability,
  );
  if (result.ok) {
    revalidatePath("/platform/staff");
  }
  return result;
}
