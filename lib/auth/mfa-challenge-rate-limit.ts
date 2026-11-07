import { checkRateLimit, type RateLimitOptions, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Per-client-IP rate limit for /mfa/challenge (PLAN.md Phase 0 security
 * considerations names this as one of three rate-limited endpoints,
 * alongside /login and /forgot-password). Keyed by IP like /login — this
 * is a "guess a short code repeatedly" attack shape, not the "flood one
 * victim" shape /forgot-password guards against.
 */
export async function checkMfaChallengeRateLimit(
  ip: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`mfa-challenge:${ip}`, {
    maxAttempts:
      env.MFA_CHALLENGE_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds:
      env.MFA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
    failClosed: true,
  });
}

/**
 * Security audit SEC-M-02: per-user limit on MFA challenge attempts, so an
 * attacker who has the password can't spread code guesses across many IPs.
 * Counts every attempt for that user (successful ones end the challenge).
 */
export const MFA_CHALLENGE_USER_LIMIT: RateLimitOptions = {
  maxAttempts: 10,
  windowSeconds: 15 * 60,
  failClosed: true,
};

export async function checkMfaChallengeUserRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit(`mfa-challenge-user:${userId}`, MFA_CHALLENGE_USER_LIMIT);
}
