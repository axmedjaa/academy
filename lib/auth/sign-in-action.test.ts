/**
 * The signIn server action (lib/auth/actions.ts) end to end, against
 * TEST_DATABASE_URL and the test Redis, with Next's request APIs mocked:
 * - SEC-M-09: every platform role must pass MFA; no session before it.
 * - SEC-M-02: the per-account limit trips across rotating IPs.
 * - SEC-M-03: sign-in is refused, not waved through, while Redis is down.
 * - Regression: one failed sign-in never locks anyone out, and successful
 *   sign-ins from a shared IP don't use up that IP's allowance.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
let forwardedFor = "203.0.113.1";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": forwardedFor, "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (arg: string | { name: string }) => void jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
}));

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

// Trust one proxy hop so each test's X-Forwarded-For is a distinct client.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, env: { ...actual.env, TRUSTED_PROXY_HOP_COUNT: 1 } };
});

const { db } = await import("@/lib/db");
const { platformMemberships, sessions, users } = await import("@/lib/db/schema");
const { hashPassword } = await import("@/lib/auth/password");
const { redis } = await import("@/lib/redis");
const { signIn } = await import("./actions");
const { LOGIN_ACCOUNT_LIMIT, loginAccountKey, loginIpKey, loginIpLimit } = await import("./login-rate-limit");
const { rateLimitRedisKey } = await import("@/lib/rate-limit");

const PASSWORD = "Correct-Horse-Battery-9";
const userIds: string[] = [];
const redisKeys: string[] = [];

async function platformUser(role: "platform_admin" | "platform_owner") {
  const email = `signin-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), status: "active" }).returning({ id: users.id });
  userIds.push(user.id);
  await db.insert(platformMemberships).values({ userId: user.id, role });
  return { id: user.id, email };
}

function form(email: string, password: string) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

/** Sets the request's client IP (as one trusted hop appends it) and returns it. */
function setClientIp(ip: string): string {
  forwardedFor = `198.51.100.${Math.floor(Math.random() * 250) + 1}, ${ip}`;
  redisKeys.push(rateLimitRedisKey(loginIpKey(ip)));
  return ip;
}

function freshIp(): string {
  return setClientIp(`10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`);
}

const counter = async (key: string) => {
  const raw = await redis.get(rateLimitRedisKey(key));
  return raw === null ? 0 : Number(raw);
};

beforeEach(() => {
  jar.clear();
  freshIp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (redisKeys.length) await redis.del(...redisKeys.splice(0));
});

afterAll(async () => {
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

describe("SEC-M-09: MFA for every platform role", { timeout: 60_000 }, () => {
  for (const role of ["platform_admin", "platform_owner"] as const) {
    it(`${role}: correct password goes to MFA setup with only a pending cookie, never a session`, async () => {
      const user = await platformUser(role);
      const error = await signIn({ ok: false }, form(user.email, PASSWORD)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RedirectSignal);
      expect((error as RedirectSignal).url).toBe("/mfa/setup");
      expect(jar.has("mfa_pending")).toBe(true);
      expect(jar.has("session")).toBe(false);
      expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    });
  }
});

// Ten Argon2 checks plus remote Redis/DB round trips per test.
describe("SEC-M-02: per-account login limit through signIn", { timeout: 120_000 }, () => {
  it("locks the account after repeated failures from different IPs, even for the right password", async () => {
    const user = await platformUser("platform_admin");
    redisKeys.push(rateLimitRedisKey(loginAccountKey(user.email)));
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) {
      freshIp();
      const state = await signIn({ ok: false }, form(user.email, "wrong-password"));
      expect(state.error?.code).toBe("UNAUTHENTICATED");
    }
    freshIp();
    const locked = await signIn({ ok: false }, form(user.email, PASSWORD));
    expect(locked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(jar.has("mfa_pending")).toBe(false);
  });

  it("an unknown email locks the same way (no account-existence signal)", async () => {
    const email = `nobody-${randomUUID()}@example.com`;
    redisKeys.push(rateLimitRedisKey(loginAccountKey(email)));
    for (let i = 0; i < LOGIN_ACCOUNT_LIMIT.maxAttempts; i += 1) {
      freshIp();
      await signIn({ ok: false }, form(email, "whatever"));
    }
    freshIp();
    expect(await signIn({ ok: false }, form(email, "whatever"))).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("SEC-M-03: sign-in while Redis is down", () => {
  it("is refused with a retry-shortly message, before the password is checked", async () => {
    const user = await platformUser("platform_admin");
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    const state = await signIn({ ok: false }, form(user.email, PASSWORD));
    expect(state).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", message: "This is temporarily unavailable. Please try again in a moment." } });
    expect(jar.size).toBe(0);
  });
});

describe("regression: one failed sign-in never locks anyone out", { timeout: 180_000 }, () => {
  it("one wrong password returns the normal error, and leaves each counter at 1 with an expiry", async () => {
    const user = await platformUser("platform_admin");
    redisKeys.push(rateLimitRedisKey(loginAccountKey(user.email)));
    const ip = freshIp();
    const state = await signIn({ ok: false }, form(user.email, "wrong-password"));
    expect(state).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED", message: "Invalid email or password." } });
    expect(await counter(loginIpKey(ip))).toBe(1);
    expect(await counter(loginAccountKey(user.email))).toBe(1);
    expect(await redis.ttl(rateLimitRedisKey(loginIpKey(ip)))).toBeGreaterThan(0);
    expect(await redis.ttl(rateLimitRedisKey(loginAccountKey(user.email)))).toBeGreaterThan(0);
  });

  it("successful sign-ins from one shared IP (an office) never use up its allowance", async () => {
    const officeIp = setClientIp(`10.77.${Math.floor(Math.random() * 250)}.1`);
    const people = await Promise.all([platformUser("platform_admin"), platformUser("platform_admin"), platformUser("platform_admin")]);
    for (let i = 0; i < loginIpLimit().maxAttempts + 2; i += 1) {
      setClientIp(officeIp);
      jar.clear();
      const person = people[i % people.length];
      const outcome = await signIn({ ok: false }, form(person.email, PASSWORD)).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(RedirectSignal);
    }
    expect(await counter(loginIpKey(officeIp))).toBe(0);
  });

  it("a correct password clears the account's earlier failures", async () => {
    const user = await platformUser("platform_admin");
    redisKeys.push(rateLimitRedisKey(loginAccountKey(user.email)));
    for (let i = 0; i < 3; i += 1) {
      freshIp();
      await signIn({ ok: false }, form(user.email, "wrong-password"));
    }
    expect(await counter(loginAccountKey(user.email))).toBe(3);
    freshIp();
    await signIn({ ok: false }, form(user.email, PASSWORD)).catch(() => undefined);
    expect(await counter(loginAccountKey(user.email))).toBe(0);
  });

  it("malformed input is refused without counting against anything", async () => {
    const ip = freshIp();
    const state = await signIn({ ok: false }, form("not-an-email", "x"));
    expect(state.error?.code).toBe("VALIDATION_ERROR");
    expect(await counter(loginIpKey(ip))).toBe(0);
  });
});
