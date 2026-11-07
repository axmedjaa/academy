import { checkRateLimit, clearRateLimit, refundRateLimit, type RateLimitOptions, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

/**
 * Sign-in rate limits (PLAN.md Phase 0 security considerations; security
 * audit SEC-M-02 / SEC-M-03). Both limits count FAILED sign-ins only, using
 * reserve-then-refund so they stay exact under parallel requests:
 *
 *   1. every attempt reserves one slot with an atomic increment, so a burst
 *      of parallel guesses can never get past the limit before any is
 *      counted;
 *   2. when the password turns out to be correct, the slot is handed back
 *      (per IP) and the account's failures are cleared.
 *
 * Both fail closed while Redis is unavailable (SEC-M-03).
 */

const DEFAULT_IP_MAX_FAILURES = 20;
const DEFAULT_IP_WINDOW_SECONDS = 15 * 60;

/** Per client IP. Generous enough for staff sharing one office IP; floods
 * are what it's for — targeted guessing is the account limit's job. */
export function loginIpLimit(): RateLimitOptions {
  return {
    maxAttempts: env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_IP_MAX_FAILURES,
    windowSeconds: env.LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_IP_WINDOW_SECONDS,
    failClosed: true,
  };
}

/**
 * Per account (SEC-M-02): stops guesses spread across many IPs. Keyed by the
 * normalised email as typed, whether or not an account exists, so a lockout
 * reveals nothing about which emails are registered.
 */
export const LOGIN_ACCOUNT_LIMIT: RateLimitOptions = {
  maxAttempts: 10,
  windowSeconds: 60 * 60,
  failClosed: true,
};

export function loginIpKey(ip: string): string {
  return `login:${ip}`;
}

export function loginAccountKey(email: string): string {
  return `login-account:${email.trim().toLowerCase()}`;
}

/** Reserves one sign-in attempt for this IP. */
export async function reserveLoginIpAttempt(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(loginIpKey(ip), loginIpLimit());
}

/** Hands back the IP's reserved attempt: the sign-in did not fail. */
export async function refundLoginIpAttempt(ip: string): Promise<void> {
  await refundRateLimit(loginIpKey(ip));
}

/** Reserves one sign-in attempt for this account. */
export async function reserveLoginAccountAttempt(email: string): Promise<RateLimitResult> {
  return checkRateLimit(loginAccountKey(email), LOGIN_ACCOUNT_LIMIT);
}

/** A correct password: the account's failure count starts again from zero. */
export async function clearLoginAccountFailures(email: string): Promise<void> {
  await clearRateLimit(loginAccountKey(email));
}
