import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  auditLogs,
  passwordResetTokens,
  platformAdminPermissions,
  platformMemberships,
  sessions,
  users,
} from "@/lib/db/schema";
import {
  getPlatformRole,
  resolveAuthContext,
  resolveAuthContextForSessionToken,
  type AuthContext,
} from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { createSession, hashSessionToken } from "@/lib/auth/session";
import { attemptSignIn } from "@/lib/auth/sign-in";
import { countActiveOwnersExcluding } from "./owner-guard";
import {
  archivePlatformStaff,
  createPlatformStaffAccount,
  deletePlatformStaffPermanently,
  grantPlatformPermission,
  listPlatformStaff,
  restorePlatformStaff,
  updatePlatformStaff,
} from "./staff";

// Real implementation by default; individual tests force "no other active
// owner" with mockResolvedValueOnce(0). The test database is shared by
// parallel test files that create their own owners, so the real count can't
// be driven to zero deterministically — the count itself is tested for
// real (under a snapshot) in its own describe block below.
vi.mock("./owner-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./owner-guard")>();
  return { ...actual, countActiveOwnersExcluding: vi.fn(actual.countActiveOwnersExcluding) };
});

const PASSWORD = "a-valid-password-123";
const userIds: string[] = [];
let ownerId: string;
let ownerContext: AuthContext;

async function insertUser(role?: "platform_owner" | "platform_admin"): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `lifecycle-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  if (role) await db.insert(platformMemberships).values({ userId: user.id, role, fullName: "Fixture Person" });
  userIds.push(user.id);
  return user.id;
}

async function createStaff(role: "platform_owner" | "platform_admin" = "platform_admin") {
  const email = `lifecycle-staff-${randomUUID()}@example.com`;
  const result = await createPlatformStaffAccount(ownerContext, {
    fullName: "Test Staff",
    email,
    password: PASSWORD,
    role,
  });
  if (!result.ok) throw new Error(result.error.message);
  userIds.push(result.userId);
  return { userId: result.userId, email };
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  ownerId = await insertUser("platform_owner");
  ownerContext = await resolveAuthContext(ownerId);
});

afterAll(async () => {
  if (userIds.length === 0) return;
  await db
    .delete(auditLogs)
    .where(or(inArray(auditLogs.actorUserId, userIds), inArray(auditLogs.entityId, userIds)));
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, userIds));
  await db.delete(platformAdminPermissions).where(inArray(platformAdminPermissions.userId, userIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe("authorization — only an active platform_owner manages staff", () => {
  it("lets the platform owner create a named staff account with a chosen role", async () => {
    const { userId } = await createStaff("platform_admin");
    const [membership] = await db
      .select({ role: platformMemberships.role, fullName: platformMemberships.fullName })
      .from(platformMemberships)
      .where(eq(platformMemberships.userId, userId));
    expect(membership).toEqual({ role: "platform_admin", fullName: "Test Staff" });
    expect(await auditActions(userId)).toContain("createPlatformAdminAccount");
  });

  it("denies a platform_admin every staff action, even with every grant", async () => {
    const adminId = await insertUser("platform_admin");
    for (const capability of ["recordSubscriptionPayment", "queryAuditLogs", "getPlatformReports"]) {
      await db.insert(platformAdminPermissions).values({ userId: adminId, capability });
    }
    const adminContext = await resolveAuthContext(adminId);
    const target = await insertUser("platform_admin");

    const results = [
      await createPlatformStaffAccount(adminContext, {
        fullName: "Nope Person",
        email: `nope-${randomUUID()}@example.com`,
        password: PASSWORD,
        role: "platform_admin",
      }),
      await updatePlatformStaff(adminContext, { userId: target, fullName: "Changed", email: "x@example.com", role: "platform_owner" }),
      await archivePlatformStaff(adminContext, { userId: target }),
      await restorePlatformStaff(adminContext, { userId: target }),
      await deletePlatformStaffPermanently(adminContext, { userId: target, confirmEmail: "x" }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
    expect(await getPlatformRole(target)).toBe("platform_admin");
  });

  it("denies academy staff (no platform role, academy role only)", async () => {
    const academyUserId = await insertUser();
    const academyContext: AuthContext = {
      userId: academyUserId,
      academyId: randomUUID(),
      academyRole: "academy_owner",
      branchIds: [],
      academyWide: true,
    };
    expect(await hasPermission(academyContext, "platform.staff.manage")).toBe(false);
    const result = await archivePlatformStaff(academyContext, { userId: ownerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("rejects a duplicate email and an invalid role", async () => {
    const { email } = await createStaff();
    const dup = await createPlatformStaffAccount(ownerContext, {
      fullName: "Dup Person",
      email: email.toUpperCase(),
      password: PASSWORD,
      role: "platform_admin",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("email_taken");

    const badRole = await createPlatformStaffAccount(ownerContext, {
      fullName: "Bad Role",
      email: `bad-role-${randomUUID()}@example.com`,
      password: PASSWORD,
      role: "academy_owner",
    });
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.error.code).toBe("validation");
  });
});

describe("archive and restore", () => {
  it("revokes sessions, blocks sign-in and platform access, and keeps audit history", async () => {
    const { userId, email } = await createStaff();
    await db.insert(platformAdminPermissions).values({ userId, capability: "queryAuditLogs" });
    const { token } = await createSession(userId);
    expect((await resolveAuthContextForSessionToken(token))?.platformRole).toBe("platform_admin");

    const archived = await archivePlatformStaff(ownerContext, { userId, reason: "Left the company" });
    expect(archived).toEqual({ ok: true, sessionsRevoked: 1, signInDisabled: true });

    // The existing session is dead, and so is any new sign-in attempt.
    expect(await resolveAuthContextForSessionToken(token)).toBeNull();
    const [session] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(session.revokedAt).not.toBeNull();
    expect((await attemptSignIn(email, PASSWORD)).ok).toBe(false);
    expect(await getPlatformRole(userId)).toBeUndefined();

    // Grants are revoked; audit rows (create + archive) are all still there.
    const grants = await db.select().from(platformAdminPermissions).where(eq(platformAdminPermissions.userId, userId));
    expect(grants).toHaveLength(0);
    expect(await auditActions(userId)).toEqual(expect.arrayContaining(["createPlatformAdminAccount", "archivePlatformStaff"]));
    const [archiveRow] = await db
      .select({ reason: auditLogs.reason, before: auditLogs.before })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, "archivePlatformStaff")));
    expect(archiveRow.reason).toBe("Left the company");
    expect(archiveRow.before).toMatchObject({ grants: ["queryAuditLogs"] });

    // An archived account can't be edited or granted to.
    const edit = await updatePlatformStaff(ownerContext, { userId, fullName: "X Y", email, role: "platform_admin" });
    expect(edit.ok).toBe(false);
    const grant = await grantPlatformPermission(ownerContext, userId, "queryAuditLogs");
    expect(grant.ok).toBe(false);
  });

  it("rejects a session for a disabled user even if it was never revoked", async () => {
    const userId = await insertUser("platform_admin");
    const { token } = await createSession(userId);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, userId));
    expect(await resolveAuthContextForSessionToken(token)).toBeNull();
  });

  it("restores sign-in and the original role through a fresh sign-in only", async () => {
    const { userId, email } = await createStaff();
    const { token: oldToken } = await createSession(userId);
    await archivePlatformStaff(ownerContext, { userId });

    const restored = await restorePlatformStaff(ownerContext, { userId });
    expect(restored.ok).toBe(true);
    expect(await auditActions(userId)).toContain("restorePlatformStaff");

    expect(await resolveAuthContextForSessionToken(oldToken)).toBeNull();
    expect((await attemptSignIn(email, PASSWORD)).ok).toBe(true);
    const { token: newToken } = await createSession(userId);
    expect((await resolveAuthContextForSessionToken(newToken))?.platformRole).toBe("platform_admin");

    const again = await restorePlatformStaff(ownerContext, { userId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("not_archived");
  });

  it("refuses to archive the actor's own account", async () => {
    const result = await archivePlatformStaff(ownerContext, { userId: ownerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_action");
    expect(await getPlatformRole(ownerId)).toBe("platform_owner");
  });
});

describe("role changes", () => {
  it("promotes an admin: grants cleared, sessions revoked, new role after re-sign-in", async () => {
    const { userId, email } = await createStaff("platform_admin");
    await db.insert(platformAdminPermissions).values({ userId, capability: "getPlatformReports" });
    const { token } = await createSession(userId);

    const result = await updatePlatformStaff(ownerContext, { userId, fullName: "Test Staff", email, role: "platform_owner" });
    expect(result).toEqual({ ok: true, sessionsRevoked: 1 });

    expect(await resolveAuthContextForSessionToken(token)).toBeNull();
    expect(await getPlatformRole(userId)).toBe("platform_owner");
    const grants = await db.select().from(platformAdminPermissions).where(eq(platformAdminPermissions.userId, userId));
    expect(grants).toHaveLength(0);
    expect(await auditActions(userId)).toContain("changePlatformStaffRole");
  });

  it("demotes an owner when another active owner remains, and the demotion takes effect", async () => {
    const { userId, email } = await createStaff("platform_owner");
    const result = await updatePlatformStaff(ownerContext, { userId, fullName: "Test Staff", email, role: "platform_admin" });
    expect(result.ok).toBe(true);
    const demotedContext = await resolveAuthContext(userId);
    expect(await hasPermission(demotedContext, "platform.staff.manage")).toBe(false);
  });

  it("refuses to change the actor's own role or email", async () => {
    const [self] = await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId));
    const role = await updatePlatformStaff(ownerContext, { userId: ownerId, fullName: "Owner Person", email: self.email, role: "platform_admin" });
    expect(role.ok).toBe(false);
    if (!role.ok) expect(role.error.code).toBe("self_action");
    const mail = await updatePlatformStaff(ownerContext, {
      userId: ownerId,
      fullName: "Owner Person",
      email: `moved-${randomUUID()}@example.com`,
      role: "platform_owner",
    });
    expect(mail.ok).toBe(false);
    if (!mail.ok) expect(mail.error.code).toBe("self_action");
  });

  it("invalidates outstanding password-reset links when the email changes", async () => {
    const { userId } = await createStaff();
    const [reset] = await db
      .insert(passwordResetTokens)
      .values({ userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: passwordResetTokens.id });
    const newEmail = `renamed-${randomUUID()}@example.com`;
    const result = await updatePlatformStaff(ownerContext, { userId, fullName: "Renamed Person", email: newEmail, role: "platform_admin" });
    expect(result.ok).toBe(true);
    const [row] = await db.select({ usedAt: passwordResetTokens.usedAt }).from(passwordResetTokens).where(eq(passwordResetTokens.id, reset.id));
    expect(row.usedAt).not.toBeNull();
    expect((await attemptSignIn(newEmail, PASSWORD)).ok).toBe(true);
  });
});

describe("last active platform owner", () => {
  it("counts only other, non-archived, enabled owners", async () => {
    const activeOwner = await insertUser("platform_owner");
    const archivedOwner = await insertUser("platform_owner");
    await db.update(platformMemberships).set({ archivedAt: new Date() }).where(eq(platformMemberships.userId, archivedOwner));
    const disabledOwner = await insertUser("platform_owner");
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, disabledOwner));

    // One snapshot, so parallel test files can't change the totals mid-way.
    const [all, withoutActive, withoutArchived, withoutDisabled] = await db.transaction(
      async (tx) => [
        await countActiveOwnersExcluding(tx, randomUUID()),
        await countActiveOwnersExcluding(tx, activeOwner),
        await countActiveOwnersExcluding(tx, archivedOwner),
        await countActiveOwnersExcluding(tx, disabledOwner),
      ],
      { isolationLevel: "repeatable read" },
    );
    expect(all - withoutActive).toBe(1);
    expect(all - withoutArchived).toBe(0);
    expect(all - withoutDisabled).toBe(0);
  });

  it("refuses to archive or demote the last active owner, and changes nothing", async () => {
    const { userId, email } = await createStaff("platform_owner");

    vi.mocked(countActiveOwnersExcluding).mockResolvedValueOnce(0);
    const archive = await archivePlatformStaff(ownerContext, { userId });
    expect(archive.ok).toBe(false);
    if (!archive.ok) expect(archive.error.code).toBe("last_owner");

    vi.mocked(countActiveOwnersExcluding).mockResolvedValueOnce(0);
    const demote = await updatePlatformStaff(ownerContext, { userId, fullName: "Test Staff", email, role: "platform_admin" });
    expect(demote.ok).toBe(false);
    if (!demote.ok) expect(demote.error.code).toBe("last_owner");

    expect(await getPlatformRole(userId)).toBe("platform_owner");
    expect(await auditActions(userId)).not.toContain("archivePlatformStaff");
    expect(await auditActions(userId)).not.toContain("changePlatformStaffRole");
  });
});

describe("permanent deletion", () => {
  it("requires the account to be archived and the email typed exactly", async () => {
    const { userId, email } = await createStaff();
    const active = await deletePlatformStaffPermanently(ownerContext, { userId, confirmEmail: email });
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.error.code).toBe("not_archived");

    await archivePlatformStaff(ownerContext, { userId });
    const wrong = await deletePlatformStaffPermanently(ownerContext, { userId, confirmEmail: "someone@example.com" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("validation");
  });

  it("deletes an archived account with no history and keeps every audit row", async () => {
    const { userId, email } = await createStaff();
    await archivePlatformStaff(ownerContext, { userId });
    const listed = (await listPlatformStaff()).find((account) => account.userId === userId);
    expect(listed?.canPermanentlyDelete).toBe(true);

    const result = await deletePlatformStaffPermanently(ownerContext, { userId, confirmEmail: email });
    expect(result.ok).toBe(true);

    expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
    expect(await auditActions(userId)).toEqual(
      expect.arrayContaining(["createPlatformAdminAccount", "archivePlatformStaff", "deletePlatformStaff"]),
    );
  });

  it("keeps an account with sign-in history archived instead of deleting it", async () => {
    const { userId, email } = await createStaff();
    await createSession(userId);
    await archivePlatformStaff(ownerContext, { userId });
    const listed = (await listPlatformStaff()).find((account) => account.userId === userId);
    expect(listed?.canPermanentlyDelete).toBe(false);

    const result = await deletePlatformStaffPermanently(ownerContext, { userId, confirmEmail: email });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("has_history");
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("keeps an account that other records reference (audit actor) archived", async () => {
    const { userId, email } = await createStaff();
    await db.insert(auditLogs).values({ actorUserId: userId, action: "test.fixture", entityType: "test" });
    await archivePlatformStaff(ownerContext, { userId });
    const result = await deletePlatformStaffPermanently(ownerContext, { userId, confirmEmail: email });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("has_history");
    const [row] = await db.select({ archivedAt: platformMemberships.archivedAt }).from(platformMemberships).where(eq(platformMemberships.userId, userId));
    expect(row.archivedAt).not.toBeNull();
  });

  it("never exposes credentials in the staff list", async () => {
    const staff = await listPlatformStaff();
    const keys = new Set(staff.flatMap((account) => Object.keys(account)));
    for (const sensitive of ["passwordHash", "tokenHash", "failedLoginAttempts", "lockedUntil"]) {
      expect(keys.has(sensitive)).toBe(false);
    }
  });
});
