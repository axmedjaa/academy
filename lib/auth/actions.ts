"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { attemptSignIn, type ActionError } from "@/lib/auth/sign-in";
import { checkLoginRateLimit } from "@/lib/auth/login-rate-limit";
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

// Trusts the first `x-forwarded-for` entry as the client IP. Production
// deployment assumes a trusted reverse proxy/load balancer sets (and
// overwrites, never appends to) this header — direct/untrusted access to
// the app must not be allowed to reach it, or a caller could spoof this
// value to evade rate limiting.
function getClientIp(headerList: {
  get(name: string): string | null;
}): string | undefined {
  return headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
}

export async function signIn(
  _prevState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const headerList = await headers();
  const ip = getClientIp(headerList) ?? "unknown";

  // Checked (and incremented) before any parsing/DB work, so a flood of
  // requests is rejected cheaply regardless of whether credentials are
  // even well-formed (PLAN.md: "Redis-backed rate limiting on /login").
  const rateLimit = await checkLoginRateLimit(ip);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: `Too many attempts. Try again in ${rateLimit.retryAfterSeconds}s.`,
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

  const result = await attemptSignIn(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const cookieStore = await cookies();

  // MFA is mandatory for platform_owner only (PLAN.md Phase 0 "Permissions
  // needed") — every other role (including no platform role at all) signs
  // in exactly as before Item 14.
  const platformRole = await getPlatformRole(result.userId);

  if (platformRole === "platform_owner") {
    const enrolled = await hasVerifiedMfaCredential(result.userId);

    // Neither branch issues a session yet: PLAN.md requires challengeMfa
    // "before issuing a session" once enrolled, and its "first login forces
    // enrollment before any platform action is possible" text applies the
    // same principle to the not-yet-enrolled case (see mfa-pending.ts).
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

  redirect(await getPostLoginRedirectPath(result.userId));
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
        message: `Too many requests. Try again in ${rateLimit.retryAfterSeconds}s.`,
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
