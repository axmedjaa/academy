import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Sign-in email code rate limit (the automatic send at sign-in and every
 * "Resend code") — reuses lib/rate-limit.ts (no second rate-limiting
 * system). Keyed by userId, not IP: the pending-MFA cookie has already pinned down
 * exactly which account is mid-login, and the abuse case here (flooding
 * one account's inbox with codes) is the same shape as
 * lib/auth/email-change-rate-limit.ts's own userId-keyed limit.
 */
export async function checkMfaEmailOtpRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit(`mfa-email-otp:${userId}`, {
    maxAttempts: env.MFA_EMAIL_OTP_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds: env.MFA_EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
    failClosed: true,
  });
}
