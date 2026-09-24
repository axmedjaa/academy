import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * "Send/resend code to my email" rate limit for the MFA email-OTP login
 * method — reuses lib/rate-limit.ts (no second rate-limiting system), same
 * pattern as lib/auth/mfa-enrollment-rate-limit.ts. Keyed by userId, not
 * IP: resolveMfaFlowUserId/the pending-MFA cookie has already pinned down
 * exactly which account is mid-login, and the abuse case here (flooding
 * one account's inbox with codes) is the same shape as
 * lib/auth/email-change-rate-limit.ts's own userId-keyed limit.
 */
export async function checkMfaEmailOtpRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit(`mfa-email-otp:${userId}`, {
    maxAttempts: env.MFA_EMAIL_OTP_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds: env.MFA_EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
  });
}
