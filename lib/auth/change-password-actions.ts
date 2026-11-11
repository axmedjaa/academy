"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPasswordChangeSession, getPlatformRole, getPostLoginRedirectPath } from "@/lib/auth/auth-context";
import { changeTemporaryPassword, type ChangeTemporaryPasswordError } from "@/lib/auth/change-password";
import { getClientIp } from "@/lib/http/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitMessage } from "@/lib/auth/rate-limit-message";
import { SESSION_COOKIE_NAME, createSession, sessionCookieOptions } from "@/lib/auth/session";

/**
 * /change-password's form action. A server action posted from the page, so
 * Next.js's Origin check applies (CSRF). The only action a session holding
 * a temporary password can use: it resolves the session through
 * getPasswordChangeSession, which accepts nothing else, while every other
 * action's getAuthContext refuses this session.
 */

export type ChangePasswordFormError = ChangeTemporaryPasswordError | { code: "RATE_LIMITED"; message: string; field?: undefined };

export interface ChangePasswordFormState {
  ok: boolean;
  error?: ChangePasswordFormError;
}

/** Bounds password guesses and Argon2 work per account. Same budget as the
 * per-account sign-in limit's default window. */
const CHANGE_PASSWORD_RATE_LIMIT = { maxAttempts: 10, windowSeconds: 15 * 60 };

export async function changeTemporaryPasswordAction(
  _prevState: ChangePasswordFormState,
  formData: FormData,
): Promise<ChangePasswordFormState> {
  const pending = await getPasswordChangeSession();
  if (!pending) redirect("/login");

  const limit = await checkRateLimit(`change-temp-password:${pending.userId}`, CHANGE_PASSWORD_RATE_LIMIT);
  if (!limit.allowed) {
    return { ok: false, error: { code: "RATE_LIMITED", message: rateLimitMessage(limit, "Too many attempts.") } };
  }

  const result = await changeTemporaryPassword(pending.userId, {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });

  const cookieStore = await cookies();
  if (!result.ok) {
    if (result.error.code === "NOT_REQUIRED") {
      cookieStore.delete(SESSION_COOKIE_NAME);
      redirect("/login");
    }
    return { ok: false, error: result.error };
  }

  // Every earlier session (including this one) was revoked. Platform staff
  // need MFA before any session (lib/auth/actions.ts signIn), so they sign
  // in again; directly created staff accounts never hold a platform role,
  // and this only guards against that ever changing.
  cookieStore.delete(SESSION_COOKIE_NAME);
  if (await getPlatformRole(pending.userId)) redirect("/login?passwordChanged=1");

  // Academy staff have just proven both passwords: one fresh session.
  const headerList = await headers();
  const { token } = await createSession(pending.userId, {
    ip: getClientIp(headerList),
    userAgent: headerList.get("user-agent") ?? undefined,
  });
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  redirect(await getPostLoginRedirectPath(pending.userId));
}
