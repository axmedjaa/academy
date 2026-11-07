/**
 * Security audit SEC-M-02 / SEC-M-03 / SEC-L-06. Uses the test Redis from
 * .env.local (like lib/rate-limit.test.ts), under the "vitest" key namespace
 * (vitest.config.ts) so nothing here counts against a developer's own
 * server. An outage is simulated by making the real client's commands
 * reject, which is how a refused connection or timeout reaches the limiter.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/lib/redis";
import { checkRateLimit, rateLimitRedisKey } from "@/lib/rate-limit";
import type { MonitoringSink } from "@/lib/monitoring/monitor";
import { checkForgotPasswordRateLimit } from "./forgot-password-rate-limit";
import {
  clearLoginAccountFailures,
  LOGIN_ACCOUNT_LIMIT,
  loginAccountKey,
  loginIpKey,
  loginIpLimit,
  refundLoginIpAttempt,
  reserveLoginAccountAttempt,
  reserveLoginIpAttempt,
} from "./login-rate-limit";
import { checkMfaChallengeRateLimit, checkMfaChallengeUserRateLimit, MFA_CHALLENGE_USER_LIMIT } from "./mfa-challenge-rate-limit";
import { checkMfaEmailOtpRateLimit } from "./mfa-email-otp-rate-limit";
import { checkMfaEnrollmentRateLimit } from "./mfa-enrollment-rate-limit";
import { rateLimitMessage } from "./rate-limit-message";

const quietSink: MonitoringSink = { recordEvent: () => undefined, recordMetric: () => undefined };
const keys: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.length) await redis.del(...keys.splice(0).map(rateLimitRedisKey));
});

function redisDown() {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" });
  vi.spyOn(redis, "eval").mockRejectedValue(refused());
}

const counterOf = async (key: string) => {
  const raw = await redis.get(rateLimitRedisKey(key));
  return raw === null ? 0 : Number(raw);
};

describe("rate-limit keys", () => {
  it("are namespaced under test runners, so test traffic never shares a developer server's counters", () => {
    expect(process.env.RATE_LIMIT_NAMESPACE).toBe("vitest");
    expect(rateLimitRedisKey("login:unknown")).toBe("ratelimit:vitest:login:unknown");
  });

  it("account keys are per normalised email; IP keys per IP", () => {
    expect(loginAccountKey("  Someone@Example.COM ")).toBe("login-account:someone@example.com");
    expect(loginAccountKey("a@example.com")).not.toBe(loginAccountKey("b@example.com"));
    expect(loginIpKey("203.0.113.9")).toBe("login:203.0.113.9");
  });
});

describe("SEC-L-06: counters always expire", { timeout: 60_000 }, () => {
  it("a new counter gets the window as its expiry", async () => {
    const key = `ttl-${randomUUID()}`;
    keys.push(key);
    await checkRateLimit(key, { maxAttempts: 5, windowSeconds: 120 }, quietSink);
    const ttl = await redis.ttl(rateLimitRedisKey(key));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("a counter left without an expiry is repaired by the next increment", async () => {
    const key = `ttl-${randomUUID()}`;
    keys.push(key);
    await redis.set(rateLimitRedisKey(key), "3"); // no expiry: the old failure mode
    expect(await redis.ttl(rateLimitRedisKey(key))).toBe(-1);
    const result = await checkRateLimit(key, { maxAttempts: 5, windowSeconds: 120 }, quietSink);
    expect(result.remaining).toBe(1);
    expect(await redis.ttl(rateLimitRedisKey(key))).toBeGreaterThan(0);
  });

  it("a refund never creates a counter, and removes one that reaches zero", async () => {
    const ip = `ip-${randomUUID()}`;
    keys.push(loginIpKey(ip));
    await refundLoginIpAttempt(ip);
    expect(await redis.exists(rateLimitRedisKey(loginIpKey(ip)))).toBe(0);
    await reserveLoginIpAttempt(ip);
    await refundLoginIpAttempt(ip);
    expect(await redis.exists(rateLimitRedisKey(loginIpKey(ip)))).toBe(0);
  });
});

describe("SEC-M-03: authentication limiters fail closed while Redis is down", () => {
  it("login (IP and account), MFA challenge, MFA email OTP, MFA enrollment and password reset all deny", async () => {
    redisDown();
    const id = randomUUID();
    const results = [
      await reserveLoginIpAttempt(`ip-${id}`),
      await reserveLoginAccountAttempt(`${id}@example.com`),
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
    keys.push(loginIpKey(ip));
    expect((await reserveLoginIpAttempt(ip)).allowed).toBe(false);
    vi.restoreAllMocks();
    expect((await reserveLoginIpAttempt(ip)).allowed).toBe(true);
  });
});

describe("SEC-M-02: per-account limit", { timeout: 90_000 }, () => {
  it("allows exactly the limit of failed attempts, whatever IP they come from, then locks", async () => {
    const email = `victim-${randomUUID()}@example.com`;
    keys.push(loginAccountKey(email));
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) {
      expect((await reserveLoginAccountAttempt(email)).allowed).toBe(true);
    }
    const locked = await reserveLoginAccountAttempt(email);
    expect(locked.allowed).toBe(false);
    expect(locked.unavailable).toBeUndefined();
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_ACCOUNT_LIMIT.windowSeconds);
  });

  it("parallel attempts can't get past the limit (reserve first, atomically)", async () => {
    const email = `burst-${randomUUID()}@example.com`;
    keys.push(loginAccountKey(email));
    const results = await Promise.all(Array.from({ length: 15 }, () => reserveLoginAccountAttempt(email)));
    expect(results.filter((r) => r.allowed)).toHaveLength(LOGIN_ACCOUNT_LIMIT.maxAttempts);
  });

  it("is case- and whitespace-insensitive, and one account's lock doesn't affect another", async () => {
    const email = `Mixed-${randomUUID()}@Example.com`;
    const other = `other-${randomUUID()}@example.com`;
    keys.push(loginAccountKey(email), loginAccountKey(other));
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) await reserveLoginAccountAttempt(`  ${email.toUpperCase()} `);
    expect((await reserveLoginAccountAttempt(email.toLowerCase())).allowed).toBe(false);
    expect((await reserveLoginAccountAttempt(other)).allowed).toBe(true);
  });

  it("clearing (after a correct password) starts the count again", async () => {
    const email = `clear-${randomUUID()}@example.com`;
    keys.push(loginAccountKey(email));
    for (let i = 0; i < 4; i += 1) await reserveLoginAccountAttempt(email);
    await clearLoginAccountFailures(email);
    expect(await counterOf(loginAccountKey(email))).toBe(0);
  });
});

describe("per-IP limit counts failures only", { timeout: 90_000 }, () => {
  it("a refunded (successful) attempt doesn't use up the allowance", async () => {
    const ip = `ip-${randomUUID()}`;
    keys.push(loginIpKey(ip));
    for (let i = 0; i < loginIpLimit().maxAttempts + 5; i += 1) {
      expect((await reserveLoginIpAttempt(ip)).allowed).toBe(true);
      await refundLoginIpAttempt(ip);
    }
    expect(await counterOf(loginIpKey(ip))).toBe(0);
  });

  it("defaults to 20 failed attempts per 15 minutes", () => {
    expect(loginIpLimit()).toMatchObject({ maxAttempts: 20, windowSeconds: 900, failClosed: true });
  });
});

describe("SEC-M-02: per-user MFA challenge limit", { timeout: 60_000 }, () => {
  it("trips for a user after the limit, independent of IP", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    keys.push(`mfa-challenge-user:${userId}`, `mfa-challenge-user:${otherUserId}`);
    for (let i = 0; i < MFA_CHALLENGE_USER_LIMIT.maxAttempts; i += 1) {
      expect((await checkMfaChallengeUserRateLimit(userId)).allowed).toBe(true);
    }
    expect((await checkMfaChallengeUserRateLimit(userId)).allowed).toBe(false);
    expect((await checkMfaChallengeUserRateLimit(otherUserId)).allowed).toBe(true);
  });
});
