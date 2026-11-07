import { checkRateLimit, peekRateLimit, type RateLimitOptions, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/** Per-client-IP rate limit for /login (PLAN.md Phase 0 security considerations). */
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(`login:${ip}`, {
    maxAttempts: env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds:
      env.LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
    failClosed: true,
  });
}

/**
 * Security audit SEC-M-02: a per-account limit alongside the per-IP one, so
 * guesses spread across many IPs (a botnet) still stop. Only FAILED attempts
 * count: `checkLoginAccountLock` peeks before the password is checked, and
 * `recordFailedLoginForAccount` counts a failure afterwards. Keyed by the
 * normalised email as typed, whether or not an account exists, so a lockout
 * reveals nothing about which emails are registered.
 */
export const LOGIN_ACCOUNT_LIMIT: RateLimitOptions = {
  maxAttempts: 10,
  windowSeconds: 60 * 60,
  failClosed: true,
};

function accountKey(email: string): string {
  return `login-account:${email.trim().toLowerCase()}`;
}

export async function checkLoginAccountLock(email: string): Promise<RateLimitResult> {
  return peekRateLimit(accountKey(email), LOGIN_ACCOUNT_LIMIT);
}

export async function recordFailedLoginForAccount(email: string): Promise<RateLimitResult> {
  return checkRateLimit(accountKey(email), LOGIN_ACCOUNT_LIMIT);
}
