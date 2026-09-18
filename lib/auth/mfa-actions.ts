"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  enrollMfaForUser,
  regenerateRecoveryCodesForUser,
  verifyMfaChallenge,
  verifyMfaEnrollmentForUser,
  type EnrollMfaResult,
  type MfaChallengeError,
  type RegenerateRecoveryCodesError,
  type VerifyMfaEnrollmentError,
} from "@/lib/auth/mfa";
import { resolveMfaFlowUserId } from "@/lib/auth/mfa-flow-identity";
import {
  MFA_PENDING_COOKIE_NAME,
  verifyPendingMfaToken,
} from "@/lib/auth/mfa-pending";
import { checkMfaChallengeRateLimit } from "@/lib/auth/mfa-challenge-rate-limit";
import { checkMfaEnrollmentRateLimit } from "@/lib/auth/mfa-enrollment-rate-limit";
import { checkSuspiciousLogin } from "@/lib/auth/suspicious-login";
import {
  SESSION_COOKIE_NAME,
  createSession,
  sessionCookieOptions,
} from "@/lib/auth/session";

function getClientIp(headerList: {
  get(name: string): string | null;
}): string | undefined {
  return headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
}

/**
 * Only ever reached for a platform_owner (Item 14: this path is taken only
 * from the pending-MFA-cookie branches, which signIn only creates for
 * platform_owner accounts) — actorRole is hardcoded rather than re-queried.
 */
async function completeLoginSession(userId: string): Promise<void> {
  const headerList = await headers();
  const ip = getClientIp(headerList);
  const userAgent = headerList.get("user-agent") ?? undefined;

  await checkSuspiciousLogin(userId, {
    ip,
    userAgent,
    actorRole: "platform_owner",
  });

  const { token } = await createSession(userId, { ip, userAgent });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  cookieStore.delete(MFA_PENDING_COOKIE_NAME);
}

export async function enrollMfa(): Promise<EnrollMfaResult> {
  const userId = await resolveMfaFlowUserId();
  if (!userId) {
    redirect("/login");
  }

  return enrollMfaForUser(userId);
}

const verifyMfaEnrollmentSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
});

export type VerifyMfaEnrollmentFormError =
  | VerifyMfaEnrollmentError
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "RATE_LIMITED"; message: string };

export interface VerifyMfaEnrollmentState {
  ok: boolean;
  recoveryCodes?: string[];
  error?: VerifyMfaEnrollmentFormError;
}

export async function verifyMfaEnrollment(
  _prevState: VerifyMfaEnrollmentState,
  formData: FormData,
): Promise<VerifyMfaEnrollmentState> {
  const userId = await resolveMfaFlowUserId();
  if (!userId) {
    redirect("/login");
  }

  // Security finding #6: rate limit repeated TOTP enrollment-verification
  // attempts, keyed by userId (see lib/auth/mfa-enrollment-rate-limit.ts —
  // this is an already-identified, signed-in account action, unlike
  // challengeMfa's pre-auth IP key below). Mirrors challengeMfa's own
  // rate-limit check/rejection shape exactly. Never logs the code itself.
  const rateLimit = await checkMfaEnrollmentRateLimit(userId);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: `Too many attempts. Try again in ${rateLimit.retryAfterSeconds}s.`,
      },
    };
  }

  const parsed = verifyMfaEnrollmentSchema.safeParse({
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

  const result = await verifyMfaEnrollmentForUser(userId, parsed.data.code);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Completing enrollment includes proving a valid code, which is exactly
  // what a challenge would have required — so if this was the forced
  // first-login flow (pending cookie present), it's equivalent to a
  // successful challenge: issue the real session now.
  const cookieStore = await cookies();
  if (cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value) {
    await completeLoginSession(userId);
  }

  return { ok: true, recoveryCodes: result.recoveryCodes };
}

const challengeMfaSchema = z.object({
  mode: z.enum(["totp", "recovery"]),
  code: z.string().trim().min(1, "Enter a code"),
});

export type ChallengeMfaError =
  | MfaChallengeError
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "RATE_LIMITED"; message: string };

export interface ChallengeMfaState {
  ok: boolean;
  error?: ChallengeMfaError;
}

export async function challengeMfa(
  _prevState: ChallengeMfaState,
  formData: FormData,
): Promise<ChallengeMfaState> {
  const headerList = await headers();
  const ip = getClientIp(headerList) ?? "unknown";

  const rateLimit = await checkMfaChallengeRateLimit(ip);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: `Too many attempts. Try again in ${rateLimit.retryAfterSeconds}s.`,
      },
    };
  }

  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  const pending = pendingToken ? verifyPendingMfaToken(pendingToken) : null;

  if (!pending) {
    redirect("/login");
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
  redirect("/");
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
 * Item 15. Requires a real, already-authenticated session (unlike
 * enrollMfa/verifyMfaEnrollment, this is a post-login account-management
 * action, not part of signing in) plus password re-confirmation —
 * DESIGN.md §7: "re-confirmation required" (method unspecified there;
 * password re-entry is the standard pattern for a sensitive
 * account-security action and doesn't force redundant TOTP re-entry from
 * someone who just used it to sign in).
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
