import { randomUUID, createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  auditLogs,
  mfaEmailOtps,
  mfaRecoveryCodes,
  mfaTotpCredentials,
  platformMemberships,
  users,
} from "@/lib/db/schema";
import { countUnusedRecoveryCodes, regenerateRecoveryCodesForUser, verifyMfaChallenge } from "./mfa";

const createdUserIds: string[] = [];

async function createUser(options: { platformRole?: "platform_owner" | "platform_admin" } = {}): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mfa-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  if (options.platformRole) {
    await db.insert(platformMemberships).values({ userId: user.id, role: options.platformRole });
  }
  return user.id;
}

async function insertEmailCode(userId: string, code: string): Promise<void> {
  await db.insert(mfaEmailOtps).values({
    userId,
    codeHash: createHash("sha256").update(`${userId}:${code}`).digest("hex"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
}

async function auditRowsFor(actorUserId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.actorUserId, actorUserId), eq(auditLogs.action, action)));
}

afterAll(async () => {
  if (!createdUserIds.length) return;
  await db.delete(mfaRecoveryCodes).where(inArray(mfaRecoveryCodes.userId, createdUserIds));
  await db.delete(mfaEmailOtps).where(inArray(mfaEmailOtps.userId, createdUserIds));
  await db.delete(mfaTotpCredentials).where(inArray(mfaTotpCredentials.userId, createdUserIds));
  await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, createdUserIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe("regenerateRecoveryCodesForUser", () => {
  it("refuses accounts without a platform role (two-step verification doesn't apply to them)", async () => {
    const userId = await createUser();
    const result = await regenerateRecoveryCodesForUser(userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_ELIGIBLE");
    expect(await auditRowsFor(userId, "regenerateRecoveryCodes")).toHaveLength(0);
  });

  it("issues 10 codes to platform staff without any authenticator app, stored only as hashes", async () => {
    const userId = await createUser({ platformRole: "platform_admin" });
    const result = await regenerateRecoveryCodesForUser(userId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.recoveryCodes).toHaveLength(10);
    expect(await countUnusedRecoveryCodes(userId)).toBe(10);
    const rows = await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    for (const row of rows) {
      expect(result.recoveryCodes).not.toContain(row.codeHash);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("replaces the entire code set: old codes stop working, new codes work, audit holds only a count", async () => {
    const userId = await createUser({ platformRole: "platform_owner" });
    const first = await regenerateRecoveryCodesForUser(userId);
    if (!first.ok) throw new Error("test setup failed");

    const second = await regenerateRecoveryCodesForUser(userId);
    if (!second.ok) throw new Error("unreachable");
    expect(second.recoveryCodes.some((code) => first.recoveryCodes.includes(code))).toBe(false);

    expect((await verifyMfaChallenge(userId, "recovery", first.recoveryCodes[0])).ok).toBe(false);
    expect((await verifyMfaChallenge(userId, "recovery", second.recoveryCodes[0])).ok).toBe(true);

    const rows = await auditRowsFor(userId, "regenerateRecoveryCodes");
    expect(rows).toHaveLength(2);
    expect(rows[0].after).toMatchObject({ regeneratedCount: 10 });
    const serialized = JSON.stringify(rows.map((row) => [row.before, row.after, row.context]));
    for (const code of [...first.recoveryCodes, ...second.recoveryCodes]) {
      expect(serialized).not.toContain(code);
    }
  });
});

describe("verifyMfaChallenge", () => {
  it("accepts a correct, unused recovery code once, regardless of case, then rejects reuse", async () => {
    const userId = await createUser({ platformRole: "platform_owner" });
    const issued = await regenerateRecoveryCodesForUser(userId);
    if (!issued.ok) throw new Error("test setup failed");

    expect((await verifyMfaChallenge(userId, "recovery", issued.recoveryCodes[0].toLowerCase())).ok).toBe(true);
    const reuse = await verifyMfaChallenge(userId, "recovery", issued.recoveryCodes[0]);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe("INVALID_CODE");
    expect(await countUnusedRecoveryCodes(userId)).toBe(9);
    expect(await auditRowsFor(userId, "mfa_recovery_code_used")).toHaveLength(1);
  });

  it("lets only one of two parallel submissions of the same recovery code through", async () => {
    const userId = await createUser({ platformRole: "platform_owner" });
    const issued = await regenerateRecoveryCodesForUser(userId);
    if (!issued.ok) throw new Error("test setup failed");

    const results = await Promise.all([
      verifyMfaChallenge(userId, "recovery", issued.recoveryCodes[0]),
      verifyMfaChallenge(userId, "recovery", issued.recoveryCodes[0]),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("rejects a made-up recovery code and another account's recovery code", async () => {
    const userA = await createUser({ platformRole: "platform_owner" });
    const userB = await createUser({ platformRole: "platform_admin" });
    const issuedA = await regenerateRecoveryCodesForUser(userA);
    if (!issuedA.ok) throw new Error("test setup failed");

    expect((await verifyMfaChallenge(userA, "recovery", "AAAAA-AAAAA")).ok).toBe(false);
    expect((await verifyMfaChallenge(userB, "recovery", issuedA.recoveryCodes[0])).ok).toBe(false);
  });

  it("accepts a correct email code and rejects a wrong one with the same generic error", async () => {
    const userId = await createUser({ platformRole: "platform_admin" });
    await insertEmailCode(userId, "482913");

    const wrong = await verifyMfaChallenge(userId, "email", "000000");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toEqual({ code: "INVALID_CODE", message: "Invalid code." });

    expect((await verifyMfaChallenge(userId, "email", "482913")).ok).toBe(true);
  });

  it("an account enrolled with an authenticator app moves to email codes; its TOTP data is kept and its recovery codes still work", async () => {
    const userId = await createUser({ platformRole: "platform_owner" });
    await db.insert(mfaTotpCredentials).values({ userId, secretEncrypted: "legacy-secret", verifiedAt: new Date() });
    const issued = await regenerateRecoveryCodesForUser(userId);
    if (!issued.ok) throw new Error("test setup failed");

    await insertEmailCode(userId, "135799");
    expect((await verifyMfaChallenge(userId, "email", "135799")).ok).toBe(true);
    expect((await verifyMfaChallenge(userId, "recovery", issued.recoveryCodes[3])).ok).toBe(true);

    const totpRows = await db.select().from(mfaTotpCredentials).where(eq(mfaTotpCredentials.userId, userId));
    expect(totpRows).toHaveLength(1);
  });

  it("an account never enrolled with an authenticator app can still pass with an email code", async () => {
    const userId = await createUser({ platformRole: "platform_admin" });
    await insertEmailCode(userId, "246802");
    expect((await verifyMfaChallenge(userId, "email", "246802")).ok).toBe(true);
  });
});
