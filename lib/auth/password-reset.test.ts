import { randomBytes, createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { passwordResetTokens, sessions, users } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import { applyPasswordReset, issuePasswordResetToken } from "./password-reset";

const OLD_PASSWORD = "old-password-123456";
const NEW_PASSWORD = "brand-new-password-654321";

let activeUserId: string;
let activeUserEmail: string;
let disabledUserId: string;

beforeAll(async () => {
  activeUserEmail = `reset-test-${randomUUID()}@example.com`;
  const [active] = await db
    .insert(users)
    .values({
      email: activeUserEmail,
      passwordHash: await hashPassword(OLD_PASSWORD),
    })
    .returning({ id: users.id });
  activeUserId = active.id;

  const [disabled] = await db
    .insert(users)
    .values({
      email: `reset-test-disabled-${randomUUID()}@example.com`,
      passwordHash: await hashPassword(OLD_PASSWORD),
      status: "disabled",
    })
    .returning({ id: users.id });
  disabledUserId = disabled.id;
});

afterAll(async () => {
  await db.delete(sessions).where(eq(sessions.userId, activeUserId));
  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, activeUserId));
  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, disabledUserId));
  await db.delete(users).where(eq(users.id, activeUserId));
  await db.delete(users).where(eq(users.id, disabledUserId));
});

/**
 * issuePasswordResetToken deliberately never returns the raw token (in
 * production it's only logged/emailed, never handed back to the caller).
 * To test applyPasswordReset directly, mint a token the same way it does
 * and insert it ourselves, so the raw value is in hand.
 */
async function insertResetToken(
  userId: string,
  overrides: { expiresAt?: Date; usedAt?: Date } = {},
): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    usedAt: overrides.usedAt,
  });

  return rawToken;
}

describe("issuePasswordResetToken", () => {
  it("creates a token row for an existing active user", async () => {
    await issuePasswordResetToken(activeUserEmail);

    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, activeUserId));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does nothing observable for a nonexistent email", async () => {
    await expect(
      issuePasswordResetToken("no-such-user@example.com"),
    ).resolves.toBeUndefined();
  });

  it("does not create a token for a disabled account", async () => {
    const [disabledUser] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, disabledUserId));

    await issuePasswordResetToken(disabledUser.email);

    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, disabledUserId));

    expect(rows.length).toBe(0);
  });
});

describe("applyPasswordReset", () => {
  it("rejects a token that doesn't exist", async () => {
    const result = await applyPasswordReset("not-a-real-token", NEW_PASSWORD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
  });

  it("rejects an expired token", async () => {
    const token = await insertResetToken(activeUserId, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await applyPasswordReset(token, NEW_PASSWORD);
    expect(result.ok).toBe(false);
  });

  it("rejects an already-used token", async () => {
    const token = await insertResetToken(activeUserId, {
      usedAt: new Date(),
    });

    const result = await applyPasswordReset(token, NEW_PASSWORD);
    expect(result.ok).toBe(false);
  });

  it("succeeds with a valid token: updates the password, marks it used, and revokes sessions", async () => {
    const { token: sessionToken } = await createSession(activeUserId);
    expect(await validateSessionToken(sessionToken)).not.toBeNull();

    const resetToken = await insertResetToken(activeUserId);

    const result = await applyPasswordReset(resetToken, NEW_PASSWORD);
    expect(result.ok).toBe(true);

    const [updatedUser] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, activeUserId));
    await expect(
      verifyPassword(updatedUser.passwordHash, NEW_PASSWORD),
    ).resolves.toBe(true);

    expect(await validateSessionToken(sessionToken)).toBeNull();

    // Reusing the same (now-used) token must fail.
    const reuseResult = await applyPasswordReset(resetToken, NEW_PASSWORD);
    expect(reuseResult.ok).toBe(false);
  });
});
