/**
 * Email two-step sign-in end to end through the real server actions
 * (signIn -> /mfa/challenge -> challengeMfa / sendMfaEmailOtpAction),
 * against TEST_DATABASE_URL and the test Redis, with Next's request APIs
 * mocked and the email boundary mocked (no real email is ever sent; the
 * test reads the code from the mocked email, as the user would).
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
let forwardedFor = "203.0.113.1";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": forwardedFor, "user-agent": "vitest-mfa-flow" }),
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

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, env: { ...actual.env, TRUSTED_PROXY_HOP_COUNT: 1 } };
});

type EmailInput = { to: string; subject: string; html: string; text: string };
const sendEmailMock = vi.fn<(input: EmailInput) => Promise<{ ok: true }>>(async () => ({ ok: true }));
vi.mock("@/lib/email/client", () => ({ sendEmail: (input: never) => sendEmailMock(input) }));

// New-device alerts are covered elsewhere; keep notification jobs out of this suite.
vi.mock("@/lib/auth/suspicious-login", () => ({ checkSuspiciousLogin: async () => false }));

const { db } = await import("@/lib/db");
const { auditLogs, mfaEmailOtps, mfaRecoveryCodes, mfaTotpCredentials, platformMemberships, sessions, users } =
  await import("@/lib/db/schema");
const { hashPassword } = await import("@/lib/auth/password");
const { signIn } = await import("./actions");
const { challengeMfa, sendMfaEmailOtpAction } = await import("./mfa-actions");
const { regenerateRecoveryCodesForUser } = await import("./mfa");
const { RESEND_COOLDOWN_SECONDS } = await import("./mfa-email-otp");

const PASSWORD = "Correct-Horse-Battery-9";
const userIds: string[] = [];

async function platformUser(options: { legacyTotp?: boolean } = {}) {
  const email = `mfa-flow-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), status: "active" })
    .returning({ id: users.id });
  userIds.push(user.id);
  await db.insert(platformMemberships).values({ userId: user.id, role: "platform_admin" });
  if (options.legacyTotp) {
    await db.insert(mfaTotpCredentials).values({ userId: user.id, secretEncrypted: "legacy-secret", verifiedAt: new Date() });
  }
  return { id: user.id, email };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const outcome = await promise.catch((e: unknown) => e);
  if (!(outcome instanceof RedirectSignal)) throw new Error(`expected a redirect, got ${JSON.stringify(outcome)}`);
  return outcome.url;
}

/** Signs in with the password; returns the code from the (mocked) email. */
async function passwordStep(email: string): Promise<string> {
  sendEmailMock.mockClear();
  expect(await redirectOf(signIn({ ok: false }, form({ email, password: PASSWORD })))).toBe("/mfa/challenge");
  const sent = sendEmailMock.mock.calls.find(([input]) => input.to === email);
  const code = sent?.[0].text.match(/\d{6}/)?.[0];
  if (!code) throw new Error("no code was emailed");
  return code;
}

async function sessionCount(userId: string) {
  return (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

beforeEach(() => {
  jar.clear();
  const n = () => Math.floor(Math.random() * 250) + 1;
  forwardedFor = `198.51.100.${n()}, 10.${n()}.${n()}.${n()}`;
});

afterAll(async () => {
  if (!userIds.length) return;
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  await db.delete(mfaEmailOtps).where(inArray(mfaEmailOtps.userId, userIds));
  await db.delete(mfaRecoveryCodes).where(inArray(mfaRecoveryCodes.userId, userIds));
  await db.delete(mfaTotpCredentials).where(inArray(mfaTotpCredentials.userId, userIds));
  await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe("email two-step sign-in", { timeout: 90_000 }, () => {
  it("a correct password sends the code automatically; the emailed code then signs in", async () => {
    const user = await platformUser();
    const code = await passwordStep(user.email);

    expect(jar.has("mfa_pending")).toBe(true);
    expect(jar.has("session")).toBe(false);
    expect(await sessionCount(user.id)).toBe(0);

    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "email", code })))).toBe("/platform/dashboard");
    expect(jar.has("session")).toBe(true);
    expect(jar.has("mfa_pending")).toBe(false);
    expect(await sessionCount(user.id)).toBe(1);
  });

  it("no session until verification succeeds: a wrong code is refused and signs nothing in", async () => {
    const user = await platformUser();
    const code = await passwordStep(user.email);
    const wrong = code === "000000" ? "111111" : "000000";

    const result = await challengeMfa({ ok: false }, form({ mode: "email", code: wrong }));
    expect(result).toEqual({ ok: false, error: { code: "INVALID_CODE", message: "Invalid code." } });
    expect(jar.has("session")).toBe(false);
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("an expired code is refused", async () => {
    const user = await platformUser();
    const code = await passwordStep(user.email);
    await db.update(mfaEmailOtps).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mfaEmailOtps.userId, user.id));

    const result = await challengeMfa({ ok: false }, form({ mode: "email", code }));
    expect(result.ok).toBe(false);
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("a used code can't sign in a second time", async () => {
    const user = await platformUser();
    const code = await passwordStep(user.email);
    await redirectOf(challengeMfa({ ok: false }, form({ mode: "email", code })));

    // Same browser state as before the first verification, replaying the code.
    jar.delete("session");
    await passwordStepWithoutNewCode(user.email);
    const replay = await challengeMfa({ ok: false }, form({ mode: "email", code }));
    expect(replay.ok).toBe(false);
    expect(await sessionCount(user.id)).toBe(1);
  });

  it("the challenge refuses anyone without the pending cookie (no password step)", async () => {
    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "email", code: "123456" })))).toBe("/login");
    expect(await redirectOf(sendMfaEmailOtpAction())).toBe("/login");
  });

  it("authenticator-app codes are no longer accepted as a mode, and a malformed email code is refused before checking", async () => {
    const user = await platformUser({ legacyTotp: true });
    await passwordStep(user.email);

    const totp = await challengeMfa({ ok: false }, form({ mode: "totp", code: "123456" }));
    expect(totp.ok).toBe(false);
    expect(totp.error?.code).toBe("VALIDATION_ERROR");

    const malformed = await challengeMfa({ ok: false }, form({ mode: "email", code: "12ab" }));
    expect(malformed.error?.code).toBe("VALIDATION_ERROR");
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("resend: refused during the cooldown, then sends a new code that replaces the old one", async () => {
    const user = await platformUser();
    const first = await passwordStep(user.email);

    sendEmailMock.mockClear();
    const tooSoon = await sendMfaEmailOtpAction();
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.error?.code).toBe("RATE_LIMITED");
    expect(tooSoon.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db
      .update(mfaEmailOtps)
      .set({ createdAt: new Date(Date.now() - (RESEND_COOLDOWN_SECONDS + 5) * 1000) })
      .where(eq(mfaEmailOtps.userId, user.id));
    const resent = await sendMfaEmailOtpAction();
    expect(resent).toEqual({ ok: true, resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS });
    const second = sendEmailMock.mock.calls[0]?.[0].text.match(/\d{6}/)?.[0];
    if (!second) throw new Error("no code was resent");

    if (first !== second) {
      expect((await challengeMfa({ ok: false }, form({ mode: "email", code: first }))).ok).toBe(false);
    }
    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "email", code: second })))).toBe("/platform/dashboard");
  });

  it("a recovery code signs in instead of the emailed code", async () => {
    const user = await platformUser();
    const issued = await regenerateRecoveryCodesForUser(user.id);
    if (!issued.ok) throw new Error("test setup failed");

    await passwordStep(user.email);
    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "recovery", code: issued.recoveryCodes[0] })))).toBe(
      "/platform/dashboard",
    );
    expect(await sessionCount(user.id)).toBe(1);
  });

  it("an account set up with an authenticator app signs in with the emailed code; its recovery codes still work", async () => {
    const user = await platformUser({ legacyTotp: true });
    const issued = await regenerateRecoveryCodesForUser(user.id);
    if (!issued.ok) throw new Error("test setup failed");

    const code = await passwordStep(user.email);
    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "email", code })))).toBe("/platform/dashboard");

    jar.clear();
    await passwordStepWithoutNewCode(user.email);
    expect(await redirectOf(challengeMfa({ ok: false }, form({ mode: "recovery", code: issued.recoveryCodes[1] })))).toBe(
      "/platform/dashboard",
    );
    expect(await sessionCount(user.id)).toBe(2);
  });
});

/** Password step when a code was just sent (the cooldown means no new email). */
async function passwordStepWithoutNewCode(email: string): Promise<void> {
  expect(await redirectOf(signIn({ ok: false }, form({ email, password: PASSWORD })))).toBe("/mfa/challenge");
}
