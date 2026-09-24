import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, mfaEmailOtps, mfaTotpCredentials, users } from "@/lib/db/schema";
import { sendMfaEmailOtp } from "./mfa-email-otp";

// Deliberately does NOT mock @/lib/email/client — these tests exercise the
// REAL lib/email/client.ts boundary to prove that when RESEND_API_KEY/
// EMAIL_FROM are missing, sendEmail() short-circuits before ever
// constructing a Resend client (no real network call is possible), the
// same shared boundary password-reset/email-change already rely on.
const ORIGINAL_RESEND_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_EMAIL_FROM = process.env.EMAIL_FROM;

const createdUserIds: string[] = [];

async function createEnrolledUser(): Promise<{ id: string; email: string }> {
  const email = `mfa-email-otp-env-test-${randomUUID()}@example.com`;
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

beforeEach(() => {
  process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  process.env.EMAIL_FROM = ORIGINAL_EMAIL_FROM;
});

afterEach(() => {
  process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  process.env.EMAIL_FROM = ORIGINAL_EMAIL_FROM;
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
    await db.delete(mfaEmailOtps).where(eq(mfaEmailOtps.userId, id));
    await db.delete(mfaTotpCredentials).where(eq(mfaTotpCredentials.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("sendMfaEmailOtp with the real email boundary", () => {
  it("fails safely when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const user = await createEnrolledUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEND_FAILED");
  });

  it("fails safely when EMAIL_FROM is missing", async () => {
    delete process.env.EMAIL_FROM;
    const user = await createEnrolledUser();

    const result = await sendMfaEmailOtp(user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEND_FAILED");
  });
});
