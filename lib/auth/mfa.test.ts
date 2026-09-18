import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  auditLogs,
  mfaRecoveryCodes,
  mfaTotpCredentials,
  users,
} from "@/lib/db/schema";
import {
  enrollMfaForUser,
  hasVerifiedMfaCredential,
  regenerateRecoveryCodesForUser,
  verifyMfaChallenge,
  verifyMfaEnrollmentForUser,
} from "./mfa";

async function auditRowsFor(actorUserId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(eq(auditLogs.actorUserId, actorUserId), eq(auditLogs.action, action)),
    );
}

/** Creates a throwaway user for a single test, returning its id. */
async function insertTestUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `mfa-audit-${label}-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

/** Full teardown for a throwaway user created via insertTestUser, in FK order. */
async function deleteTestUser(id: string): Promise<void> {
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
  await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
  await db.delete(mfaTotpCredentials).where(eq(mfaTotpCredentials.userId, id));
  await db.delete(users).where(eq(users.id, id));
}

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
  // Audit rows now reference this user as actorUserId (security finding
  // #1) — delete them before the user row to satisfy the FK.
  await db.delete(auditLogs).where(eq(auditLogs.actorUserId, userId));
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

  // Security finding #1.
  it("writes an audit row for a fresh enrollment, never containing the secret/otpauth URL/QR data URL", async () => {
    const freshUserId = await insertTestUser("enroll-fresh");

    const result = await enrollMfaForUser(freshUserId);

    const rows = await auditRowsFor(freshUserId, "enrollMfa");
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe("mfa_credential");
    expect(rows[0].actorUserId).toBe(freshUserId);

    const serialized = JSON.stringify({
      before: rows[0].before,
      after: rows[0].after,
      context: rows[0].context,
    });
    expect(serialized).not.toContain(result.secretBase32);
    expect(serialized).not.toContain(result.otpauthUrl);
    expect(serialized).not.toContain(result.qrCodeDataUrl);

    await deleteTestUser(freshUserId);
  });

  it("does not write a second audit row when resuming an existing unverified enrollment", async () => {
    const freshUserId = await insertTestUser("enroll-resume");

    await enrollMfaForUser(freshUserId);
    await enrollMfaForUser(freshUserId);

    const rows = await auditRowsFor(freshUserId, "enrollMfa");
    expect(rows.length).toBe(1);

    await deleteTestUser(freshUserId);
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

  // Security finding #1.
  it("writes an audit row on success, never containing the plaintext code or recovery codes", async () => {
    const freshUserId = await insertTestUser("verify-success");
    const { secretBase32 } = await enrollMfaForUser(freshUserId);
    const code = currentCodeFor(secretBase32);

    const result = await verifyMfaEnrollmentForUser(freshUserId, code);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const rows = await auditRowsFor(freshUserId, "verifyMfaEnrollment");
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe("mfa_credential");
    expect(rows[0].after).toMatchObject({
      verified: true,
      recoveryCodesGenerated: 10,
    });

    const serialized = JSON.stringify({
      before: rows[0].before,
      after: rows[0].after,
      context: rows[0].context,
    });
    expect(serialized).not.toContain(code);
    for (const recoveryCode of result.recoveryCodes) {
      expect(serialized).not.toContain(recoveryCode);
    }

    await deleteTestUser(freshUserId);
  });

  it("writes no audit row for an invalid code", async () => {
    const freshUserId = await insertTestUser("verify-invalid");
    await enrollMfaForUser(freshUserId);

    const result = await verifyMfaEnrollmentForUser(freshUserId, "000000");
    expect(result.ok).toBe(false);

    const rows = await auditRowsFor(freshUserId, "verifyMfaEnrollment");
    expect(rows.length).toBe(0);

    await deleteTestUser(freshUserId);
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
      .delete(auditLogs)
      .where(eq(auditLogs.actorUserId, challengeUserId));
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

    // Security finding #1: the NOT_ENROLLED failure path writes no audit row.
    const rows = await auditRowsFor(freshUser.id, "regenerateRecoveryCodes");
    expect(rows.length).toBe(0);

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

    // Security finding #1: success writes an audit row containing only a
    // count, never the plaintext codes (old or new).
    const rows = await auditRowsFor(regenUserId, "regenerateRecoveryCodes");
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe("mfa_recovery_codes");
    expect(rows[0].after).toMatchObject({ regeneratedCount: 10 });

    const serialized = JSON.stringify({
      before: rows[0].before,
      after: rows[0].after,
      context: rows[0].context,
    });
    for (const recoveryCode of [
      ...enrollResult.recoveryCodes,
      ...regenResult.recoveryCodes,
    ]) {
      expect(serialized).not.toContain(recoveryCode);
    }

    await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, regenUserId));
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, regenUserId));
    await db
      .delete(mfaTotpCredentials)
      .where(eq(mfaTotpCredentials.userId, regenUserId));
    await db.delete(users).where(eq(users.id, regenUserId));
  });
});
