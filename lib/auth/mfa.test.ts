import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { mfaRecoveryCodes, mfaTotpCredentials, users } from "@/lib/db/schema";
import {
  enrollMfaForUser,
  hasVerifiedMfaCredential,
  regenerateRecoveryCodesForUser,
  verifyMfaChallenge,
  verifyMfaEnrollmentForUser,
} from "./mfa";

let userId: string;

function currentCodeFor(secretBase32: string): string {
  return new OTPAuth.TOTP({
    issuer: "Academy Management SaaS",
    label: "test",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: secretBase32,
  }).generate();
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `mfa-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  userId = user.id;
});

afterAll(async () => {
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db
    .delete(mfaTotpCredentials)
    .where(eq(mfaTotpCredentials.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("enrollMfaForUser", () => {
  it("returns a secret, an otpauth URL, and a QR code data URL", async () => {
    const result = await enrollMfaForUser(userId);
    expect(result.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(result.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("resumes the same unverified enrollment rather than minting a new secret", async () => {
    const first = await enrollMfaForUser(userId);
    const second = await enrollMfaForUser(userId);
    expect(second.secretBase32).toBe(first.secretBase32);
  });
});

describe("verifyMfaEnrollmentForUser", () => {
  it("rejects a wrong code", async () => {
    await enrollMfaForUser(userId);
    const result = await verifyMfaEnrollmentForUser(userId, "000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CODE");
    }
  });

  it("accepts the correct code, returns 10 recovery codes, and marks the credential verified", async () => {
    expect(await hasVerifiedMfaCredential(userId)).toBe(false);

    const { secretBase32 } = await enrollMfaForUser(userId);
    const code = currentCodeFor(secretBase32);

    const result = await verifyMfaEnrollmentForUser(userId, code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recoveryCodes).toHaveLength(10);
      expect(new Set(result.recoveryCodes).size).toBe(10);
    }

    expect(await hasVerifiedMfaCredential(userId)).toBe(true);
  });

  it("stores recovery codes hashed, never in plaintext", async () => {
    const rows = await db
      .select()
      .from(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, userId));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex digest
    }
  });

  it("rejects verification once already verified (no pending enrollment left)", async () => {
    const [credential] = await db
      .select()
      .from(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, userId));

    // Re-derive a currently-valid code for the now-verified secret is not
    // needed here — with no unverified credential left, any code is
    // rejected before it would even be checked.
    const result = await verifyMfaEnrollmentForUser(userId, "123456");
    expect(result.ok).toBe(false);
    expect(credential.verifiedAt).not.toBeNull();
  });

  it("does not reuse a verified credential's secret on a later enrollMfaForUser call", async () => {
    const previouslyVerified = await db
      .select()
      .from(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, userId));
    const verifiedSecretHash = createHash("sha256")
      .update(previouslyVerified[0].secretEncrypted)
      .digest("hex");

    const fresh = await enrollMfaForUser(userId);
    const freshCredentials = await db
      .select()
      .from(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, userId));
    const newRow = freshCredentials.find(
      (c) =>
        createHash("sha256").update(c.secretEncrypted).digest("hex") !==
        verifiedSecretHash,
    );

    expect(newRow).toBeDefined();
    expect(newRow?.verifiedAt).toBeNull();
    void fresh;
  });
});

describe("verifyMfaChallenge", () => {
  let challengeUserId: string;
  let secretBase32: string;
  let recoveryCodes: string[];

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: `mfa-challenge-test-${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: users.id });
    challengeUserId = user.id;

    const enrollment = await enrollMfaForUser(challengeUserId);
    secretBase32 = enrollment.secretBase32;

    const verifyResult = await verifyMfaEnrollmentForUser(
      challengeUserId,
      currentCodeFor(secretBase32),
    );
    if (!verifyResult.ok) throw new Error("test setup: enrollment failed");
    recoveryCodes = verifyResult.recoveryCodes;
  });

  afterAll(async () => {
    await db
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, challengeUserId));
    await db
      .delete(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, challengeUserId));
    await db.delete(users).where(eq(users.id, challengeUserId));
  });

  it("accepts a correct TOTP code", async () => {
    const result = await verifyMfaChallenge(
      challengeUserId,
      "totp",
      currentCodeFor(secretBase32),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong TOTP code", async () => {
    const result = await verifyMfaChallenge(challengeUserId, "totp", "000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CODE");
    }
  });

  it("accepts a correct, unused recovery code and then rejects reusing it", async () => {
    const code = recoveryCodes[0];

    const first = await verifyMfaChallenge(challengeUserId, "recovery", code);
    expect(first.ok).toBe(true);

    const second = await verifyMfaChallenge(challengeUserId, "recovery", code);
    expect(second.ok).toBe(false);
  });

  it("accepts a recovery code regardless of input case", async () => {
    const code = recoveryCodes[1];
    const result = await verifyMfaChallenge(
      challengeUserId,
      "recovery",
      code.toLowerCase(),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a made-up recovery code", async () => {
    const result = await verifyMfaChallenge(
      challengeUserId,
      "recovery",
      "AAAAA-AAAAA",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects any code for a user with no verified credential", async () => {
    const [freshUser] = await db
      .insert(users)
      .values({
        email: `mfa-challenge-nocred-${randomUUID()}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });

    const result = await verifyMfaChallenge(freshUser.id, "totp", "123456");
    expect(result.ok).toBe(false);

    await db.delete(users).where(eq(users.id, freshUser.id));
  });
});

describe("regenerateRecoveryCodesForUser", () => {
  it("fails for a user with no verified MFA credential", async () => {
    const [freshUser] = await db
      .insert(users)
      .values({
        email: `mfa-regen-nocred-${randomUUID()}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });

    const result = await regenerateRecoveryCodesForUser(freshUser.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_ENROLLED");
    }

    await db.delete(users).where(eq(users.id, freshUser.id));
  });

  it("replaces the entire code set: old codes stop working, new codes work", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: `mfa-regen-${randomUUID()}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    const regenUserId = user.id;

    const { secretBase32 } = await enrollMfaForUser(regenUserId);
    const enrollResult = await verifyMfaEnrollmentForUser(
      regenUserId,
      currentCodeFor(secretBase32),
    );
    if (!enrollResult.ok) throw new Error("test setup: enrollment failed");
    const oldCode = enrollResult.recoveryCodes[0];

    const regenResult = await regenerateRecoveryCodesForUser(regenUserId);
    expect(regenResult.ok).toBe(true);
    if (!regenResult.ok) throw new Error("unreachable");

    expect(regenResult.recoveryCodes).toHaveLength(10);
    // A fresh set, not the same codes re-issued.
    expect(
      regenResult.recoveryCodes.some((code) =>
        enrollResult.recoveryCodes.includes(code),
      ),
    ).toBe(false);

    const oldCodeResult = await verifyMfaChallenge(
      regenUserId,
      "recovery",
      oldCode,
    );
    expect(oldCodeResult.ok).toBe(false);

    const newCodeResult = await verifyMfaChallenge(
      regenUserId,
      "recovery",
      regenResult.recoveryCodes[0],
    );
    expect(newCodeResult.ok).toBe(true);

    await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, regenUserId));
    await db
      .delete(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, regenUserId));
    await db.delete(users).where(eq(users.id, regenUserId));
  });
});
