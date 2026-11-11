/**
 * Direct staff account creation with a temporary password, and the
 * mandatory password change at first sign-in. Runs against
 * TEST_DATABASE_URL only and removes every row it creates.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// No email may be sent by direct account creation. Spied, never delivered.
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock("@/lib/email/client", () => ({ sendEmail: sendEmailMock }));

import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  platformMemberships,
  sessions,
  staffBranchAssignments,
  staffInvitations,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  CHANGE_PASSWORD_PATH,
  getPostLoginRedirectPath,
  resolveAuthContextForSessionToken,
  resolvePasswordChangeSession,
} from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import { attemptSignIn } from "@/lib/auth/sign-in";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { changeTemporaryPassword } from "@/lib/auth/change-password";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { TEST_TEMPORARY_PASSWORD } from "@/lib/testing/staff-account-helpers";
import { checkAcademyAccess } from "./access-gate";
import { getAcademyAuditLogs } from "./audit-logs";
import { createStaff, type CreateStaffInput } from "./staff";

const userIds: string[] = [];
const academyIds: string[] = [];
const planIds: string[] = [];

const ctx = (userId: string): AuthContext => ({ userId, branchIds: [], academyWide: false });

async function createUser(passwordHash = "fixture-hash-not-real"): Promise<{ id: string; email: string }> {
  const email = `direct-staff-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash }).returning({ id: users.id });
  userIds.push(user.id);
  return { id: user.id, email };
}

async function createAcademy(): Promise<string> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Direct Staff Academy ${randomUUID()}`, slug: `direct-staff-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator.id })
    .returning({ id: academies.id });
  academyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Direct staff creation fixture",
      name: `Direct Staff Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 50,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  planIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", createdBy: creator.id });
  return academy.id;
}

async function addMember(academyId: string, role: AcademyRole, branchIds: string[] = []): Promise<{ id: string; email: string }> {
  const user = await createUser();
  await db.insert(academyMemberships).values({ userId: user.id, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) && branchIds.length === 0 });
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId: user.id, fullName: `Member ${role}`, phone: "+1-555-0100", email: user.email })
    .returning({ id: staffProfiles.id });
  for (const branchId of branchIds) await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profile.id, branchId });
  return user;
}

async function addBranch(academyId: string, isMain = false): Promise<string> {
  const code = `B-${randomUUID().slice(0, 8)}`;
  const [row] = await db.insert(branches).values({ academyId, name: `Branch ${code}`, code, isMain }).returning({ id: branches.id });
  return row.id;
}

function input(overrides: Partial<CreateStaffInput> = {}): CreateStaffInput {
  return {
    email: `direct-new-${randomUUID()}@example.com`,
    fullName: "Direct New Staff",
    phone: "+1-555-0123",
    role: "trainer",
    temporaryPassword: TEST_TEMPORARY_PASSWORD,
    ...overrides,
  };
}

async function create(actor: string, overrides: Partial<CreateStaffInput> = {}) {
  const result = await createStaff(ctx(actor), input(overrides));
  if (result.ok) userIds.push(result.userId);
  return result;
}

const userByEmail = async (email: string) => (await db.select().from(users).where(eq(users.email, email.toLowerCase())))[0];

beforeEach(() => {
  sendEmailMock.mockClear();
});

afterAll(async () => {
  await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, academyIds), inArray(auditLogs.actorUserId, userIds), inArray(auditLogs.entityId, userIds)));
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  await db.delete(platformMemberships).where(inArray(platformMemberships.userId, userIds));
  for (const academyId of academyIds) {
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(staffInvitations).where(eq(staffInvitations.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of planIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of userIds) await db.delete(users).where(eq(users.id, userId));
}, 240_000);

describe("createStaff — direct account creation", () => {
  it("creates an active account, membership, profile, branch assignment and audit row at once (1, 8, 15, 16)", async () => {
    const academy = await createAcademy();
    const main = await addBranch(academy, true);
    const owner = await addMember(academy, "academy_owner");
    const email = `Direct-Mixed-${randomUUID()}@Example.com`;

    const result = await create(owner.id, { email, role: "manager", workplace: "specific", branchIds: [main], employeeNumber: "E-7", hireDate: "2026-01-15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Safe response: identifiers only, never a password or hash.
    expect(Object.keys(result).sort()).toEqual(["email", "ok", "role", "staffProfileId", "userId"]);
    expect(JSON.stringify(result)).not.toContain(TEST_TEMPORARY_PASSWORD);
    expect(result.email).toBe(email.toLowerCase());

    // Account: Argon2id, never plaintext, must change its password.
    const user = await userByEmail(email);
    expect(user.id).toBe(result.userId);
    expect(user.status).toBe("active");
    expect(user.mustChangePassword).toBe(true);
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.passwordHash).not.toContain(TEST_TEMPORARY_PASSWORD);
    expect(await verifyPassword(user.passwordHash, TEST_TEMPORARY_PASSWORD)).toBe(true);

    const [membership] = await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, user.id), eq(academyMemberships.academyId, academy)));
    expect(membership).toMatchObject({ role: "manager", status: "active", academyWide: false });
    const [profile] = await db.select().from(staffProfiles).where(eq(staffProfiles.id, result.staffProfileId));
    expect(profile).toMatchObject({ academyId: academy, userId: user.id, fullName: "Direct New Staff", phone: "+1-555-0123", employeeNumber: "E-7", hireDate: "2026-01-15", status: "active" });
    const assigned = await db.select({ branchId: staffBranchAssignments.branchId }).from(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, profile.id));
    expect(assigned.map((a) => a.branchId)).toEqual([main]);

    // The account opens the academy immediately (once the password is changed).
    expect((await checkAcademyAccess(user.id)).level).toBe("full");

    // Audited in the academy, never with the password or hash.
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.academyId, academy), eq(auditLogs.entityId, profile.id)));
    expect(audit.map((a) => a.action)).toEqual(["createStaff"]);
    expect(audit[0].actorUserId).toBe(owner.id);
    expect(audit[0].actorRole).toBe("academy_owner");
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(TEST_TEMPORARY_PASSWORD);
    expect(serialized).not.toContain(user.passwordHash);

    // No invitation and no email.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await db.select().from(staffInvitations).where(eq(staffInvitations.academyId, academy))).toHaveLength(0);
  }, 120_000);

  it("rejects an invalid email and missing required fields, writing nothing (2, 4)", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const cases: [Partial<CreateStaffInput>, RegExp][] = [
      [{ email: "not-an-email" }, /email/i],
      [{ email: "" }, /email/i],
      [{ fullName: "   " }, /full name/i],
      [{ phone: "" }, /phone/i],
      [{ temporaryPassword: "" }, /password/i],
      [{ temporaryPassword: "short" }, /at least 8/i],
      [{ temporaryPassword: "x".repeat(129) }, /at most 128/i],
      [{ role: "platform_owner" as AcademyRole }, /./],
    ];
    for (const [overrides, message] of cases) {
      const email = overrides.email ?? `direct-invalid-${randomUUID()}@example.com`;
      const result = await createStaff(ctx(owner.id), input({ ...overrides, email }));
      expect(result.ok, JSON.stringify(overrides).slice(0, 60)).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("validation");
        expect(result.error.message).toMatch(message);
      }
      if (email.includes("@")) expect(await userByEmail(email)).toBeUndefined();
    }
  }, 120_000);

  it("refuses a duplicate email — in this academy, elsewhere, or with different case — and leaves the account untouched (3, 7)", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const ownerB = await addMember(B, "academy_owner");
    const victim = await addMember(A, "trainer");
    const { token } = await createSession(victim.id);
    const before = await userByEmail(victim.email);

    const elsewhere = await createStaff(ctx(ownerB.id), input({ email: victim.email.toUpperCase(), temporaryPassword: "attacker-Chosen-1" }));
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.error.code).toBe("conflict");

    const after = await userByEmail(victim.email);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(false);
    expect(await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, victim.id), eq(academyMemberships.academyId, B)))).toHaveLength(0);
    expect(await validateSessionToken(token)).not.toBeNull();
    expect((await checkAcademyAccess(victim.id)).level).toBe("full");

    // Same email twice in the same academy.
    const email = `direct-dup-${randomUUID()}@example.com`;
    expect((await create(ownerB.id, { email })).ok).toBe(true);
    const again = await createStaff(ctx(ownerB.id), input({ email }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("already_staff");
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  }, 120_000);

  it("concurrent creations for one email create exactly one account (3)", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `direct-race-${randomUUID()}@example.com`;
    const results = await Promise.all([1, 2, 3].map(() => createStaff(ctx(owner.id), input({ email }))));
    for (const r of results) if (r.ok) userIds.push(r.userId);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  }, 120_000);

  it("refuses branches of another academy and branches outside the creator's own (5, 7)", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const mainA = await addBranch(A, true);
    const otherA = await addBranch(A);
    const branchB = await addBranch(B, true);
    const ownerA = await addMember(A, "academy_owner");
    const managerA = await addMember(A, "manager", [mainA]);

    const foreign = await createStaff(ctx(ownerA.id), input({ workplace: "specific", branchIds: [branchB] }));
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("validation");

    const outside = await createStaff(ctx(managerA.id), input({ workplace: "specific", branchIds: [otherA] }));
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("forbidden");

    const notUuid = await createStaff(ctx(ownerA.id), input({ workplace: "specific", branchIds: ["not-a-uuid"] }));
    expect(notUuid.ok).toBe(false);

    // Nothing was written for any of them, in either academy.
    expect(await db.select().from(staffBranchAssignments).where(eq(staffBranchAssignments.branchId, branchB))).toHaveLength(0);
    const profilesB = await db.select().from(staffProfiles).where(eq(staffProfiles.academyId, B));
    expect(profilesB).toHaveLength(0);
  }, 120_000);

  it("enforces who may create and which roles they may grant (6)", async () => {
    const academy = await createAcademy();
    const main = await addBranch(academy, true);
    const trainer = await addMember(academy, "trainer", [main]);
    const manager = await addMember(academy, "manager", [main]);
    const admin = await addMember(academy, "academy_admin");
    const stranger = await createUser();

    const byTrainer = await createStaff(ctx(trainer.id), input());
    expect(byTrainer.ok).toBe(false);
    if (!byTrainer.ok) expect(byTrainer.error.code).toBe("forbidden");

    const byStranger = await createStaff(ctx(stranger.id), input());
    expect(byStranger.ok).toBe(false);

    for (const role of ["academy_admin", "academy_owner", "manager"] as const) {
      const r = await createStaff(ctx(manager.id), input({ role }));
      expect(r.ok, `manager -> ${role}`).toBe(false);
    }
    for (const role of ["admissions_officer", "finance_officer"] as const) {
      const r = await createStaff(ctx(admin.id), input({ role }));
      expect(r.ok, `retired ${role}`).toBe(false);
    }
    const ownerByAdmin = await createStaff(ctx(admin.id), input({ role: "academy_owner" }));
    expect(ownerByAdmin.ok).toBe(false);
    const allBranchesByAdmin = await createStaff(ctx(admin.id), input({ workplace: "all" }));
    expect(allBranchesByAdmin.ok).toBe(false);

    // Allowed: Manager -> Trainer in their own branch.
    expect((await create(manager.id, { role: "trainer", workplace: "specific", branchIds: [main] })).ok).toBe(true);
  }, 120_000);

  it("never grants a platform role (14)", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const result = await create(owner.id, { role: "academy_admin" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await db.select().from(platformMemberships).where(eq(platformMemberships.userId, result.userId))).toHaveLength(0);
    expect(await getPostLoginRedirectPath(result.userId)).toBe(CHANGE_PASSWORD_PATH);
  }, 120_000);

  it("keeps audit rows inside the creating academy (15)", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const ownerA = await addMember(A, "academy_owner");
    const ownerB = await addMember(B, "academy_owner");
    const created = await create(ownerA.id);
    if (!created.ok) throw new Error("create failed");

    const seenByA = await getAcademyAuditLogs(ctx(ownerA.id), { action: "createStaff" });
    const seenByB = await getAcademyAuditLogs(ctx(ownerB.id), { action: "createStaff" });
    expect(seenByA.ok && seenByA.data.rows.some((r) => r.entityId === created.staffProfileId)).toBe(true);
    expect(seenByB.ok && seenByB.data.rows.some((r) => r.entityId === created.staffProfileId)).toBe(false);
  }, 120_000);

  it("re-hires a former staff member of this academy only; a former staff member elsewhere is refused", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const ownerA = await addMember(A, "academy_owner");
    const ownerB = await addMember(B, "academy_owner");
    const formerOfA = await createUser(await hashPassword("old-password-123"));
    await db.insert(academyMemberships).values({ userId: formerOfA.id, academyId: A, role: "trainer", status: "removed" });
    const { token } = await createSession(formerOfA.id);

    const byB = await createStaff(ctx(ownerB.id), input({ email: formerOfA.email }));
    expect(byB.ok).toBe(false);

    const byA = await createStaff(ctx(ownerA.id), input({ email: formerOfA.email }));
    expect(byA.ok).toBe(true);
    const account = await userByEmail(formerOfA.email);
    expect(account.mustChangePassword).toBe(true);
    expect(await verifyPassword(account.passwordHash, "old-password-123")).toBe(false);
    // Earlier sessions do not survive the new temporary password.
    expect(await validateSessionToken(token)).toBeNull();
  }, 120_000);
});

describe("First sign-in with a temporary password", () => {
  async function createdStaff() {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `direct-login-${randomUUID()}@example.com`;
    const result = await create(owner.id, { email });
    if (!result.ok) throw new Error("create failed");
    return { academy, email, userId: result.userId };
  }

  it("signs in with the temporary password, but the session opens only /change-password (9, 10, 11)", async () => {
    const { email, userId } = await createdStaff();

    const signIn = await attemptSignIn(email, TEST_TEMPORARY_PASSWORD);
    expect(signIn).toEqual({ ok: true, userId });
    expect((await attemptSignIn(email, "wrong-password-123")).ok).toBe(false);

    expect(await getPostLoginRedirectPath(userId)).toBe(CHANGE_PASSWORD_PATH);
    const { token, session } = await createSession(userId);
    // Every page, server action and API authorizes through this resolver.
    expect(await resolveAuthContextForSessionToken(token)).toBeNull();
    // Only the password-change page accepts it.
    expect(await resolvePasswordChangeSession(token)).toEqual({ userId, sessionId: session.id });
  }, 120_000);

  it("validates the change: current password, policy, confirmation, and must differ (12)", async () => {
    const { userId } = await createdStaff();
    const attempts: [Parameters<typeof changeTemporaryPassword>[1], string][] = [
      [{ currentPassword: "wrong-temporary-1", newPassword: "brand-New-pass-1", confirmPassword: "brand-New-pass-1" }, "INVALID_CURRENT_PASSWORD"],
      [{ currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: "short", confirmPassword: "short" }, "VALIDATION_ERROR"],
      [{ currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: "brand-New-pass-1", confirmPassword: "different-pass-1" }, "VALIDATION_ERROR"],
      [{ currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: TEST_TEMPORARY_PASSWORD, confirmPassword: TEST_TEMPORARY_PASSWORD }, "VALIDATION_ERROR"],
    ];
    for (const [attempt, code] of attempts) {
      const result = await changeTemporaryPassword(userId, attempt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.mustChangePassword).toBe(true);
    expect(await verifyPassword(user.passwordHash, TEST_TEMPORARY_PASSWORD)).toBe(true);
  }, 120_000);

  it("a successful change clears the requirement, revokes old sessions and is audited without secrets (12)", async () => {
    const { email, userId } = await createdStaff();
    const { token: oldToken } = await createSession(userId);
    const NEW_PASSWORD = "my-Own-new-password-9";

    const result = await changeTemporaryPassword(userId, { currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(result).toEqual({ ok: true });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.mustChangePassword).toBe(false);
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(user.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(user.passwordHash, TEST_TEMPORARY_PASSWORD)).toBe(false);

    // Old sessions are gone; a fresh one works normally.
    expect(await validateSessionToken(oldToken)).toBeNull();
    const { token } = await createSession(userId);
    expect(await resolveAuthContextForSessionToken(token)).toMatchObject({ userId });
    expect(await resolvePasswordChangeSession(token)).toBeNull();
    expect(await getPostLoginRedirectPath(userId)).toBe("/academy/dashboard");

    // Temporary password no longer signs in; the new one does.
    expect((await attemptSignIn(email, TEST_TEMPORARY_PASSWORD)).ok).toBe(false);
    expect((await attemptSignIn(email, NEW_PASSWORD)).ok).toBe(true);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, "temporary_password_changed")));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(userId);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain(TEST_TEMPORARY_PASSWORD);
    expect(serialized).not.toContain(user.passwordHash);

    // It cannot be used again.
    const again = await changeTemporaryPassword(userId, { currentPassword: NEW_PASSWORD, newPassword: "another-New-pass-2", confirmPassword: "another-New-pass-2" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("NOT_REQUIRED");
  }, 120_000);

  it("concurrent changes succeed exactly once (12)", async () => {
    const { userId } = await createdStaff();
    const results = await Promise.all(
      ["first-New-pass-1", "second-New-pass-2", "third-New-pass-3"].map((p) =>
        changeTemporaryPassword(userId, { currentPassword: TEST_TEMPORARY_PASSWORD, newPassword: p, confirmPassword: p }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  }, 120_000);
});

describe("Existing accounts are unaffected (13, 14)", () => {
  it("an existing academy account signs in normally and is never sent to /change-password", async () => {
    const academy = await createAcademy();
    const password = "existing-Password-1";
    const member = await createUser(await hashPassword(password));
    await db.insert(academyMemberships).values({ userId: member.id, academyId: academy, role: "trainer", status: "active" });

    const [row] = await db.select().from(users).where(eq(users.id, member.id));
    expect(row.mustChangePassword).toBe(false); // migration default
    expect((await attemptSignIn(member.email, password)).ok).toBe(true);
    expect(await getPostLoginRedirectPath(member.id)).toBe("/academy/dashboard");
    const { token } = await createSession(member.id);
    expect(await resolveAuthContextForSessionToken(token)).toMatchObject({ userId: member.id });
    expect(await resolvePasswordChangeSession(token)).toBeNull();
    // The change-password flow refuses an account that does not need it.
    const change = await changeTemporaryPassword(member.id, { currentPassword: password, newPassword: "unwanted-New-1", confirmPassword: "unwanted-New-1" });
    expect(change.ok).toBe(false);
    if (!change.ok) expect(change.error.code).toBe("NOT_REQUIRED");
  }, 120_000);

  it("platform staff keep their platform landing page and resolve their platform role (MFA path unchanged)", async () => {
    const platformUser = await createUser();
    await db.insert(platformMemberships).values({ userId: platformUser.id, role: "platform_admin" });
    expect(await getPostLoginRedirectPath(platformUser.id)).toBe("/platform/dashboard");
    const { token } = await createSession(platformUser.id);
    expect(await resolveAuthContextForSessionToken(token)).toMatchObject({ userId: platformUser.id, platformRole: "platform_admin" });
  }, 120_000);
});
