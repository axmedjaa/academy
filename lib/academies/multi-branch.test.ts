import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchCourses,
  batches,
  branches,
  courses,
  incomeRecords,
  programs,
  staffBranchAssignments,
  staffProfiles,
  studentCharges,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { archiveBranch, createBranch, deleteBranch, listBranches } from "./branches";
import { getStudent, searchStudents } from "./students";
import { createStudentCharge, listStudentCharges } from "./student-payments";
import { getBatch, listBatches } from "./batches";
import { createIncomeRecord, listIncomeRecords } from "./income-records";
import { createStaff, getStaffWorkplaceOptions, listStaff, type CreateStaffInput } from "./staff";
import { assignStaffBranches, setAllBranchAccess, setStaffWorkplace } from "./staff-branch-assignments";
import { getBranchComparison, listBranchStaff } from "./branch-overview";

/**
 * Multi-branch authorization (migration 0037, lib/academies/branch-access.ts):
 * one academy = one tenant with exactly one Main Branch; members other than
 * the owner work only in their assigned branches unless the owner granted
 * all-branch access, which only Main Branch staff can receive.
 *
 * Fixture: academy X with Main Branch A and branch B, an owner, a manager
 * limited to A, a manager with all-branch access, and one student, batch,
 * charge and income record in each branch; plus academy Y as another tenant.
 */

const userIds: string[] = [];
const academyIds: string[] = [];
const planIds: string[] = [];

const ctx = (userId: string): AuthContext => ({ userId, branchIds: [], academyWide: false });

async function user(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `multi-branch-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  userIds.push(row.id);
  return row.id;
}

async function academyWithOwner() {
  const ownerId = await user();
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/multi-branch.test.ts)",
      name: `Multi Branch Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 50,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  planIds.push(plan.id);
  const [academy] = await db
    .insert(academies)
    .values({ name: `Multi Branch Academy ${randomUUID()}`, slug: `multi-branch-${randomUUID()}`, defaultCurrency: "USD", createdBy: ownerId })
    .returning({ id: academies.id });
  academyIds.push(academy.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", createdBy: ownerId });
  await db.insert(academyMemberships).values({ userId: ownerId, academyId: academy.id, role: "academy_owner", status: "active" });
  return { academyId: academy.id, ownerId };
}

async function branch(academyId: string, isMain: boolean): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db.insert(branches).values({ academyId, name: `Branch ${code}`, code, isMain }).returning({ id: branches.id });
  return row.id;
}

async function member(academyId: string, role: AcademyRole, academyWide: boolean, branchIds: string[]) {
  const userId = await user();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide });
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: `Staff ${role}`, phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  if (branchIds.length) {
    await db.insert(staffBranchAssignments).values(branchIds.map((branchId) => ({ academyId, staffProfileId: profile.id, branchId })));
  }
  return { userId, staffProfileId: profile.id };
}

async function student(academyId: string, branchId: string, createdBy: string): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Branch Student", createdBy })
    .returning({ id: students.id });
  return row.id;
}

async function batch(academyId: string, branchId: string, courseId: string): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  await db.insert(batchCourses).values({ academyId, batchId: row.id, courseId });
  return row.id;
}

let X: { academyId: string; ownerId: string };
let Y: { academyId: string; ownerId: string };
let mainA: string;
let branchB: string;
let branchY: string;
let limitedManager: { userId: string; staffProfileId: string };
let wideManager: { userId: string; staffProfileId: string };
let studentA: string;
let studentB: string;
let studentY: string;
let batchA: string;
let batchB: string;

beforeAll(async () => {
  X = await academyWithOwner();
  Y = await academyWithOwner();
  mainA = await branch(X.academyId, true);
  branchB = await branch(X.academyId, false);
  branchY = await branch(Y.academyId, true);
  limitedManager = await member(X.academyId, "manager", false, [mainA]);
  wideManager = await member(X.academyId, "manager", true, [mainA]);
  studentA = await student(X.academyId, mainA, X.ownerId);
  studentB = await student(X.academyId, branchB, X.ownerId);
  studentY = await student(Y.academyId, branchY, Y.ownerId);

  const [program] = await db.insert(programs).values({ academyId: X.academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId: X.academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  batchA = await batch(X.academyId, mainA, course.id);
  batchB = await batch(X.academyId, branchB, course.id);

  await db.insert(studentCharges).values([
    { academyId: X.academyId, studentId: studentA, description: "Charge A", amountCents: 1000, currency: "USD", createdBy: X.ownerId },
    { academyId: X.academyId, studentId: studentB, description: "Charge B", amountCents: 2000, currency: "USD", createdBy: X.ownerId },
  ]);
  await db.insert(incomeRecords).values([
    { academyId: X.academyId, branchId: mainA, category: "Income A", amountCents: 500, currency: "USD", recordedBy: X.ownerId },
    { academyId: X.academyId, branchId: branchB, category: "Income B", amountCents: 700, currency: "USD", recordedBy: X.ownerId },
  ]);
}, 120_000);

afterAll(async () => {
  if (academyIds.length === 0) return;
  await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, academyIds), inArray(auditLogs.actorUserId, userIds)));
  await db.delete(incomeRecords).where(inArray(incomeRecords.academyId, academyIds));
  await db.delete(studentCharges).where(inArray(studentCharges.academyId, academyIds));
  await db.delete(batchCourses).where(inArray(batchCourses.academyId, academyIds));
  await db.delete(batches).where(inArray(batches.academyId, academyIds));
  await db.delete(courses).where(inArray(courses.academyId, academyIds));
  await db.delete(programs).where(inArray(programs.academyId, academyIds));
  await db.delete(students).where(inArray(students.academyId, academyIds));
  await db.delete(staffBranchAssignments).where(inArray(staffBranchAssignments.academyId, academyIds));
  await db.delete(staffProfiles).where(inArray(staffProfiles.academyId, academyIds));
  await db.delete(branches).where(inArray(branches.academyId, academyIds));
  await db.delete(academySubscriptions).where(inArray(academySubscriptions.academyId, academyIds));
  await db.delete(academyMemberships).where(inArray(academyMemberships.academyId, academyIds));
  await db.delete(academies).where(inArray(academies.id, academyIds));
  await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, planIds));
  await db.delete(users).where(inArray(users.id, userIds));
}, 120_000);

describe("Main Branch", () => {
  it("an academy can never have a second Main Branch (database constraint)", async () => {
    await expect(branch(X.academyId, true)).rejects.toThrow();
  });

  it("createBranch always adds a regular branch, never another Main Branch", { timeout: 60_000 }, async () => {
    const result = await createBranch(ctx(X.ownerId), { name: "Regular", code: `RG-${randomUUID().slice(0, 6)}` });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branch.isMain).toBe(false);
  });

  it("the Main Branch can't be archived or deleted", { timeout: 60_000 }, async () => {
    const archived = await archiveBranch(ctx(X.ownerId), mainA);
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.error.code).toBe("conflict");
    const [main] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, mainA));
    const deleted = await deleteBranch(ctx(X.ownerId), mainA, main.name);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("conflict");
  });

  it("adding branches needs all-branch access", { timeout: 60_000 }, async () => {
    const limited = await createBranch(ctx(limitedManager.userId), { name: "Nope", code: `NO-${randomUUID().slice(0, 6)}` });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("forbidden");
    const wide = await createBranch(ctx(wideManager.userId), { name: "Yes", code: `YS-${randomUUID().slice(0, 6)}` });
    expect(wide.ok).toBe(true);
  });
});

describe("branch-limited member: only their own branch", () => {
  it("lists only the branches they are assigned to", { timeout: 60_000 }, async () => {
    const result = await listBranches(ctx(limitedManager.userId));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branches.map((b) => b.id)).toEqual([mainA]);
      expect(result.canManageStructure).toBe(false);
    }
  });

  it("sees students, charges, batches and income of their branch only", { timeout: 60_000 }, async () => {
    const c = ctx(limitedManager.userId);
    const [search, charges, batchList, income] = await Promise.all([
      searchStudents(c),
      listStudentCharges(c),
      listBatches(c),
      listIncomeRecords(c),
    ]);
    expect(search.ok && search.data.rows.map((s) => s.id)).toEqual([studentA]);
    expect(charges.ok && charges.charges.map((ch) => ch.studentId)).toEqual([studentA]);
    expect(batchList.ok && batchList.batches.map((b) => b.id)).toEqual([batchA]);
    expect(income.ok && income.records.map((r) => r.branchId)).toEqual([mainA]);
  });

  it("another branch's records are 'not found', never shown", { timeout: 60_000 }, async () => {
    const c = ctx(limitedManager.userId);
    const [studentResult, batchResult] = await Promise.all([getStudent(c, studentB), getBatch(c, batchB)]);
    expect(studentResult.ok).toBe(false);
    expect(batchResult.ok).toBe(false);
  });

  it("can't write into another branch (a branch id from the client is checked)", { timeout: 60_000 }, async () => {
    const c = ctx(limitedManager.userId);
    const charge = await createStudentCharge(c, { studentId: studentB, description: "Cross-branch", amountCents: 100 });
    expect(charge.ok).toBe(false);
    const income = await createIncomeRecord(c, { branchId: branchB, category: "Cross-branch", amountCents: 100 });
    expect(income.ok).toBe(false);
    const withoutBranch = await createIncomeRecord(c, { category: "No branch", amountCents: 100 });
    expect(withoutBranch.ok).toBe(false);
    const own = await createIncomeRecord(c, { branchId: mainA, category: "Own branch", amountCents: 100 });
    expect(own.ok).toBe(true);
  });

  it("compares only their own branches", { timeout: 60_000 }, async () => {
    const result = await getBranchComparison(ctx(limitedManager.userId));
    expect(result.ok && result.rows.map((r) => r.branchId)).toEqual([mainA]);
  });
});

describe("consolidated view: owner and all-branch members", () => {
  it("the owner and an all-branch manager see every branch's records", { timeout: 60_000 }, async () => {
    for (const userId of [X.ownerId, wideManager.userId]) {
      const [search, batchList] = await Promise.all([searchStudents(ctx(userId)), listBatches(ctx(userId))]);
      expect(search.ok && search.data.rows.map((s) => s.id).sort()).toEqual([studentA, studentB].sort());
      expect(batchList.ok && batchList.batches.map((b) => b.id).sort()).toEqual([batchA, batchB].sort());
    }
  });

  it("never reaches another academy, even with all-branch access", { timeout: 60_000 }, async () => {
    const c = ctx(wideManager.userId);
    const [studentResult, branchList] = await Promise.all([getStudent(c, studentY), listBranches(c)]);
    expect(studentResult.ok).toBe(false);
    expect(branchList.ok && branchList.branches.some((b) => b.id === branchY)).toBe(false);
    const assign = await assignStaffBranches(c, limitedManager.staffProfileId, [mainA, branchY]);
    expect(assign.ok).toBe(false);
  });
});

describe("staff assignments and all-branch access", () => {
  it("a branch-limited manager sees only staff of their branches and can't assign outside them", { timeout: 60_000 }, async () => {
    const other = await member(X.academyId, "trainer", false, [branchB]);
    const staff = await listStaff(ctx(limitedManager.userId));
    expect(staff.ok && staff.staff.some((s) => s.id === other.staffProfileId)).toBe(false);

    const outside = await assignStaffBranches(ctx(limitedManager.userId), other.staffProfileId, [branchB, mainA]);
    expect(outside.ok).toBe(false);

    const branchStaff = await listBranchStaff(ctx(limitedManager.userId), branchB);
    expect(branchStaff.ok).toBe(false);
  });

  it("only the owner grants all-branch access, only to Main Branch staff, and it is audited", { timeout: 90_000 }, async () => {
    const target = await member(X.academyId, "finance_officer", false, [branchB]);

    const byManager = await setAllBranchAccess(ctx(wideManager.userId), target.staffProfileId, true);
    expect(byManager.ok).toBe(false);
    if (!byManager.ok) expect(byManager.error.code).toBe("forbidden");

    const notOnMain = await setAllBranchAccess(ctx(X.ownerId), target.staffProfileId, true);
    expect(notOnMain.ok).toBe(false);
    if (!notOnMain.ok) expect(notOnMain.error.code).toBe("validation");

    expect((await assignStaffBranches(ctx(X.ownerId), target.staffProfileId, [branchB, mainA])).ok).toBe(true);
    const granted = await setAllBranchAccess(ctx(X.ownerId), target.staffProfileId, true);
    expect(granted.ok && granted.changed).toBe(true);

    const charges = await listStudentCharges(ctx(target.userId));
    expect(charges.ok && charges.charges.map((ch) => ch.studentId).sort()).toEqual([studentA, studentB].sort());

    // Taking them off the Main Branch ends the grant, audited on its own.
    expect((await assignStaffBranches(ctx(X.ownerId), target.staffProfileId, [branchB])).ok).toBe(true);
    const [membership] = await db
      .select({ academyWide: academyMemberships.academyWide })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.academyId, X.academyId), eq(academyMemberships.userId, target.userId)));
    expect(membership.academyWide).toBe(false);

    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.academyId, X.academyId), eq(auditLogs.entityId, target.staffProfileId)));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("grantAllBranchAccess");
    expect(actions).toContain("revokeAllBranchAccess");
    expect(actions).toContain("assignStaffBranches");
  });

  it("the owner's own all-branch access can't be changed", { timeout: 60_000 }, async () => {
    const [ownerProfile] = await db
      .insert(staffProfiles)
      .values({ academyId: X.academyId, userId: X.ownerId, fullName: "Owner", phone: "+1-555-0101" })
      .returning({ id: staffProfiles.id });
    const result = await setAllBranchAccess(ctx(X.ownerId), ownerProfile.id, false);
    expect(result.ok).toBe(false);
  });
});

describe("registering staff: where they work", () => {
  async function register(actorId: string, extra: Partial<CreateStaffInput>) {
    const result = await createStaff(ctx(actorId), {
      email: `multi-branch-test-${randomUUID()}@example.com`,
      password: "temporary-pass-123",
      fullName: "New Staff",
      phone: "+1-555-0102",
      role: "trainer",
      ...extra,
    });
    if (result.ok) userIds.push(result.userId);
    return result;
  }

  async function placement(staffProfileId: string, userId: string) {
    const [membership] = await db
      .select({ academyWide: academyMemberships.academyWide })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.academyId, X.academyId), eq(academyMemberships.userId, userId)));
    const assigned = await db
      .select({ branchId: staffBranchAssignments.branchId })
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, staffProfileId));
    return { academyWide: membership.academyWide, branchIds: assigned.map((row) => row.branchId).sort() };
  }

  it("offers the owner every branch (Main first) and all-branch access; a branch-limited manager only their branches", { timeout: 60_000 }, async () => {
    const owner = await getStaffWorkplaceOptions(ctx(X.ownerId));
    expect(owner.ok && owner.options.canGrantAllBranches).toBe(true);
    // Earlier tests in this file add more branches to academy X.
    const ownerBranchIds = owner.ok ? owner.options.branches.map((b) => b.id) : [];
    expect(ownerBranchIds[0]).toBe(mainA);
    expect(ownerBranchIds).toContain(branchB);

    const limited = await getStaffWorkplaceOptions(ctx(limitedManager.userId));
    expect(limited.ok && limited.options.canGrantAllBranches).toBe(false);
    expect(limited.ok && limited.options.branches.map((b) => b.id)).toEqual([mainA]);
  });

  it("the owner can register someone for all branches: all-branch access on the Main Branch, audited", { timeout: 90_000 }, async () => {
    const result = await register(X.ownerId, { workplace: "all", role: "manager" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await placement(result.staffProfileId, result.userId)).toEqual({ academyWide: true, branchIds: [mainA] });

    const [audit] = await db
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "createStaff"), eq(auditLogs.entityId, result.staffProfileId)));
    expect(audit.after).toMatchObject({ allBranchAccess: true, branchIds: [mainA] });
  });

  it("the owner can register someone for specific branches only", { timeout: 90_000 }, async () => {
    const result = await register(X.ownerId, { workplace: "specific", branchIds: [branchB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await placement(result.staffProfileId, result.userId)).toEqual({ academyWide: false, branchIds: [branchB] });
  });

  it("a branch-limited manager can't give all-branch access or use another branch, only their own", { timeout: 90_000 }, async () => {
    const all = await register(limitedManager.userId, { workplace: "all" });
    expect(!all.ok && all.error.code).toBe("forbidden");

    const other = await register(limitedManager.userId, { workplace: "specific", branchIds: [branchB] });
    expect(!other.ok && other.error.code).toBe("forbidden");

    const own = await register(limitedManager.userId, { workplace: "specific", branchIds: [mainA] });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    expect(await placement(own.staffProfileId, own.userId)).toEqual({ academyWide: false, branchIds: [mainA] });
  });

  it("rejects no branch, and a branch of another academy", { timeout: 60_000 }, async () => {
    const none = await register(X.ownerId, { workplace: "specific", branchIds: [] });
    expect(!none.ok && none.error.code).toBe("validation");

    const foreign = await register(X.ownerId, { workplace: "specific", branchIds: [branchY] });
    expect(!foreign.ok && foreign.error.code).toBe("validation");
  });
});

describe("editing where existing staff work", () => {
  async function snapshot(person: { userId: string; staffProfileId: string }, academyId = X.academyId) {
    const [membership] = await db
      .select({ role: academyMemberships.role, status: academyMemberships.status, academyWide: academyMemberships.academyWide })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.academyId, academyId), eq(academyMemberships.userId, person.userId)));
    const [profile] = await db
      .select({ fullName: staffProfiles.fullName, phone: staffProfiles.phone, status: staffProfiles.status })
      .from(staffProfiles)
      .where(eq(staffProfiles.id, person.staffProfileId));
    const [account] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, person.userId));
    const assigned = await db
      .select({ branchId: staffBranchAssignments.branchId })
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, person.staffProfileId));
    return { membership, profile, account, branchIds: assigned.map((row) => row.branchId).sort() };
  }

  async function auditActions(staffProfileId: string): Promise<string[]> {
    const rows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.academyId, X.academyId), eq(auditLogs.entityId, staffProfileId)));
    return rows.map((row) => row.action);
  }

  it("the owner moves someone to all branches and back; role, status and account never change; every step is audited", { timeout: 120_000 }, async () => {
    const target = await member(X.academyId, "finance_officer", false, [branchB]);
    const before = await snapshot(target);

    const toAll = await setStaffWorkplace(ctx(X.ownerId), target.staffProfileId, { workplace: "all" });
    expect(toAll.ok && toAll.allBranchAccess).toBe(true);
    const all = await snapshot(target);
    expect(all.membership.academyWide).toBe(true);
    expect(all.branchIds).toEqual([mainA, branchB].sort());

    const toSpecific = await setStaffWorkplace(ctx(X.ownerId), target.staffProfileId, { workplace: "specific", branchIds: [branchB] });
    expect(toSpecific.ok && toSpecific.allBranchAccess).toBe(false);
    const after = await snapshot(target);
    expect(after.membership).toEqual({ ...before.membership, academyWide: false });
    expect(after.branchIds).toEqual([branchB]);
    expect(after.profile).toEqual(before.profile);
    expect(after.account).toEqual(before.account);

    const actions = await auditActions(target.staffProfileId);
    expect(actions).toContain("grantAllBranchAccess");
    expect(actions).toContain("revokeAllBranchAccess");
    expect(actions.filter((action) => action === "assignStaffBranches").length).toBeGreaterThanOrEqual(2);
  });

  it("only the owner grants or revokes all-branch access, also through branch edits", { timeout: 90_000 }, async () => {
    const limitedTarget = await member(X.academyId, "trainer", false, [mainA]);
    const wideTarget = await member(X.academyId, "trainer", true, [mainA]);

    const grant = await setStaffWorkplace(ctx(wideManager.userId), limitedTarget.staffProfileId, { workplace: "all" });
    expect(!grant.ok && grant.error.code).toBe("forbidden");

    const revoke = await setStaffWorkplace(ctx(wideManager.userId), wideTarget.staffProfileId, { workplace: "specific", branchIds: [mainA] });
    expect(!revoke.ok && revoke.error.code).toBe("forbidden");

    // Taking them off the Main Branch would end the grant: owner only.
    const offMain = await assignStaffBranches(ctx(wideManager.userId), wideTarget.staffProfileId, [branchB]);
    expect(!offMain.ok && offMain.error.code).toBe("forbidden");
    const unchanged = await snapshot(wideTarget);
    expect(unchanged.membership.academyWide).toBe(true);
    expect(unchanged.branchIds).toEqual([mainA]);
  });

  it("an all-branch manager edits specific branches; a branch-limited manager only their own", { timeout: 120_000 }, async () => {
    const target = await member(X.academyId, "trainer", false, [mainA]);

    const byWide = await setStaffWorkplace(ctx(wideManager.userId), target.staffProfileId, { workplace: "specific", branchIds: [mainA, branchB] });
    expect(byWide.ok).toBe(true);

    // The limited manager (Main A only) keeps branch B as it is when saving
    // their own choice, but can't add or remove B.
    const keep = await setStaffWorkplace(ctx(limitedManager.userId), target.staffProfileId, { workplace: "specific", branchIds: [mainA] });
    expect(keep.ok && [...keep.branchIds].sort()).toEqual([mainA, branchB].sort());

    const elsewhere = await member(X.academyId, "trainer", false, [branchB]);
    const outside = await setStaffWorkplace(ctx(limitedManager.userId), elsewhere.staffProfileId, { workplace: "specific", branchIds: [mainA] });
    expect(!outside.ok && outside.error.code).toBe("forbidden");
    expect((await snapshot(elsewhere)).branchIds).toEqual([branchB]);

    const notAllowed = await setStaffWorkplace(ctx(limitedManager.userId), target.staffProfileId, { workplace: "all" });
    expect(!notAllowed.ok && notAllowed.error.code).toBe("forbidden");
  });

  it("a branch-limited member keeps at least one branch", { timeout: 60_000 }, async () => {
    const target = await member(X.academyId, "trainer", false, [branchB]);
    const empty = await setStaffWorkplace(ctx(X.ownerId), target.staffProfileId, { workplace: "specific", branchIds: [] });
    expect(!empty.ok && empty.error.code).toBe("validation");
    const viaAssign = await assignStaffBranches(ctx(X.ownerId), target.staffProfileId, []);
    expect(!viaAssign.ok && viaAssign.error.code).toBe("validation");
    expect((await snapshot(target)).branchIds).toEqual([branchB]);
  });

  it("never reaches another academy's staff or branches", { timeout: 60_000 }, async () => {
    const yStaff = await member(Y.academyId, "trainer", false, [branchY]);
    const foreignStaff = await setStaffWorkplace(ctx(X.ownerId), yStaff.staffProfileId, { workplace: "specific", branchIds: [mainA] });
    expect(!foreignStaff.ok && foreignStaff.error.code).toBe("not_found");

    const target = await member(X.academyId, "trainer", false, [mainA]);
    const foreignBranch = await setStaffWorkplace(ctx(X.ownerId), target.staffProfileId, { workplace: "specific", branchIds: [branchY] });
    expect(!foreignBranch.ok && foreignBranch.error.code).toBe("validation");
    expect((await snapshot(yStaff, Y.academyId)).branchIds).toEqual([branchY]);
    expect((await snapshot(target)).branchIds).toEqual([mainA]);
  });

  it("the staff list shows where people work, naming only branches the viewer manages", { timeout: 90_000 }, async () => {
    const twoBranches = await member(X.academyId, "trainer", false, [mainA, branchB]);

    const asOwner = await listStaff(ctx(X.ownerId));
    expect(asOwner.ok).toBe(true);
    if (!asOwner.ok) return;
    const ownerRow = asOwner.staff.find((row) => row.id === twoBranches.staffProfileId);
    expect(ownerRow?.branches.map((b) => b.id)).toEqual([mainA, branchB]);
    expect(ownerRow?.otherBranchCount).toBe(0);
    expect(ownerRow?.canEditBranches).toBe(true);
    expect(asOwner.staff.find((row) => row.id === wideManager.staffProfileId)?.allBranchAccess).toBe(true);

    const asLimited = await listStaff(ctx(limitedManager.userId));
    expect(asLimited.ok).toBe(true);
    if (!asLimited.ok) return;
    const limitedRow = asLimited.staff.find((row) => row.id === twoBranches.staffProfileId);
    expect(limitedRow?.branches.map((b) => b.id)).toEqual([mainA]);
    expect(limitedRow?.otherBranchCount).toBe(1);
    expect(limitedRow?.canEditBranches).toBe(true);
    // Someone with all-branch access is only edited by the owner.
    expect(asLimited.staff.find((row) => row.id === wideManager.staffProfileId)?.canEditBranches).toBe(false);
  });
});
