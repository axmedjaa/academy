"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { attemptSignIn, type ActionError } from "@/lib/auth/sign-in";
import {
  checkLoginAccountLock,
  checkLoginRateLimit,
  recordFailedLoginForAccount,
} from "@/lib/auth/login-rate-limit";
import { checkForgotPasswordRateLimit } from "@/lib/auth/forgot-password-rate-limit";
import {
  applyPasswordReset,
  issuePasswordResetToken,
  type ResetPasswordError,
} from "@/lib/auth/password-reset";
import { passwordSchema } from "@/lib/auth/password";
import { getPlatformRole, getPostLoginRedirectPath } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { checkSuspiciousLogin } from "@/lib/auth/suspicious-login";
import { getClientIp } from "@/lib/http/client-ip";
import { RETURN_PATH_COOKIE, returnPathCookieOptions, sanitizeReturnPath } from "@/lib/auth/return-path";
import { rateLimitMessage } from "@/lib/auth/rate-limit-message";
import {
  MFA_PENDING_COOKIE_NAME,
  createPendingMfaToken,
  pendingMfaCookieOptions,
} from "@/lib/auth/mfa-pending";
import {
  SESSION_COOKIE_NAME,
  createSession,
  revokeSession,
  sessionCookieOptions,
  validateSessionToken,
} from "@/lib/auth/session";

const signInSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

const resetPasswordSchema = z
  .object({
    token: z.string().min(1, "Missing reset token"),
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SignInError =
  | ActionError
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "RATE_LIMITED"; message: string };

export interface SignInState {
  ok: boolean;
  error?: SignInError;
}

export async function signIn(
  _prevState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const headerList = await headers();
  const ip = getClientIp(headerList);

  // Checked (and incremented) before any parsing/DB work, so a flood of
  // requests is rejected cheaply regardless of whether credentials are
  // even well-formed (PLAN.md: "Redis-backed rate limiting on /login").
  const rateLimit = await checkLoginRateLimit(ip);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: rateLimitMessage(rateLimit, "Too many attempts."),
      },
    };
  }

  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
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

  // Security audit SEC-M-02: per-account limit (failed attempts only),
  // checked before the password so a locked account costs no Argon2 work.
  // Same message as the IP limit, and applied to unknown emails too, so it
  // reveals nothing about which accounts exist.
  const accountLock = await checkLoginAccountLock(parsed.data.email);
  if (!accountLock.allowed) {
    return {
      ok: false,
      error: { code: "RATE_LIMITED", message: rateLimitMessage(accountLock, "Too many attempts.") },
    };
  }

  const result = await attemptSignIn(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    await recordFailedLoginForAccount(parsed.data.email);
    return { ok: false, error: result.error };
  }

  const cookieStore = await cookies();

  // MFA is mandatory for every platform role (security audit SEC-M-09:
  // platform admins can hold cross-academy capabilities, so a password alone
  // is not enough). Academy users (no platform role) sign in as before.
  const platformRole = await getPlatformRole(result.userId);

  if (platformRole) {
    const enrolled = await hasVerifiedMfaCredential(result.userId);

    // Neither branch issues a session yet: PLAN.md requires challengeMfa
    // "before issuing a session" once enrolled, and its "first login forces
    // enrollment before any platform action is possible" text applies the
    // same principle to the not-yet-enrolled case (see mfa-pending.ts).
    // Return-after-login is not carried through MFA; platform staff land
    // on their normal page. Drop any stored destination.
    cookieStore.delete({ name: RETURN_PATH_COOKIE, path: returnPathCookieOptions().path });

    const pendingToken = createPendingMfaToken(result.userId);
    cookieStore.set(
      MFA_PENDING_COOKIE_NAME,
      pendingToken,
      pendingMfaCookieOptions(),
    );

    redirect(enrolled ? "/mfa/challenge" : "/mfa/setup");
  }

  const userAgent = headerList.get("user-agent") ?? undefined;

  // Checked before the new session is created — it compares against prior
  // history (PLAN.md Phase 0 security considerations).
  await checkSuspiciousLogin(result.userId, { ip, userAgent, actorRole: platformRole });

  const { token } = await createSession(result.userId, { ip, userAgent });
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

  // Return-after-login (e.g. back to a staff invitation). Re-validated here:
  // only an allowlisted internal path is honored, anything else is ignored.
  // The destination page re-checks everything itself; nothing is accepted
  // automatically.
  const storedReturn = cookieStore.get(RETURN_PATH_COOKIE)?.value;
  if (storedReturn !== undefined) {
    cookieStore.delete({ name: RETURN_PATH_COOKIE, path: returnPathCookieOptions().path });
  }
  redirect(sanitizeReturnPath(storedReturn) ?? (await getPostLoginRedirectPath(result.userId)));
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    const session = await validateSessionToken(token);
    if (session) {
      await revokeSession(session.id);
    }
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}

export type ForgotPasswordError =
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "RATE_LIMITED"; message: string };

export interface ForgotPasswordState {
  ok: boolean;
  message?: string;
  error?: ForgotPasswordError;
}

// Always the same message whether or not the email exists (DESIGN.md
// §11.8) — this is the only success message requestPasswordReset ever
// returns.
const NEUTRAL_RESET_CONFIRMATION =
  "If that email exists, a reset link has been sent.";

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const parsed = forgotPasswordSchema.safeParse({
    email: formData.get("email"),
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

  // Keyed by the requested email (see forgot-password-rate-limit.ts) — this
  // reveals nothing about whether the email exists, since the same key is
  // used regardless of whether it belongs to a real account.
  const rateLimit = await checkForgotPasswordRateLimit(parsed.data.email);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: rateLimitMessage(rateLimit, "Too many requests."),
      },
    };
  }

  await issuePasswordResetToken(parsed.data.email);

  return { ok: true, message: NEUTRAL_RESET_CONFIRMATION };
}

export type ResetPasswordFormError =
  | ResetPasswordError
  | { code: "VALIDATION_ERROR"; message: string };

export interface ResetPasswordState {
  ok: boolean;
  error?: ResetPasswordFormError;
}

export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const parsed = resetPasswordSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
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

  const result = await applyPasswordReset(
    parsed.data.token,
    parsed.data.password,
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  redirect("/login");
}
