"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { getAuthContext, getPlatformRole, getPostLoginRedirectPath } from "@/lib/auth/auth-context";
import {
  regenerateRecoveryCodesForUser,
  verifyMfaChallenge,
  type MfaChallengeError,
  type RegenerateRecoveryCodesError,
} from "@/lib/auth/mfa";
import { sendMfaEmailOtp } from "@/lib/auth/mfa-email-otp";
import {
  MFA_PENDING_COOKIE_NAME,
  verifyPendingMfaToken,
} from "@/lib/auth/mfa-pending";
import { checkMfaChallengeRateLimit, checkMfaChallengeUserRateLimit } from "@/lib/auth/mfa-challenge-rate-limit";
import { checkSuspiciousLogin } from "@/lib/auth/suspicious-login";
import { getClientIp } from "@/lib/http/client-ip";
import { rateLimitMessage } from "@/lib/auth/rate-limit-message";
import {
  SESSION_COOKIE_NAME,
  createSession,
  sessionCookieOptions,
} from "@/lib/auth/session";

/**
 * Only reached from the pending-MFA-cookie branch, which signIn creates
 * for platform staff (every platform role since SEC-M-09). The role is
 * looked up rather than assumed, for the suspicious-login record.
 */
async function completeLoginSession(userId: string): Promise<void> {
  const headerList = await headers();
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;

  await checkSuspiciousLogin(userId, {
    ip,
    userAgent,
    actorRole: (await getPlatformRole(userId)) ?? undefined,
  });

  const { token } = await createSession(userId, { ip, userAgent });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  cookieStore.delete(MFA_PENDING_COOKIE_NAME);
}

/** The emailed code is exactly six digits; a recovery code is XXXXX-XXXXX. */
const challengeMfaSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("email"),
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
  }),
  z.object({
    mode: z.literal("recovery"),
    code: z.string().trim().min(1, "Enter a recovery code"),
  }),
]);

export type ChallengeMfaError =
  | MfaChallengeError
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "RATE_LIMITED"; message: string };

export interface ChallengeMfaState {
  ok: boolean;
  error?: ChallengeMfaError;
}

/**
 * The second sign-in step. No session exists until this succeeds: the
 * signed, short-lived pending-MFA cookie (set by signIn after a correct
 * password) is the only thing that identifies the account here.
 */
export async function challengeMfa(
  _prevState: ChallengeMfaState,
  formData: FormData,
): Promise<ChallengeMfaState> {
  const headerList = await headers();
  const ip = getClientIp(headerList);

  const rateLimit = await checkMfaChallengeRateLimit(ip);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: rateLimitMessage(rateLimit, "Too many attempts."),
      },
    };
  }

  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  const pending = pendingToken ? verifyPendingMfaToken(pendingToken) : null;

  if (!pending) {
    redirect("/login");
  }

  // Security audit SEC-M-02: per-user limit too, so guesses spread across
  // many IPs still stop for this account.
  const userLimit = await checkMfaChallengeUserRateLimit(pending.userId);
  if (!userLimit.allowed) {
    return {
      ok: false,
      error: { code: "RATE_LIMITED", message: rateLimitMessage(userLimit, "Too many attempts.") },
    };
  }

  const parsed = challengeMfaSchema.safeParse({
    mode: formData.get("mode"),
    code: formData.get("code"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const result = await verifyMfaChallenge(
    pending.userId,
    parsed.data.mode,
    parsed.data.code,
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  await completeLoginSession(pending.userId);
  redirect(await getPostLoginRedirectPath(pending.userId));
}

export interface SendMfaEmailOtpState {
  ok: boolean;
  /** Seconds until "Resend code" is available again. */
  resendAvailableInSeconds?: number;
  error?: { code: string; message: string; retryAfterSeconds?: number };
}

/**
 * "Resend code" on /mfa/challenge (the first code is sent by signIn). A
 * plain callable bound via useTransition. Reads the pending-MFA cookie
 * directly, like challengeMfa: this is only ever part of signing in.
 */
export async function sendMfaEmailOtpAction(): Promise<SendMfaEmailOtpState> {
  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  const pending = pendingToken ? verifyPendingMfaToken(pendingToken) : null;

  if (!pending) {
    redirect("/login");
  }

  const result = await sendMfaEmailOtp(pending.userId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, resendAvailableInSeconds: result.resendAvailableInSeconds };
}

const regenerateRecoveryCodesSchema = z.object({
  password: z.string().min(1, "Enter your password"),
});

export type RegenerateRecoveryCodesFormError =
  | RegenerateRecoveryCodesError
  | { code: "INVALID_PASSWORD"; message: string }
  | { code: "VALIDATION_ERROR"; message: string };

export interface RegenerateRecoveryCodesState {
  ok: boolean;
  recoveryCodes?: string[];
  error?: RegenerateRecoveryCodesFormError;
}

/**
 * Item 15. Requires a real, already-authenticated session (a post-login
 * account-management action, not part of signing in) plus password
 * re-confirmation —
 * DESIGN.md §7: "re-confirmation required" (method unspecified there;
 * password re-entry is the standard pattern for a sensitive
 * account-security action and doesn't send another email code to
 * someone who just used one to sign in).
 */
export async function regenerateRecoveryCodes(
  _prevState: RegenerateRecoveryCodesState,
  formData: FormData,
): Promise<RegenerateRecoveryCodesState> {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const parsed = regenerateRecoveryCodesSchema.safeParse({
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, context.userId))
    .limit(1);

  const validPassword =
    user && (await verifyPassword(user.passwordHash, parsed.data.password));

  if (!validPassword) {
    return {
      ok: false,
      error: { code: "INVALID_PASSWORD", message: "Incorrect password." },
    };
  }

  const result = await regenerateRecoveryCodesForUser(context.userId);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, recoveryCodes: result.recoveryCodes };
}
