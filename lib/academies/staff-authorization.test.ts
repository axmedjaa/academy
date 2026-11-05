import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  courses,
  programs,
  staffBranchAssignments,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { setStaffWorkplace } from "@/lib/academies/staff-branch-assignments";
import { canChangeStaffRoles, canModifyStaffWithRole, rolesAssignableBy } from "@/lib/academies/staff-role-rules";
import {
  assignStaffRole,
  createStaff,
  deleteStaff,
  getStaffWorkplaceOptions,
  listStaff,
  removeStaffMembership,
  updateStaff,
  type CreateStaffInput,
} from "./staff";

/**
 * Staff authorization regression tests (Manager privilege escalation,
 * Owner protection, archived staff losing access, and staff records with
 * no access and no branch). Every scenario calls the service functions the
 * server actions call, so these are the "direct request" paths: no UI is
 * involved, and none of the checks rely on a hidden control.
 */

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db.insert(users).values({ email: `staff-authz-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

const ctx = (userId: string): AuthContext => ({ userId, branchIds: [], academyWide: false });

interface Academy {
  academyId: string;
  mainBranchId: string;
  otherBranchId: string;
  owner: { userId: string; profileId: string };
  admin: { userId: string; profileId: string };
  manager: { userId: string; profileId: string };
  trainer: { userId: string; profileId: string };
}

async function addStaff(academyId: string, role: AcademyRole, academyWide: boolean, branchIds: string[]) {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide });
  const [profile] = await db.insert(staffProfiles).values({ academyId, userId, fullName: `Staff ${role}`, phone: "+1-555-0100" }).returning({ id: staffProfiles.id });
  if (branchIds.length) await db.insert(staffBranchAssignments).values(branchIds.map((branchId) => ({ academyId, staffProfileId: profile.id, branchId })));
  return { userId, profileId: profile.id };
}

async function setupAcademy(): Promise<Academy> {
  const creator = await createUser();
  const [academy] = await db.insert(academies).values({ name: `Staff Authz ${randomUUID()}`, slug: `staff-authz-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator }).returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/staff-authorization.test.ts)",
      name: `Staff Authz Plan ${randomUUID()}`,
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
  createdPlanIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", createdBy: creator });
  const [main] = await db.insert(branches).values({ academyId: academy.id, name: "Main", code: `M-${randomUUID().slice(0, 6)}`, isMain: true }).returning({ id: branches.id });
  const [other] = await db.insert(branches).values({ academyId: academy.id, name: "Other", code: `O-${randomUUID().slice(0, 6)}` }).returning({ id: branches.id });
  return {
    academyId: academy.id,
    mainBranchId: main.id,
    otherBranchId: other.id,
    owner: await addStaff(academy.id, "academy_owner", false, []),
    admin: await addStaff(academy.id, "academy_admin", true, [main.id]),
    manager: await addStaff(academy.id, "manager", true, [main.id]),
    trainer: await addStaff(academy.id, "trainer", false, [main.id]),
  };
}

const roleOf = async (academyId: string, userId: string) =>
  (await db.select({ role: academyMemberships.role, status: academyMemberships.status }).from(academyMemberships).where(and(eq(academyMemberships.academyId, academyId), eq(academyMemberships.userId, userId))))[0];

const statusOf = async (profileId: string) => (await db.select({ status: staffProfiles.status }).from(staffProfiles).where(eq(staffProfiles.id, profileId)))[0]?.status;

function newStaff(overrides: Partial<CreateStaffInput> = {}): CreateStaffInput {
  return {
    email: `staff-authz-new-${randomUUID()}@example.com`,
    password: "supersecurepassword123",
    fullName: "New Person",
    phone: "+1-555-0123",
    role: "trainer",
    ...overrides,
  };
}

async function createTracked(context: AuthContext, input: CreateStaffInput) {
  const result = await createStaff(context, input);
  if (result.ok) createdUserIds.push(result.userId);
  return result;
}

/** The staff record state under investigation: an active staff profile
 * whose academy membership was removed (shows "No access"), with no branch
 * assignment rows (shows "No branch"), still instructor of a course. */
async function addNoAccessNoBranchStaff(a: Academy) {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId: a.academyId, role: "academy_admin", status: "removed", academyWide: true });
  const [profile] = await db.insert(staffProfiles).values({ academyId: a.academyId, userId, fullName: "No Access Person", phone: "+1-555-0199", employeeNumber: "002", hireDate: "2026-10-12" }).returning({ id: staffProfiles.id });
  const [program] = await db.insert(programs).values({ academyId: a.academyId, name: `P ${randomUUID().slice(0, 6)}` }).returning({ id: programs.id });
  await db.insert(courses).values({ academyId: a.academyId, programId: program.id, name: `C ${randomUUID().slice(0, 6)}`, code: `C-${randomUUID().slice(0, 6)}`, instructorId: profile.id });
  return { userId, profileId: profile.id };
}

const archiveInput = (fullName: string) => ({ fullName, phone: "+1-555-0199", status: "archived" as const });

let a: Academy;
beforeAll(async () => {
  a = await setupAcademy();
});

afterAll(async () => {
  await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, createdAcademyIds), inArray(auditLogs.actorUserId, createdUserIds)));
  for (const academyId of createdAcademyIds) {
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  if (createdPlanIds.length) await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
}, 180_000);

describe("role rules (pure)", () => {
  it("lets only Owner and Admin change roles, and Admin never to Owner", () => {
    expect(canChangeStaffRoles("academy_owner")).toBe(true);
    expect(canChangeStaffRoles("academy_admin")).toBe(true);
    for (const r of ["manager", "finance_officer", "admissions_officer", "trainer"] as const) expect(canChangeStaffRoles(r)).toBe(false);
    expect(rolesAssignableBy("academy_admin", "change")).not.toContain("academy_owner");
    expect(rolesAssignableBy("manager", "change")).toEqual([]);
  });

  it("lets a Manager create only roles below Manager (Trainer)", () => {
    expect([...rolesAssignableBy("manager", "create")]).toEqual(["trainer"]);
    expect(rolesAssignableBy("trainer", "create")).toEqual([]);
  });

  it("never offers a retired role, to anyone", () => {
    for (const actor of ["academy_owner", "academy_admin", "manager", "trainer"] as const) {
      for (const purpose of ["change", "create"] as const) {
        expect(rolesAssignableBy(actor, purpose)).not.toContain("admissions_officer");
        expect(rolesAssignableBy(actor, purpose)).not.toContain("finance_officer");
      }
    }
  });

  it("protects Owner records from everyone but an Owner", () => {
    expect(canModifyStaffWithRole("academy_admin", "academy_owner")).toBe(false);
    expect(canModifyStaffWithRole("manager", "academy_owner")).toBe(false);
    expect(canModifyStaffWithRole("academy_owner", "academy_owner")).toBe(true);
    expect(canModifyStaffWithRole("manager", null)).toBe(true);
  });
});

describe("Manager cannot change roles (direct service calls)", () => {
  it("refuses a Manager changing their own role, and the role stays Manager", async () => {
    for (const target of ["academy_admin", "academy_owner", "trainer"] as const) {
      const result = await assignStaffRole(ctx(a.manager.userId), a.manager.userId, target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
    expect((await roleOf(a.academyId, a.manager.userId)).role).toBe("manager");
  });

  it("refuses a Manager changing another staff member's role", async () => {
    const result = await assignStaffRole(ctx(a.manager.userId), a.trainer.userId, "academy_admin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect((await roleOf(a.academyId, a.trainer.userId)).role).toBe("trainer");
  });

  it("refuses Finance, Admissions and Trainer changing roles", async () => {
    for (const role of ["finance_officer", "admissions_officer", "trainer"] as const) {
      const actor = await addStaff(a.academyId, role, false, [a.mainBranchId]);
      const result = await assignStaffRole(ctx(actor.userId), a.trainer.userId, "manager");
      expect(result.ok).toBe(false);
    }
    expect((await roleOf(a.academyId, a.trainer.userId)).role).toBe("trainer");
  });
});

describe("Manager cannot escalate through staff creation", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])("refuses a Manager creating a %s account", async (role) => {
    const result = await createTracked(ctx(a.manager.userId), newStaff({ role }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("refuses a Manager attaching an existing account they control as Admin", async () => {
    const existing = await createUser();
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, existing));
    const result = await createTracked(ctx(a.manager.userId), newStaff({ email: u.email, password: undefined, role: "academy_admin" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    const memberships = await db.select().from(academyMemberships).where(and(eq(academyMemberships.academyId, a.academyId), eq(academyMemberships.userId, existing)));
    expect(memberships).toHaveLength(0);
  });

  it("still lets a Manager create a Trainer and place them in a branch", async () => {
    const result = await createTracked(ctx(a.manager.userId), newStaff({ role: "trainer", workplace: "specific", branchIds: [a.otherBranchId] }));
    expect(result.ok).toBe(true);
  });

  it("offers a Manager only the roles they may create", async () => {
    const result = await getStaffWorkplaceOptions(ctx(a.manager.userId));
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.options.creatableRoles]).toEqual(["trainer"]);
  });

  it("still lets a Manager change a staff member's branches", async () => {
    const person = await addStaff(a.academyId, "trainer", false, [a.mainBranchId]);
    const result = await setStaffWorkplace(ctx(a.manager.userId), person.profileId, { workplace: "specific", branchIds: [a.mainBranchId, a.otherBranchId] });
    expect(result.ok).toBe(true);
  });
});

describe("Owner and Admin role changes", () => {
  it("lets an Admin change a non-Owner role", async () => {
    const person = await addStaff(a.academyId, "trainer", false, [a.mainBranchId]);
    const result = await assignStaffRole(ctx(a.admin.userId), person.userId, "manager");
    expect(result.ok).toBe(true);
    expect((await roleOf(a.academyId, person.userId)).role).toBe("manager");
  });

  it("refuses an Admin granting or removing the Owner role", async () => {
    const person = await addStaff(a.academyId, "trainer", false, [a.mainBranchId]);
    const grant = await assignStaffRole(ctx(a.admin.userId), person.userId, "academy_owner");
    expect(grant.ok).toBe(false);
    const demote = await assignStaffRole(ctx(a.admin.userId), a.owner.userId, "manager");
    expect(demote.ok).toBe(false);
    expect((await roleOf(a.academyId, a.owner.userId)).role).toBe("academy_owner");
  });

  it("refuses an Admin creating an Owner account", async () => {
    const result = await createTracked(ctx(a.admin.userId), newStaff({ role: "academy_owner" }));
    expect(result.ok).toBe(false);
  });

  it("refuses Owner and Admin changing their own role", async () => {
    expect((await assignStaffRole(ctx(a.admin.userId), a.admin.userId, "academy_owner")).ok).toBe(false);
    expect((await assignStaffRole(ctx(a.owner.userId), a.owner.userId, "manager")).ok).toBe(false);
    expect((await roleOf(a.academyId, a.admin.userId)).role).toBe("academy_admin");
    expect((await roleOf(a.academyId, a.owner.userId)).role).toBe("academy_owner");
  });

  it("lets an Owner change roles, including granting Owner", async () => {
    const person = await addStaff(a.academyId, "trainer", false, [a.mainBranchId]);
    expect((await assignStaffRole(ctx(a.owner.userId), person.userId, "academy_admin")).ok).toBe(true);
    expect((await assignStaffRole(ctx(a.owner.userId), person.userId, "academy_owner")).ok).toBe(true);
    expect((await roleOf(a.academyId, person.userId)).role).toBe("academy_owner");
  });

  it("keeps tenant isolation: another academy's Owner can't change this academy's staff", async () => {
    const other = await setupAcademy();
    const result = await assignStaffRole(ctx(other.owner.userId), a.trainer.userId, "manager");
    expect(result.ok).toBe(false);
    expect((await roleOf(a.academyId, a.trainer.userId)).role).toBe("trainer");
  });
});

describe("Owner records and self-archive", () => {
  it("refuses a Manager or Admin archiving or editing the Owner's record", async () => {
    for (const actor of [a.manager, a.admin]) {
      const result = await updateStaff(ctx(actor.userId), a.owner.profileId, archiveInput("Staff academy_owner"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
    expect(await statusOf(a.owner.profileId)).toBe("active");
  });

  it("refuses anyone archiving their own record", async () => {
    const result = await updateStaff(ctx(a.manager.userId), a.manager.profileId, archiveInput("Staff manager"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(await statusOf(a.manager.profileId)).toBe("active");
  });
});

describe("archived staff lose academy access", () => {
  it("blocks an archived staff member and lets them back in when restored", async () => {
    const person = await addStaff(a.academyId, "manager", true, [a.mainBranchId]);
    expect((await checkAcademyAccessForContext(ctx(person.userId))).level).not.toBe("blocked");

    expect((await updateStaff(ctx(a.owner.userId), person.profileId, { fullName: "Staff manager", phone: "+1-555-0100", status: "archived" })).ok).toBe(true);
    const blocked = await checkAcademyAccessForContext(ctx(person.userId));
    expect(blocked.level).toBe("blocked");

    // A direct service call as the archived person is refused too.
    const attempt = await createStaff(ctx(person.userId), newStaff());
    expect(attempt.ok).toBe(false);

    expect((await updateStaff(ctx(a.owner.userId), person.profileId, { fullName: "Staff manager", phone: "+1-555-0100", status: "active" })).ok).toBe(true);
    expect((await checkAcademyAccessForContext(ctx(person.userId))).level).not.toBe("blocked");
  });

  it("does not affect an owner who has no staff record", async () => {
    const userId = await createUser();
    await db.insert(academyMemberships).values({ userId, academyId: a.academyId, role: "academy_owner", status: "active" });
    expect((await checkAcademyAccessForContext(ctx(userId), a.academyId)).level).not.toBe("blocked");
  });
});

describe("staff with no access and no branch", () => {
  it("is listed as No access / No branch, with archive allowed and role change not offered", async () => {
    const person = await addNoAccessNoBranchStaff(a);
    const list = await listStaff(ctx(a.owner.userId));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.staff.find((s) => s.id === person.profileId)!;
    expect(row.role).toBeNull();
    expect(row.allBranchAccess).toBe(false);
    expect(row.branches).toHaveLength(0);
    expect(row.canEditRecord).toBe(true);
    expect(row.canChangeRole).toBe(false);
    // Delete is blocked only by the course this person still teaches.
    expect(row.deletionEligibility.eligible).toBe(false);
    expect(row.deletionEligibility.reasons.join(" ")).toMatch(/instructor/);
  });

  it.each(["owner", "admin", "manager"] as const)("can be archived and restored by the %s without assigning a role or branch", async (who) => {
    const person = await addNoAccessNoBranchStaff(a);
    const actor = a[who];
    const archived = await updateStaff(ctx(actor.userId), person.profileId, archiveInput("No Access Person"));
    expect(archived.ok).toBe(true);
    expect(await statusOf(person.profileId)).toBe("archived");
    const restored = await updateStaff(ctx(actor.userId), person.profileId, { fullName: "No Access Person", phone: "+1-555-0199", status: "active" });
    expect(restored.ok).toBe(true);
    // Nothing about access, role or branches changed.
    expect(await roleOf(a.academyId, person.userId)).toEqual({ role: "academy_admin", status: "removed" });
    expect(await db.select().from(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, person.profileId))).toHaveLength(0);
  });

  it("cannot be archived by Finance, Admissions or a Trainer", async () => {
    const person = await addNoAccessNoBranchStaff(a);
    for (const role of ["finance_officer", "admissions_officer", "trainer"] as const) {
      const actor = await addStaff(a.academyId, role, false, [a.mainBranchId]);
      expect((await updateStaff(ctx(actor.userId), person.profileId, archiveInput("No Access Person"))).ok).toBe(false);
    }
    expect(await statusOf(person.profileId)).toBe("active");
  });

  it("has no access to remove, and is not deleted while it teaches a course", async () => {
    const person = await addNoAccessNoBranchStaff(a);
    const removed = await removeStaffMembership(ctx(a.owner.userId), person.userId);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe("not_found");
    const deleted = await deleteStaff(ctx(a.owner.userId), person.profileId, "No Access Person");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
    expect(await statusOf(person.profileId)).toBe("active");
  });

  it("cannot sign in to the academy console (no active membership)", async () => {
    const person = await addNoAccessNoBranchStaff(a);
    const access = await checkAcademyAccessForContext(ctx(person.userId));
    expect(access.level).toBe("blocked");
  });
});
