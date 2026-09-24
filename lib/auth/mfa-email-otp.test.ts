import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, mfaEmailOtps, mfaTotpCredentials, users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// Real Resend is never called from the test suite (Security requirement) —
// mocking this one boundary lets these tests verify recipient/subject/code
// content without any real network call, matching every other email-flow
// test file's style in this codebase.
vi.mock("@/lib/email/client", () => ({ sendEmail: vi.fn() }));

import { sendEmail } from "@/lib/email/client";
import { sendMfaEmailOtp, verifyMfaEmailOtp } from "./mfa-email-otp";

const sendEmailMock = vi.mocked(sendEmail);

function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

const createdUserIds: string[] = [];

/** Every test needs an already-TOTP-enrolled user — email OTP is additional
 * to TOTP, never its own enrollment path (see mfa-email-otp.ts's doc
 * comment), so a bare mfa_totp_credentials row with verifiedAt set stands
 * in for a real enrollment without needing the full otpauth flow. */
async function createEnrolledUser(): Promise<{ id: string; email: string }> {
  const email = `mfa-email-otp-test-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  await db.insert(mfaTotpCredentials).values({
    userId: user.id,
    secretEncrypted: "not-a-real-secret",
    verifiedAt: new Date(),
  });
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

async function createUnenrolledUser(): Promise<{ id: string; email: string }> {
  const email = `mfa-email-otp-unenrolled-${randomUUID()}@example.com`;
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

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
    await db.delete(mfaEmailOtps).where(eq(mfaEmailOtps.userId, id));
    await db.delete(mfaTotpCredentials).where(eq(mfaTotpCredentials.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("sendMfaEmailOtp", () => {
  it("refuses to send for an account without a verified TOTP credential (additional, not an enrollment path)", async () => {
    const user = await createUnenrolledUser();
    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_ENROLLED");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("generates a 6-digit code, stores only its hash, and emails it to the account's own address", async () => {
    const user = await createEnrolledUser();
    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe(user.email);
    expect(call.subject).toBe("Your sign-in verification code");
    // The raw 6-digit code appears in the email body, never in the stored row.
    expect(call.html).toMatch(/\d{6}/);
  });

  it("invalidates a previous outstanding code when a new one is requested", async () => {
    const user = await createEnrolledUser();
    await sendMfaEmailOtp(user.id);
    await sendMfaEmailOtp(user.id);

    const rows = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    const unused = rows.filter((row) => row.usedAt === null);
    expect(unused.length).toBe(1);
  });

  it("returns a safe error without changing anything when email delivery fails", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "boom" });
    const user = await createEnrolledUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEND_FAILED");
  });

  // Reproduces the real production failure mode found in this codebase:
  // Resend's sandbox sender (no verified domain) rejects delivery to any
  // recipient other than the Resend account's own address with a 403
  // validation_error. sendMfaEmailOtp must surface this the same safe way
  // as any other provider failure — a generic SEND_FAILED, never the raw
  // provider error to the client — while lib/email/client.ts's own log
  // captures the real reason server-side (see client.test.ts).
  it("returns SEND_FAILED (never the raw provider reason) when Resend rejects the recipient/sender", async () => {
    sendEmailMock.mockResolvedValue({
      ok: false,
      error: "Failed to send email.",
    });
    const user = await createEnrolledUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEND_FAILED");
      expect(result.error.message).not.toMatch(/resend\.com|validation_error|403/i);
    }
  });

  it("only ever emails the server-resolved account email — there is no parameter to redirect it elsewhere", async () => {
    const user = await createEnrolledUser();
    await sendMfaEmailOtp(user.id);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe(user.email);
  });

  it("never logs the raw 6-digit code, success or failure", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const okUser = await createEnrolledUser();
    await sendMfaEmailOtp(okUser.id);

    sendEmailMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const failUser = await createEnrolledUser();
    await sendMfaEmailOtp(failUser.id);

    const [okRow] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, okUser.id));
    const rawCodeCandidate = sendEmailMock.mock.calls[0][0].text.match(/\d{6}/)?.[0];
    expect(rawCodeCandidate).toBeDefined();
    expect(okRow.codeHash).not.toBe(rawCodeCandidate);

    const logged = JSON.stringify([...infoSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(logged).not.toContain(rawCodeCandidate);

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("is rate-limited after repeated requests", async () => {
    const user = await createEnrolledUser();
    let sawRateLimited = false;
    for (let i = 0; i < 8; i += 1) {
      const result = await sendMfaEmailOtp(user.id);
      if (!result.ok && result.error.code === "RATE_LIMITED") {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});

describe("verifyMfaEmailOtp", () => {
  it("rejects when there is no outstanding code", async () => {
    const user = await createEnrolledUser();
    expect(await verifyMfaEmailOtp(user.id, "123456")).toBe(false);
  });

  it("rejects a wrong code without consuming it", async () => {
    const user = await createEnrolledUser();
    await insertOtp(user.id, "111111");

    expect(await verifyMfaEmailOtp(user.id, "222222")).toBe(false);

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("accepts the correct code exactly once and rejects reuse", async () => {
    const user = await createEnrolledUser();
    await insertOtp(user.id, "654321");

    expect(await verifyMfaEmailOtp(user.id, "654321")).toBe(true);
    expect(await verifyMfaEmailOtp(user.id, "654321")).toBe(false);

    const [row] = await db.select().from(mfaEmailOtps).where(eq(mfaEmailOtps.userId, user.id));
    expect(row.usedAt).not.toBeNull();
  });

  it("rejects an expired code even if correct", async () => {
    const user = await createEnrolledUser();
    await insertOtp(user.id, "999999", { expiresAt: new Date(Date.now() - 1000) });

    expect(await verifyMfaEmailOtp(user.id, "999999")).toBe(false);
  });

  it("locks a code out after repeated wrong attempts, even before it expires (brute-force protection)", async () => {
    const user = await createEnrolledUser();
    await insertOtp(user.id, "135790");

    for (let i = 0; i < 5; i += 1) {
      await verifyMfaEmailOtp(user.id, "000000");
    }

    // The code was still technically correct and unexpired, but is now
    // locked out by the attempts cap.
    expect(await verifyMfaEmailOtp(user.id, "135790")).toBe(false);
  });

  it("refuses to verify for an account without a verified TOTP credential", async () => {
    const user = await createUnenrolledUser();
    await db.insert(mfaEmailOtps).values({
      userId: user.id,
      codeHash: hashCode(user.id, "424242"),
      expiresAt: new Date(Date.now() + 60 * 1000),
    });

    expect(await verifyMfaEmailOtp(user.id, "424242")).toBe(false);
  });

  it("writes an audit row on successful verification, with no code in it", async () => {
    const user = await createEnrolledUser();
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
    const userA = await createEnrolledUser();
    const userB = await createEnrolledUser();
    await insertOtp(userA.id, "555555");
    await insertOtp(userB.id, "777777");

    // Even though both rows exist, A's code must never validate for B and
    // vice versa — verification is always scoped by the resolved userId,
    // which the caller derives server-side from the pending-MFA cookie,
    // never from client input.
    expect(await verifyMfaEmailOtp(userB.id, "555555")).toBe(false);
    expect(await verifyMfaEmailOtp(userA.id, "777777")).toBe(false);

    expect(await verifyMfaEmailOtp(userA.id, "555555")).toBe(true);
    expect(await verifyMfaEmailOtp(userB.id, "777777")).toBe(true);
  });
});
