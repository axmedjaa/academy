import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Security finding #6: rate limit for verifyMfaEnrollmentForUser (TOTP
 * enrollment verification), mirroring lib/auth/mfa-challenge-rate-limit.ts's
 * pattern over the same generic lib/rate-limit.ts primitive.
 *
 * Deliberately keyed by `userId`, NOT by IP like /login, /forgot-password,
 * and /mfa/challenge are. Those three are pre-authentication endpoints
 * where the caller isn't a known account yet, so IP is the only identifier
 * available and is the right "guess a short code repeatedly" attack shape
 * to throttle. Enrollment verification is different: it only ever runs for
 * an already-identified, signed-in (or mid-login-flow, already-authenticated
 * with a resolved userId) account — resolveMfaFlowUserId() has already
 * pinned down exactly which user is attempting this. Keying by userId
 * throttles that specific account's repeated guesses without the side
 * effect an IP key would have: one user's repeated attempts accidentally
 * rate-limiting a completely different signed-in user behind the same IP
 * (e.g. NAT, a shared office network, campus Wi-Fi).
 *
 * Thresholds mirror checkMfaChallengeRateLimit's own defaults (5 attempts /
 * 15 minutes) — a 6-digit TOTP code with normal clock-drift tolerance
 * (window: 1, i.e. ±30s) has the same brute-force shape as the login-time
 * challenge, so the same conservative-but-not-overly-strict threshold
 * applies here.
 */
export async function checkMfaEnrollmentRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`mfa-enrollment:${userId}`, {
    maxAttempts:
      env.MFA_ENROLLMENT_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds:
      env.MFA_ENROLLMENT_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
  });
}
