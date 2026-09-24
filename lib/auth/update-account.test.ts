import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, sessions, users } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import { changeOwnPassword, updateOwnAccount, updateOwnEmail } from "./update-account";

const CURRENT_PASSWORD = "current-password-123456";

let userId: string;
let userEmail: string;
let otherUserId: string;
const additionalUserIds: string[] = [];

async function createFreshUser(password = CURRENT_PASSWORD): Promise<{ id: string; email: string }> {
  const email = `update-account-test-fresh-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });
  additionalUserIds.push(user.id);
  return { id: user.id, email };
}

beforeAll(async () => {
  userEmail = `update-account-test-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email: userEmail, passwordHash: await hashPassword(CURRENT_PASSWORD) })
    .returning({ id: users.id });
  userId = user.id;

  const [other] = await db
    .insert(users)
    .values({
      email: `update-account-test-other-${randomUUID()}@example.com`,
      passwordHash: await hashPassword(CURRENT_PASSWORD),
    })
    .returning({ id: users.id });
  otherUserId = other.id;
});

afterAll(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.actorUserId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherUserId));
  for (const id of additionalUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("updateOwnEmail", () => {
  it("rejects the wrong current password", async () => {
    const context = await resolveAuthContext(userId);
    const result = await updateOwnEmail(context, {
      currentPassword: "not-the-right-password",
      newEmail: `new-${randomUUID()}@example.com`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wrong_password");
  });

  it("rejects an email already taken by another account", async () => {
    const context = await resolveAuthContext(userId);
    const [other] = await db.select({ email: users.email }).from(users).where(eq(users.id, otherUserId));

    const result = await updateOwnEmail(context, {
      currentPassword: CURRENT_PASSWORD,
      newEmail: other.email,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("email_taken");
  });

  it("rejects an invalid email", async () => {
    const context = await resolveAuthContext(userId);
    const result = await updateOwnEmail(context, {
      currentPassword: CURRENT_PASSWORD,
      newEmail: "not-an-email",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("updates the email with the correct current password", async () => {
    const context = await resolveAuthContext(userId);
    const newEmail = `updated-${randomUUID()}@example.com`;

    const result = await updateOwnEmail(context, { currentPassword: CURRENT_PASSWORD, newEmail });
    expect(result.ok).toBe(true);

    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    expect(row.email).toBe(newEmail);
    userEmail = newEmail;
  });
});

describe("changeOwnPassword", () => {
  const NEW_PASSWORD = "brand-new-password-654321";

  it("rejects the wrong current password", async () => {
    const context = await resolveAuthContext(userId);
    const result = await changeOwnPassword(context, {
      currentPassword: "not-the-right-password",
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wrong_password");
  });

  it("rejects a mismatched confirmation", async () => {
    const context = await resolveAuthContext(userId);
    const result = await changeOwnPassword(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: "something-else-entirely",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a new password shorter than the policy minimum", async () => {
    const context = await resolveAuthContext(userId);
    const result = await changeOwnPassword(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "short1",
      confirmPassword: "short1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("changes the password and revokes every other session, keeping the current one alive", async () => {
    const context = await resolveAuthContext(userId);
    const { token: otherSessionToken } = await createSession(userId);
    expect(await validateSessionToken(otherSessionToken)).not.toBeNull();

    const result = await changeOwnPassword(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(result.ok).toBe(true);

    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
    await expect(verifyPassword(row.passwordHash, NEW_PASSWORD)).resolves.toBe(true);

    // changeOwnPassword itself (lib/auth/update-account.ts) does not revoke
    // sessions — that's the "use server" wrapper's job
    // (lib/auth/update-account-actions.ts), so the pre-existing session is
    // still valid at this layer. Covered here only to document the
    // boundary; the wrapper's own session-revocation call is a thin,
    // untested-by-design glue layer (same convention as
    // lib/auth/session-actions.ts's own actions).
    expect(await validateSessionToken(otherSessionToken)).not.toBeNull();
  });
});

describe("updateOwnAccount (unified single-form action)", () => {
  it("rejects the wrong current password", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);
    const result = await updateOwnAccount(context, {
      currentPassword: "not-the-right-password",
      newEmail: `new-${randomUUID()}@example.com`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wrong_password");
  });

  it("rejects when neither a new email nor a new password is provided", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);
    const result = await updateOwnAccount(context, { currentPassword: CURRENT_PASSWORD });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("updates only the email when only a new email is given", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);
    const newEmail = `updated-solo-${randomUUID()}@example.com`;

    const result = await updateOwnAccount(context, { currentPassword: CURRENT_PASSWORD, newEmail });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBe(newEmail);
      expect(result.passwordChanged).toBe(false);
    }

    const [row] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(newEmail);
    await expect(verifyPassword(row.passwordHash, CURRENT_PASSWORD)).resolves.toBe(true);
  });

  it("updates only the password when only a new password is given", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);
    const newPassword = "solo-password-change-999999";

    const result = await updateOwnAccount(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword,
      confirmPassword: newPassword,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBeUndefined();
      expect(result.passwordChanged).toBe(true);
    }

    const [row] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(user.email);
    await expect(verifyPassword(row.passwordHash, newPassword)).resolves.toBe(true);
  });

  it("updates both email and password in a single call", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);
    const newEmail = `updated-both-${randomUUID()}@example.com`;
    const newPassword = "both-at-once-password-888888";

    const result = await updateOwnAccount(context, {
      currentPassword: CURRENT_PASSWORD,
      newEmail,
      newPassword,
      confirmPassword: newPassword,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBe(newEmail);
      expect(result.passwordChanged).toBe(true);
    }

    const [row] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(newEmail);
    await expect(verifyPassword(row.passwordHash, newPassword)).resolves.toBe(true);
  });

  it("rejects a mismatched password confirmation, leaving the account untouched", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);

    const result = await updateOwnAccount(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "some-new-password-777777",
      confirmPassword: "a-different-password-666666",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    await expect(verifyPassword(row.passwordHash, CURRENT_PASSWORD)).resolves.toBe(true);
  });

  it("rejects a new password shorter than the policy minimum", async () => {
    const user = await createFreshUser();
    const context = await resolveAuthContext(user.id);

    const result = await updateOwnAccount(context, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: "short1",
      confirmPassword: "short1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an email already taken by another account", async () => {
    const user = await createFreshUser();
    const other = await createFreshUser();
    const context = await resolveAuthContext(user.id);

    const result = await updateOwnAccount(context, { currentPassword: CURRENT_PASSWORD, newEmail: other.email });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("email_taken");
  });
});
