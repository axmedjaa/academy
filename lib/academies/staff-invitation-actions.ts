"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getClientIp } from "@/lib/http/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { acceptStaffInvitation, acceptStaffInvitationWithNewAccount } from "@/lib/academies/staff-invitations";
import {
  RETURN_PATH_COOKIE,
  isWellFormedInvitationToken,
  returnPathCookieOptions,
  sanitizeReturnPath,
} from "@/lib/auth/return-path";

/**
 * Staff-invitation acceptance (SEC-H-01). Both actions are form posts from
 * /staff-invitation, so Next.js's server-action Origin check applies (CSRF).
 * The token travels in the form body, never in a log line.
 */

export interface AcceptInvitationState {
  ok: boolean;
  error?: string;
}

/** Existing account: the signed-in user accepts an invitation addressed to their own email. */
export async function acceptStaffInvitationAction(_prev: AcceptInvitationState, formData: FormData): Promise<AcceptInvitationState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: "Sign in to accept this invitation." };

  const result = await acceptStaffInvitation(context, String(formData.get("token") ?? ""));
  if (!result.ok) return { ok: false, error: result.error.message };
  redirect("/academy/dashboard");
}

/** New account: the invited person chooses their own password. */
export async function createAccountAndAcceptInvitationAction(_prev: AcceptInvitationState, formData: FormData): Promise<AcceptInvitationState> {
  // Bounds Argon2 hashing work per client; tokens themselves are 256-bit.
  const ip = getClientIp(await headers());
  const limit = await checkRateLimit(`staff-invite-accept:${ip}`, { maxAttempts: 20, windowSeconds: 900 });
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Try again later." };

  const password = String(formData.get("password") ?? "");
  if (password !== String(formData.get("confirmPassword") ?? "")) {
    return { ok: false, error: "Passwords do not match." };
  }
  const result = await acceptStaffInvitationWithNewAccount(String(formData.get("token") ?? ""), password);
  if (!result.ok) return { ok: false, error: result.error.message };
  redirect("/login?invited=1");
}

/**
 * "Sign in to accept" for an existing account: remembers this invitation page
 * in an httpOnly cookie scoped to /login, then opens the sign-in page. After
 * signing in, `signIn` returns here; the page re-checks the invitation and
 * the account, and the person must still press Accept.
 */
export async function beginInvitationSignIn(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const target = isWellFormedInvitationToken(token) ? sanitizeReturnPath(`/staff-invitation?token=${token}`) : null;
  if (target) {
    (await cookies()).set(RETURN_PATH_COOKIE, target, returnPathCookieOptions());
  }
  redirect("/login?continue=invitation");
}
