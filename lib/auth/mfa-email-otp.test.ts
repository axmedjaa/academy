import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, mfaEmailOtps, users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// Real Resend is never called from the test suite (Security requirement) —
// mocking this one boundary lets these tests verify recipient/subject/code
// content without any real network call, matching every other email-flow
// test file's style in this codebase.
vi.mock("@/lib/email/client", () => ({ sendEmail: vi.fn() }));

import { sendEmail } from "@/lib/email/client";
import {
  getMfaEmailOtpStatus,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  sendMfaEmailOtp,
  verifyMfaEmailOtp,
} from "./mfa-email-otp";

const sendEmailMock = vi.mocked(sendEmail);

function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

const createdUserIds: string[] = [];

/** Email codes need no authenticator app or other enrollment: any account will do. */
async function createUser(): Promise<{ id: string; email: string }> {
  const email = `mfa-email-otp-test-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

async function insertOtp(
  userId: string,
  code: string,
  overrides: { expiresAt?: Date; usedAt?: Date; attempts?: number } = {},
): Promise<void> {
  await db.insert(mfaEmailOtps).values({
    userId,
    codeHash: hashCode(userId, code),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
    usedAt: overrides.usedAt,
    attempts: overrides.attempts ?? 0,
  });
}

/** Moves this user's codes back in time, past the resend cooldown. */
async function passCooldown(userId: string): Promise<void> {
  await db
    .update(mfaEmailOtps)
    .set({ createdAt: new Date(Date.now() - (RESEND_COOLDOWN_SECONDS + 5) * 1000) })
    .where(eq(mfaEmailOtps.userId, userId));
}

function sentCode(callIndex = 0): string {
  const code = sendEmailMock.mock.calls[callIndex][0].text.match(/\d{6}/)?.[0];
  if (!code) throw new Error("no code in the email");
  return code;
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
    await db.delete(mfaEmailOtps).where(eq(mfaEmailOtps.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("sendMfaEmailOtp", () => {
  it("generates a 6-digit code, stores only its hash, and emails it to the account's own address", async () => {
    const user = await createUser();
    const result = await sendMfaEmailOtp(user.id);
    expect(result).toEqual({ ok: true, resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS });

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe(user.email);
    expect(call.subject).toBe("Your sign-in verification code");
    // The raw code is in the email, never stored: the row holds its hash.
    expect(row.codeHash).toBe(hashCode(user.id, sentCode()));
    expect(row.codeHash).not.toContain(sentCode());
  });

  it("enforces the resend cooldown: a second request right away sends nothing and keeps the first code valid", async () => {
    const user = await createUser();
    await sendMfaEmailOtp(user.id);
    const second = await sendMfaEmailOtp(user.id);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("RATE_LIMITED");
      expect(second.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.error.retryAfterSeconds).toBeLessThanOrEqual(RESEND_COOLDOWN_SECONDS);
    }
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await verifyMfaEmailOtp(user.id, sentCode())).toBe(true);
  });

  it("invalidates the previous code when a new one is sent after the cooldown", async () => {
    const user = await createUser();
    await sendMfaEmailOtp(user.id);
    await passCooldown(user.id);
    await sendMfaEmailOtp(user.id);

    const rows = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1);

    const first = sentCode(0);
    const second = sentCode(1);
    if (first !== second) expect(await verifyMfaEmailOtp(user.id, first)).toBe(false);
    expect(await verifyMfaEmailOtp(user.id, second)).toBe(true);
  });

  it("when delivery fails: SEND_FAILED, no usable code left behind, and an immediate retry is allowed", async () => {
    sendEmailMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const user = await createUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEND_FAILED");
    expect(await getMfaEmailOtpStatus(user.id)).toEqual({ codeActive: false, resendAvailableInSeconds: 0 });

    expect((await sendMfaEmailOtp(user.id)).ok).toBe(true);
  });

  // Resend's sandbox sender (no verified domain) rejects any recipient but
  // the Resend account's own address with a 403. That must reach the user
  // as the same generic SEND_FAILED, never the provider's reason.
  it("returns SEND_FAILED (never the raw provider reason) when Resend rejects the recipient/sender", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "Failed to send email." });
    const user = await createUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEND_FAILED");
      expect(result.error.message).not.toMatch(/resend\.com|validation_error|403/i);
    }
  });

  it("never logs the raw 6-digit code, success or failure", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const okUser = await createUser();
    await sendMfaEmailOtp(okUser.id);

    sendEmailMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const failUser = await createUser();
    await sendMfaEmailOtp(failUser.id);

    const logged = JSON.stringify([...infoSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(logged).not.toContain(sentCode(0));
    expect(logged).not.toContain(sentCode(1));

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("is rate-limited per user after repeated sends, even with the cooldown waited out", async () => {
    const user = await createUser();
    let sawRateLimited = false;
    for (let i = 0; i < 8; i += 1) {
      const result = await sendMfaEmailOtp(user.id);
      if (!result.ok && result.error.code === "RATE_LIMITED") {
        sawRateLimited = true;
        break;
      }
      await passCooldown(user.id);
    }
    expect(sawRateLimited).toBe(true);
    expect(sendEmailMock.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("getMfaEmailOtpStatus", () => {
  it("reports no code and no wait for an account that was never sent one", async () => {
    const user = await createUser();
    expect(await getMfaEmailOtpStatus(user.id)).toEqual({ codeActive: false, resendAvailableInSeconds: 0 });
  });

  it("reports a waiting code and the remaining cooldown right after a send", async () => {
    const user = await createUser();
    await sendMfaEmailOtp(user.id);
    const status = await getMfaEmailOtpStatus(user.id);
    expect(status.codeActive).toBe(true);
    expect(status.resendAvailableInSeconds).toBeGreaterThan(RESEND_COOLDOWN_SECONDS - 15);
  });

  it("reports no active code once it is used, expired or out of attempts", async () => {
    const used = await createUser();
    await insertOtp(used.id, "111111", { usedAt: new Date() });
    const expired = await createUser();
    await insertOtp(expired.id, "111111", { expiresAt: new Date(Date.now() - 1000) });
    const exhausted = await createUser();
    await insertOtp(exhausted.id, "111111", { attempts: MAX_VERIFY_ATTEMPTS });

    for (const user of [used, expired, exhausted]) {
      expect((await getMfaEmailOtpStatus(user.id)).codeActive).toBe(false);
    }
  });
});

describe("verifyMfaEmailOtp", () => {
  it("rejects when there is no outstanding code", async () => {
    const user = await createUser();
    expect(await verifyMfaEmailOtp(user.id, "123456")).toBe(false);
  });

  it("rejects a wrong code and counts the attempt, without consuming the code", async () => {
    const user = await createUser();
    await insertOtp(user.id, "111111");

    expect(await verifyMfaEmailOtp(user.id, "222222")).toBe(false);

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(await verifyMfaEmailOtp(user.id, "111111")).toBe(true);
  });

  it("accepts the correct code exactly once and rejects reuse", async () => {
    const user = await createUser();
    await insertOtp(user.id, "654321");

    expect(await verifyMfaEmailOtp(user.id, "654321")).toBe(true);
    expect(await verifyMfaEmailOtp(user.id, "654321")).toBe(false);

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).not.toBeNull();
  });

  it("rejects an expired code even if correct", async () => {
    const user = await createUser();
    await insertOtp(user.id, "999999", { expiresAt: new Date(Date.now() - 1000) });

    expect(await verifyMfaEmailOtp(user.id, "999999")).toBe(false);
  });

  it("locks a code out after repeated wrong attempts, even before it expires (brute-force protection)", async () => {
    const user = await createUser();
    await insertOtp(user.id, "135790");

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i += 1) {
      await verifyMfaEmailOtp(user.id, "000000");
    }

    expect(await verifyMfaEmailOtp(user.id, "135790")).toBe(false);
  });

  it("parallel wrong guesses can't get past the attempt limit", async () => {
    const user = await createUser();
    await insertOtp(user.id, "864209");

    await Promise.all(
      Array.from({ length: MAX_VERIFY_ATTEMPTS * 2 }, (_, i) => verifyMfaEmailOtp(user.id, String(100000 + i))),
    );

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.attempts).toBe(MAX_VERIFY_ATTEMPTS);
    expect(await verifyMfaEmailOtp(user.id, "864209")).toBe(false);
  });

  it("two parallel submissions of the correct code log in only once", async () => {
    const user = await createUser();
    await insertOtp(user.id, "975310");

    const results = await Promise.all([verifyMfaEmailOtp(user.id, "975310"), verifyMfaEmailOtp(user.id, "975310")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("writes an audit row on successful verification, with no code in it", async () => {
    const user = await createUser();
    await insertOtp(user.id, "246810");

    await verifyMfaEmailOtp(user.id, "246810");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, user.id), eq(auditLogs.action, "mfa_email_otp_verified")));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit.before) + JSON.stringify(audit.after) + JSON.stringify(audit.context)).not.toContain("246810");
  });

  it("isolates codes per account: one user's code never verifies against another user's pending challenge", async () => {
    const userA = await createUser();
    const userB = await createUser();
    await insertOtp(userA.id, "555555");
    await insertOtp(userB.id, "777777");

    expect(await verifyMfaEmailOtp(userB.id, "555555")).toBe(false);
    expect(await verifyMfaEmailOtp(userA.id, "777777")).toBe(false);

    expect(await verifyMfaEmailOtp(userA.id, "555555")).toBe(true);
    expect(await verifyMfaEmailOtp(userB.id, "777777")).toBe(true);
  });
});
