"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext, getCurrentSessionId } from "@/lib/auth/auth-context";
import { revokeAllOtherSessionsForUser } from "@/lib/auth/session";
import {
  changeOwnPassword as changeOwnPasswordForActor,
  updateOwnAccount as updateOwnAccountForActor,
  updateOwnEmail as updateOwnEmailForActor,
  type UpdateAccountActionError,
} from "@/lib/auth/update-account";

const UNAUTHENTICATED: UpdateAccountActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface UpdateEmailState {
  ok: boolean;
  error?: UpdateAccountActionError;
  email?: string;
}

/** Form-bound via useActionState for /account/security's "Change email" form. */
export async function updateOwnEmail(
  _prevState: UpdateEmailState,
  formData: FormData,
): Promise<UpdateEmailState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateOwnEmailForActor(context, {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newEmail: String(formData.get("newEmail") ?? ""),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/account/security");
  return { ok: true, email: result.email };
}

export interface ChangePasswordState {
  ok: boolean;
  error?: UpdateAccountActionError;
}

/** Form-bound via useActionState for /account/security's "Change password" form. */
export async function changeOwnPassword(
  _prevState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await changeOwnPasswordForActor(context, {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Security: once the password actually changes, sign every other session
  // out — the same helper the page's own "Sign out of all other sessions"
  // button calls (lib/auth/session-actions.ts's revokeAllOtherSessions) —
  // so a session token issued under the old password stops working
  // immediately rather than staying valid until it expires on its own.
  const currentSessionId = await getCurrentSessionId();
  if (currentSessionId) {
    await revokeAllOtherSessionsForUser(context.userId, currentSessionId);
  }

  revalidatePath("/account/security");
  return { ok: true };
}

export interface UpdateAccountState {
  ok: boolean;
  error?: UpdateAccountActionError;
  email?: string;
  passwordChanged?: boolean;
}

/**
 * The unified "Account" form's single action — /account/security's own
 * simplified page (one form, one current-password field, either or both of
 * new email/new password). Delegates to `updateOwnAccount`
 * (lib/auth/update-account.ts), which itself calls the original
 * `updateOwnEmail`/`changeOwnPassword` functions above — this file's other
 * two actions are kept as-is (and still covered by their own tests), not
 * removed, so nothing that already worked stops working.
 */
export async function updateOwnAccount(
  _prevState: UpdateAccountState,
  formData: FormData,
): Promise<UpdateAccountState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await updateOwnAccountForActor(context, {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newEmail: String(formData.get("newEmail") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (result.passwordChanged) {
    const currentSessionId = await getCurrentSessionId();
    if (currentSessionId) {
      await revokeAllOtherSessionsForUser(context.userId, currentSessionId);
    }
  }

  revalidatePath("/account/security");
  return { ok: true, email: result.email, passwordChanged: result.passwordChanged };
}
