/**
 * Security audit SEC-M-02 / SEC-M-03. Uses the test Redis from .env.local
 * (like lib/rate-limit.test.ts); an outage is simulated by making the real
 * client's commands reject, which is how a refused connection or timeout
 * reaches the limiter.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/lib/redis";
import { checkRateLimit, peekRateLimit } from "@/lib/rate-limit";
import type { MonitoringSink } from "@/lib/monitoring/monitor";
import { checkForgotPasswordRateLimit } from "./forgot-password-rate-limit";
import {
  checkLoginAccountLock,
  checkLoginRateLimit,
  LOGIN_ACCOUNT_LIMIT,
  recordFailedLoginForAccount,
} from "./login-rate-limit";
import { checkMfaChallengeRateLimit, checkMfaChallengeUserRateLimit, MFA_CHALLENGE_USER_LIMIT } from "./mfa-challenge-rate-limit";
import { checkMfaEmailOtpRateLimit } from "./mfa-email-otp-rate-limit";
import { checkMfaEnrollmentRateLimit } from "./mfa-enrollment-rate-limit";
import { rateLimitMessage } from "./rate-limit-message";

const quietSink: MonitoringSink = { recordEvent: () => undefined, recordMetric: () => undefined };
const keys: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.length) await redis.del(...keys.splice(0).map((k) => `ratelimit:${k}`));
});

function redisDown() {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" });
  vi.spyOn(redis, "incr").mockRejectedValue(refused());
  vi.spyOn(redis, "get").mockRejectedValue(refused());
}

describe("SEC-M-03: authentication limiters fail closed while Redis is down", () => {
  it("login, MFA challenge, MFA email OTP, MFA enrollment and password reset all deny", async () => {
    redisDown();
    const id = randomUUID();
    const results = [
      await checkLoginRateLimit(`ip-${id}`),
      await checkLoginAccountLock(`${id}@example.com`),
      await checkMfaChallengeRateLimit(`ip-${id}`),
      await checkMfaChallengeUserRateLimit(id),
      await checkMfaEmailOtpRateLimit(id),
      await checkMfaEnrollmentRateLimit(id),
      await checkForgotPasswordRateLimit(`${id}@example.com`),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ allowed: false, unavailable: true });
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("a low-risk limiter (default options, e.g. the contact form) still fails open", async () => {
    redisDown();
    const result = await checkRateLimit(`contact-form:ip:${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, quietSink);
    expect(result.allowed).toBe(true);
  });

  it("the outage denial tells the user to retry shortly, not that they made too many attempts", () => {
    expect(rateLimitMessage({ allowed: false, remaining: 0, retryAfterSeconds: 30, unavailable: true }, "Too many attempts.")).toBe(
      "This is temporarily unavailable. Please try again in a moment.",
    );
    expect(rateLimitMessage({ allowed: false, remaining: 0, retryAfterSeconds: 120 }, "Too many attempts.")).toMatch(/^Too many attempts\. Please try again in /);
  });

  it("works again as soon as Redis is back", async () => {
    redisDown();
    const ip = `ip-${randomUUID()}`;
    keys.push(`login:${ip}`);
    expect((await checkLoginRateLimit(ip)).allowed).toBe(false);
    vi.restoreAllMocks();
    expect((await checkLoginRateLimit(ip)).allowed).toBe(true);
  });
});

describe("SEC-M-02: per-account login limit (failed attempts only)", { timeout: 60_000 }, () => {
  it("locks an email after the failure limit, whatever IP the attempts come from", async () => {
    const email = `victim-${randomUUID()}@example.com`;
    keys.push(`login-account:${email}`);
    // Each failure would come from a different IP; the account key ignores IP.
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) {
      expect((await checkLoginAccountLock(email)).allowed).toBe(true);
      await recordFailedLoginForAccount(email);
    }
    const locked = await checkLoginAccountLock(email);
    expect(locked.allowed).toBe(false);
    expect(locked.unavailable).toBeUndefined();
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is case- and whitespace-insensitive, and checking alone never counts", async () => {
    const email = `Mixed-${randomUUID()}@Example.com`;
    keys.push(`login-account:${email.toLowerCase()}`);
    for (let i = 0; i < 5; i += 1) await checkLoginAccountLock(email);
    expect((await peekRateLimit(`login-account:${email.toLowerCase()}`, LOGIN_ACCOUNT_LIMIT)).remaining).toBe(LOGIN_ACCOUNT_LIMIT.maxAttempts);
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) await recordFailedLoginForAccount(`  ${email.toUpperCase()} `);
    expect((await checkLoginAccountLock(email.toLowerCase())).allowed).toBe(false);
  });

  it("one account's lock doesn't affect another", async () => {
    const a = `a-${randomUUID()}@example.com`;
    const b = `b-${randomUUID()}@example.com`;
    keys.push(`login-account:${a}`, `login-account:${b}`);
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) await recordFailedLoginForAccount(a);
    expect((await checkLoginAccountLock(a)).allowed).toBe(false);
    expect((await checkLoginAccountLock(b)).allowed).toBe(true);
  });
});

describe("SEC-M-02: per-user MFA challenge limit", { timeout: 60_000 }, () => {
  it("trips for a user after the limit, independent of IP", async () => {
    const userId = randomUUID();
    keys.push(`mfa-challenge-user:${userId}`);
    for (let i = 0; i < MFA_CHALLENGE_USER_LIMIT.maxAttempts; i += 1) {
      expect((await checkMfaChallengeUserRateLimit(userId)).allowed).toBe(true);
    }
    expect((await checkMfaChallengeUserRateLimit(userId)).allowed).toBe(false);
    keys.push(`mfa-challenge-user:${randomUUID()}`);
    expect((await checkMfaChallengeUserRateLimit(keys[keys.length - 1].slice("mfa-challenge-user:".length))).allowed).toBe(true);
  });
});
