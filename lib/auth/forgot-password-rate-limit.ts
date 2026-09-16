import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Per-target-email rate limit for /forgot-password (PLAN.md Phase 0 security
 * considerations). Keyed by email, not IP — the abuse case here is flooding
 * one victim's inbox with reset links, which many IPs can do to one email;
 * an IP-based key wouldn't stop that (unlike /login's brute-force case).
 */
export async function checkForgotPasswordRateLimit(
  email: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`forgot-password:${email.toLowerCase()}`, {
    maxAttempts:
      env.FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds:
      env.FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
  });
}
