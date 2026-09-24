import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchTrainerAssignments,
  batches,
  branches,
  courses,
  programs,
  staffBranchAssignments,
  staffDocuments,
  staffProfiles,
  subscriptionPlans,
  timetables,
  users,
} from "@/lib/db/schema";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { ACADEMY_STAFF_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { checkAllowance } from "@/lib/subscriptions/usage";
import {
  assignStaffRole,
  createStaff,
  deleteStaff,
  getStaffDeletionEligibility,
  listStaff,
  removeStaffMembership,
  updateStaff,
  type CreateStaffInput,
} from "./staff";

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/settings.test.ts, plus the same
// FK-ordering rule (audit_logs before academies/users/subscriptions).
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `staff-action-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxStaff = 10): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Staff Action Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
      maxStudents: 100,
      maxStaff,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Staff Action Test Academy ${randomUUID()}`,
      slug: `staff-action-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(
  userId: string,
  academyId: string,
  role: AcademyRole,
): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

/** Full fixture: a fresh academy, one active plan/subscription (maxStaff
 * configurable for allowance tests), and one membership of the given role. */
async function setupAcademy(
  role: AcademyRole,
  maxStaff = 10,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxStaff);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

/** Inserts a staff_profiles row + academy_memberships row directly
 * (bypassing createStaff's own permission gate), for tests that need an
 * existing staff member as the *target* of updateStaff/assignStaffRole. */
async function createTargetStaff(
  academyId: string,
  role: AcademyRole = "trainer",
): Promise<{ staffProfileId: string; userId: string }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Target Staff", phone: "+1-555-0000" })
    .returning({ id: staffProfiles.id });
  return { staffProfileId: profile.id, userId };
}

/** Item 36 fixture helper: a bare branches row, bypassing createBranch. */
async function insertBranchDirect(academyId: string): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

/** Item 36 fixture helper: a fresh staff_profiles row for a given userId
 * plus staff_branch_assignments rows for it, bypassing assignStaffBranches
 * — same "tests build fixture data directly" convention as
 * branches.test.ts's own assignUserToBranches. Only for a userId that
 * doesn't already have a staff_profiles row in this academy — use
 * assignBranchesToProfile below for a profile created by createTargetStaff. */
async function assignUserToBranches(
  academyId: string,
  userId: string,
  branchIds: string[],
): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Branch-Scoped Staff", phone: "+1-555-0200" })
    .returning({ id: staffProfiles.id });

  await assignBranchesToProfile(academyId, profile.id, branchIds);
  return profile.id;
}

/** Item 36 fixture helper: staff_branch_assignments rows for an *existing*
 * staff_profiles row (e.g. one createTargetStaff already created). */
async function assignBranchesToProfile(
  academyId: string,
  staffProfileId: string,
  branchIds: string[],
): Promise<void> {
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId, branchId });
  }
}

/** A staffProfiles row with NO academy_memberships row at all — represents
 * an employment record whose access was fully removed (or never granted),
 * the only shape `deleteStaff` should ever consider eligible on the
 * membership front. */
async function createStaffWithoutMembership(
  academyId: string,
  fullName = "Unused Staff",
): Promise<{ staffProfileId: string; userId: string }> {
  const userId = await createUser();
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName, phone: "+1-555-0001" })
    .returning({ id: staffProfiles.id });
  return { staffProfileId: profile.id, userId };
}

async function insertProgramCourseBatch(
  academyId: string,
  branchId: string,
): Promise<{ courseId: string; batchId: string }> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  const [batch] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId: course.id,
      name: `Batch ${randomUUID()}`,
      code: `B-${randomUUID().slice(0, 8)}`,
      startDate: "2026-01-01",
    })
    .returning({ id: batches.id });
  return { courseId: course.id, batchId: batch.id };
}

async function assignInstructorToCourse(courseId: string, staffProfileId: string): Promise<void> {
  await db.update(courses).set({ instructorId: staffProfileId }).where(eq(courses.id, courseId));
}

async function assignTrainerToBatch(academyId: string, batchId: string, staffProfileId: string): Promise<void> {
  await db.insert(batchTrainerAssignments).values({ academyId, batchId, staffProfileId, status: "active" });
}

async function insertTimetableEntry(
  academyId: string,
  branchId: string,
  batchId: string,
  staffProfileId: string,
): Promise<void> {
  await db.insert(timetables).values({
    academyId,
    branchId,
    batchId,
    dayOfWeek: "mon",
    startTime: "09:00",
    endTime: "10:00",
    trainerStaffProfileId: staffProfileId,
  });
}

async function seedActiveStaff(academyId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const staffUserId = await createUser();
    await db.insert(staffProfiles).values({
      academyId,
      userId: staffUserId,
      fullName: `Seed Staff ${i}`,
      phone: "+1-555-0000",
      status: "active",
    });
  }
}

function validCreateInput(overrides: Partial<CreateStaffInput> = {}): CreateStaffInput {
  return {
    email: `new-staff-${randomUUID()}@example.com`,
    password: "supersecurepassword123",
    fullName: "New Staff Member",
    phone: "+1-555-0123",
    employeeNumber: "EMP-100",
    hireDate: "2024-01-01",
    role: "trainer",
    ...overrides,
  };
}

/** createStaff wrapper that also tracks the new user it creates for cleanup. */
async function createStaffTracked(context: AuthContext, input: CreateStaffInput) {
  const result = await createStaff(context, input);
  if (result.ok) createdUserIds.push(result.userId);
  return result;
}

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(
      or(
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
        ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id)),
      ),
    );
  for (const academyId of createdAcademyIds) {
    // Item 36 fixtures (assignUserToBranches/insertBranchDirect): FK order
    // requires staff_branch_assignments before staff_profiles/branches.
    await db.delete(timetables).where(eq(timetables.academyId, academyId));
    await db.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(staffDocuments).where(eq(staffDocuments.academyId, academyId));
    await db
      .delete(staffBranchAssignments)
      .where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("academy.staff permission levels (Master Permission Matrix 'Staff' row)", () => {
  it("matches Full/Full/Manage/none/none/View exactly", () => {
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_STAFF_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_STAFF_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("manager", ACADEMY_STAFF_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("admissions_officer", ACADEMY_STAFF_ACTION)).toBe("none");
    expect(getAcademyPermissionLevel("finance_officer", ACADEMY_STAFF_ACTION)).toBe("none");
    expect(getAcademyPermissionLevel("trainer", ACADEMY_STAFF_ACTION)).toBe("view");
  });

  it("covers every ACADEMY_ROLES member (no role silently unhandled)", () => {
    const expected: Record<AcademyRole, string> = {
      academy_owner: "full",
      academy_admin: "full",
      manager: "manage",
      admissions_officer: "none",
      finance_officer: "none",
      trainer: "view",
    };
    for (const role of ACADEMY_ROLES) {
      expect(getAcademyPermissionLevel(role, ACADEMY_STAFF_ACTION)).toBe(expected[role]);
    }
  });
});

describe("checkAllowance('staff') reflects real staff_profiles data (countActiveStaff is no longer the 0 stub)", () => {
  it("counts only active staff_profiles rows for the academy, excluding archived", async () => {
    const { academyId } = await setupAcademy("academy_owner", 5);
    await seedActiveStaff(academyId, 3);

    const archivedUserId = await createUser();
    await db.insert(staffProfiles).values({
      academyId,
      userId: archivedUserId,
      fullName: "Archived Staff",
      phone: "+1-555-0000",
      status: "archived",
    });

    const outcome = await checkAllowance(academyId, "staff");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.current).toBe(3);
      expect(outcome.result.limit).toBe(5);
      expect(outcome.result.allowed).toBe(true);
    }
  });

  it("never counts another academy's staff (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner", 5);
    await seedActiveStaff(other.academyId, 4);

    const { academyId } = await setupAcademy("academy_owner", 5);
    const outcome = await checkAllowance(academyId, "staff");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.current).toBe(0);
  });
});

describe("createStaff — hard block at the plan's staff allowance limit", () => {
  it("rejects creation once active staff_profiles reaches the plan limit, with no partial writes", async () => {
    const { academyId, context } = await setupAcademy("academy_owner", 2);
    await seedActiveStaff(academyId, 2);

    const input = validCreateInput();
    const result = await createStaff(context, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("allowance_exceeded");
    }

    // No user row was created for the rejected attempt (transaction rolled back).
    const [leaked] = await db.select().from(users).where(eq(users.email, input.email));
    expect(leaked).toBeUndefined();

    // Still exactly the 2 seeded rows — no orphaned partial insert.
    const all = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    expect(all.length).toBe(2);
  });

  it("allows creation again once a staff member is archived, freeing the slot", async () => {
    const { context } = await setupAcademy("academy_owner", 1);

    const first = await createStaffTracked(context, validCreateInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await createStaff(context, validCreateInput());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("allowance_exceeded");

    const archived = await updateStaff(context, first.staffProfileId, {
      fullName: "New Staff Member",
      phone: "+1-555-0123",
      status: "archived",
    });
    expect(archived.ok).toBe(true);

    const afterArchive = await createStaffTracked(context, validCreateInput());
    expect(afterArchive.ok).toBe(true);
  });
});

describe("createStaff — the create/reuse/audit transaction", () => {
  it("creates a users row, a staff_profiles row, and an academy_memberships row with the assigned role, all audited", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const input = validCreateInput({ role: "manager" });

    const result = await createStaffTracked(context, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user?.email).toBe(input.email);

    const [profile] = await db
      .select()
      .from(staffProfiles)
      .where(eq(staffProfiles.id, result.staffProfileId));
    expect(profile?.fullName).toBe(input.fullName);
    expect(profile?.academyId).toBe(academyId);
    expect(profile?.status).toBe("active");

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(
        and(eq(academyMemberships.userId, result.userId), eq(academyMemberships.academyId, academyId)),
      );
    expect(membership?.role).toBe("manager");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.staffProfileId));
    expect(audit?.action).toBe("createStaff");
    expect(audit?.actorUserId).toBe(actorUserId);
    expect(audit?.actorRole).toBe("academy_owner");
  });

  it("reuses an existing users row for an email that already has an account, rather than creating a duplicate", async () => {
    const { context } = await setupAcademy("academy_owner");
    const existingUserId = await createUser();
    const [existingUser] = await db.select().from(users).where(eq(users.id, existingUserId));

    const result = await createStaffTracked(
      context,
      validCreateInput({ email: existingUser.email, password: undefined }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(existingUserId);

    const matchingUsers = await db.select().from(users).where(eq(users.email, existingUser.email));
    expect(matchingUsers.length).toBe(1);
  });

  it("requires a password when creating a brand-new account", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createStaff(context, validCreateInput({ password: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses when the target is already staff at this academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const input = validCreateInput();

    const first = await createStaffTracked(context, input);
    expect(first.ok).toBe(true);

    const second = await createStaff(context, { ...input, password: undefined });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_staff");
  });

  it("allows re-hiring a previously-deleted staff member using the same email (removeStaffMembership + deleteStaff, then createStaff again)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const input = validCreateInput({ fullName: "Departed Then Rehired" });

    const created = await createStaffTracked(context, input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await removeStaffMembership(context, created.userId);
    expect(removed.ok).toBe(true);

    const deleted = await deleteStaff(context, created.staffProfileId, "Departed Then Rehired");
    expect(deleted.ok).toBe(true);

    // Re-creating with the exact same email must succeed — the stale
    // "removed" academy_memberships row from before must be reactivated in
    // place, not treated as a live conflict (this was the actual bug: a
    // naive "any existing membership row = already staff" check blocked
    // re-hiring forever after a single deletion).
    const rehired = await createStaff(context, { ...input, password: undefined, role: "manager" });
    expect(rehired.ok).toBe(true);
    if (rehired.ok) {
      createdUserIds.push(rehired.userId);
      expect(rehired.userId).toBe(created.userId);
    }

    // Reactivated in place — still exactly one membership row for this
    // (user, academy) pair, now active with the new role, never a second
    // inserted row.
    const memberships = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, created.userId), eq(academyMemberships.academyId, academyId)));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe("active");
    expect(memberships[0].role).toBe("manager");
  });

  it("deleteStaff's audit row preserves the deleted staff member's login email, since it disappears from every other view once the profile is gone", async () => {
    const { context } = await setupAcademy("academy_owner");
    const email = `deleted-staff-${randomUUID()}@example.com`;
    const created = await createStaffTracked(context, validCreateInput({ email, fullName: "Traceable Deletion" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await removeStaffMembership(context, created.userId);
    expect(removed.ok).toBe(true);
    const deleted = await deleteStaff(context, created.staffProfileId, "Traceable Deletion");
    expect(deleted.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.staffProfileId), eq(auditLogs.action, "deleteStaff")));
    expect(audit?.action).toBe("deleteStaff");
    const before = audit?.before as { loginEmail?: string | null } | null;
    expect(before?.loginEmail).toBe(email);
  });

  it("blocks with code 'blocked' when the academy's subscription is suspended", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const planId = await createPlan();
    await db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "suspended",
      createdBy: creatorUserId,
    });
    const ownerUserId = await createUser();
    await addMembership(ownerUserId, academyId, "academy_owner");

    const result = await createStaff(
      { userId: ownerUserId, branchIds: [], academyWide: false },
      validCreateInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});

describe("createStaff — permission matrix (Full/Manage may create, everyone else refused)", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to create a staff member",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await createStaffTracked(context, validCreateInput());
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await createStaff(context, validCreateInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  // Owner-safety pass (delete/deletion-audit task): canManageStaff alone
  // used to gate this action, and Manager holds "manage" — the same level
  // Admin's "full" satisfies — so a Manager could mint a brand-new
  // academy_owner account from scratch with no extra check at all.
  it.each<AcademyRole>(["academy_admin", "manager"])(
    "refuses %s creating a new staff member with role academy_owner",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await createStaffTracked(context, validCreateInput({ role: "academy_owner" }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("allows an existing owner to create a new staff member with role academy_owner", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createStaffTracked(context, validCreateInput({ role: "academy_owner" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe("academy_owner");
  });
});

describe("updateStaff", () => {
  it("updates the employment record fields and audits before/after", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);

    const result = await updateStaff(context, target.staffProfileId, {
      fullName: "Updated Name",
      phone: "+1-555-9999",
      employeeNumber: "EMP-999",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staff.fullName).toBe("Updated Name");
      expect(result.staff.employeeNumber).toBe("EMP-999");
    }

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, target.staffProfileId));
    expect(audit?.action).toBe("updateStaff");
  });

  it("returns not_found for a staffProfileId belonging to another academy (tenant isolation / IDOR guard)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await updateStaff(context, otherTarget.staffProfileId, {
      fullName: "Hijacked",
      phone: "+1-555-0000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to update staff",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const result = await updateStaff(context, target.staffProfileId, {
        fullName: "Manager Updated",
        phone: "+1-555-0001",
      });
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const result = await updateStaff(context, target.staffProfileId, {
        fullName: "Should Not Apply",
        phone: "+1-555-0002",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );
});

describe("assignStaffRole", () => {
  it("updates the target's academy_memberships.role and audits before/after", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    const result = await assignStaffRole(context, target.userId, "manager");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe("manager");

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(
        and(
          eq(academyMemberships.userId, target.userId),
          eq(academyMemberships.academyId, academyId),
        ),
      );
    expect(membership.role).toBe("manager");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, membership.id));
    expect(audit?.action).toBe("assignStaffRole");
    expect(audit?.actorUserId).toBe(actorUserId);
  });

  it("returns not_found when the target has no membership in this academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const strangerUserId = await createUser();

    const result = await assignStaffRole(context, strangerUserId, "manager");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("tenant isolation: Academy A owner cannot change Academy B staff's role by supplying their userId", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId, "trainer");

    const { context } = await setupAcademy("academy_owner");
    const result = await assignStaffRole(context, otherTarget.userId, "academy_admin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    // Academy B's membership must be completely untouched by the refused attempt.
    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, otherTarget.userId), eq(academyMemberships.academyId, other.academyId)));
    expect(membership.role).toBe("trainer");
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to assign a role",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "trainer");
      const result = await assignStaffRole(context, target.userId, "finance_officer");
      expect(result.ok).toBe(true);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "trainer");
      const result = await assignStaffRole(context, target.userId, "manager");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  // Owner-safety pass (delete/deletion-audit task): Manager holds "manage"
  // on academy.staff, the same level this action already accepted for every
  // other role — without this guard a Manager could self-promote (or
  // promote anyone) to academy_owner, or strip the real owner of it.
  it.each<AcademyRole>(["academy_admin", "manager"])(
    "refuses %s granting academy_owner to someone else",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "trainer");
      const result = await assignStaffRole(context, target.userId, "academy_owner");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("allows an existing owner to grant academy_owner to someone else", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");
    const result = await assignStaffRole(context, target.userId, "academy_owner");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe("academy_owner");
  });

  it("refuses a non-owner (Admin) demoting the real owner away from academy_owner", async () => {
    const { academyId, userId: ownerUserId } = await setupAcademy("academy_owner");
    const adminUserId = await createUser();
    await addMembership(adminUserId, academyId, "academy_admin");
    const adminContext: AuthContext = { userId: adminUserId, branchIds: [], academyWide: false };

    const result = await assignStaffRole(adminContext, ownerUserId, "manager");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, ownerUserId), eq(academyMemberships.academyId, academyId)));
    expect(membership.role).toBe("academy_owner");
  });

  it("refuses demoting the last remaining owner, even by another owner", async () => {
    const { academyId, userId: ownerUserId } = await setupAcademy("academy_owner");
    const owner2UserId = await createUser();
    await addMembership(owner2UserId, academyId, "academy_owner");
    const owner2Context: AuthContext = { userId: owner2UserId, branchIds: [], academyWide: false };

    // Two owners exist — demoting the first one is fine.
    const firstDemotion = await assignStaffRole(owner2Context, ownerUserId, "manager");
    expect(firstDemotion.ok).toBe(true);

    // Now owner2 is the only remaining owner — demoting them must be refused.
    const lastDemotion = await assignStaffRole(owner2Context, owner2UserId, "manager");
    expect(lastDemotion.ok).toBe(false);
    if (!lastDemotion.ok) expect(lastDemotion.error.code).toBe("conflict");
  });
});

describe("removeStaffMembership (owner-safety pass, delete/deletion-audit task)", () => {
  it("sets the target's academy_memberships.status to 'removed' and audits before/after", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    const result = await removeStaffMembership(context, target.userId);
    expect(result.ok).toBe(true);

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, target.userId), eq(academyMemberships.academyId, academyId)));
    expect(membership.status).toBe("removed");
    // The role column itself is left untouched — only access is revoked.
    expect(membership.role).toBe("trainer");

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, membership.id));
    expect(audit?.action).toBe("removeStaffMembership");
    expect(audit?.actorUserId).toBe(actorUserId);
  });

  it("a removed member fails checkAcademyAccess — access is actually revoked, not just cosmetic", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    await removeStaffMembership(context, target.userId);

    const { checkAcademyAccess } = await import("./access-gate");
    const access = await checkAcademyAccess(target.userId, academyId);
    expect(access.level).toBe("blocked");
  });

  it("returns not_found for a user with no active membership in this academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const strangerUserId = await createUser();

    const result = await removeStaffMembership(context, strangerUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("tenant isolation: Academy A owner cannot remove Academy B staff's access by supplying their userId", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId, "trainer");

    const { context } = await setupAcademy("academy_owner");
    const result = await removeStaffMembership(context, otherTarget.userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    // Academy B's membership must remain active — completely untouched.
    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, otherTarget.userId), eq(academyMemberships.academyId, other.academyId)));
    expect(membership.status).toBe("active");
  });

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId, "manager");
      const result = await removeStaffMembership(context, target.userId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("refuses a non-owner (Manager) removing the real owner's access", async () => {
    const { academyId, userId: ownerUserId } = await setupAcademy("academy_owner");
    const managerUserId = await createUser();
    await addMembership(managerUserId, academyId, "manager");
    const managerContext: AuthContext = { userId: managerUserId, branchIds: [], academyWide: false };

    const result = await removeStaffMembership(managerContext, ownerUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("refuses removing the last remaining owner, even by another owner", async () => {
    const { academyId, userId: ownerUserId } = await setupAcademy("academy_owner");
    const owner2UserId = await createUser();
    await addMembership(owner2UserId, academyId, "academy_owner");
    const owner2Context: AuthContext = { userId: owner2UserId, branchIds: [], academyWide: false };

    // Two owners exist — removing the first one is fine.
    const firstRemoval = await removeStaffMembership(owner2Context, ownerUserId);
    expect(firstRemoval.ok).toBe(true);

    // Now owner2 is the only remaining owner — must be refused.
    const lastRemoval = await removeStaffMembership(owner2Context, owner2UserId);
    expect(lastRemoval.ok).toBe(false);
    if (!lastRemoval.ok) expect(lastRemoval.error.code).toBe("conflict");
  });

  it("listStaff shows null role for a removed member instead of their stale role", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    await removeStaffMembership(context, target.userId);

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.staff.find((s) => s.userId === target.userId);
      expect(row?.role).toBeNull();
    }
  });
});

describe("listStaff — permission matrix (Full/Manage/View may list, Admissions/Finance refused)", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to view the staff list, unfiltered by branch",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      await createTargetStaff(academyId);
      const result = await listStaff(context);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.staff.length).toBeGreaterThanOrEqual(1);
    },
  );

  // Trainer's "view" level is branch-scoped (Item 36 — see
  // getViewableStaffProfileIds in lib/academies/staff.ts): unlike the
  // academy-wide roles above, a bare setupAcademy("trainer") fixture with
  // no staff_profiles/branch-assignment rows of its own is correctly
  // refused *content* (an empty list, not a "forbidden"), so this is
  // tested as its own case with a real shared-branch fixture rather than
  // folded into the it.each above. The "trainer sees zero staff when
  // nothing is shared" and "trainer never sees an unshared staff member"
  // cases are covered in lib/academies/staff-branch-assignments.test.ts,
  // alongside the rest of Item 36's branch-scoping/IDOR coverage.
  it("allows trainer to view the staff list, scoped to their own record plus shared-branch staff", async () => {
    const { academyId, userId: trainerUserId, context } = await setupAcademy("trainer");
    const branchId = await insertBranchDirect(academyId);
    const trainerProfileId = await assignUserToBranches(academyId, trainerUserId, [branchId]);
    const sharedTarget = await createTargetStaff(academyId);
    await assignBranchesToProfile(academyId, sharedTarget.staffProfileId, [branchId]);

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.permissionLevel).toBe("view");
    const ids = result.staff.map((s) => s.id);
    expect(ids).toContain(trainerProfileId);
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it.each<AcademyRole>(["admissions_officer", "finance_officer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { context } = await setupAcademy(role);
      const result = await listStaff(context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("never returns another academy's staff (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    await createTargetStaff(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staff.length).toBe(0);
  });

  it("includes the joined academy_memberships role and users.email (loginEmail)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "finance_officer");

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.staff.find((s) => s.id === target.staffProfileId);
      expect(row?.role).toBe("finance_officer");
      expect(row?.loginEmail).toBeTruthy();
    }
  });
});

describe("getStaffDeletionEligibility / deleteStaff", () => {
  it("a staff profile with no active membership and no references is eligible and deletes", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Unused Staff");

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteStaff(context, target.staffProfileId, "Unused Staff");
    expect(deleted.ok).toBe(true);

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staff.find((s) => s.id === target.staffProfileId)).toBeUndefined();
  });

  it("an academy_owner with active membership cannot be deleted through normal staff deletion", async () => {
    const owner = await setupAcademy("academy_owner");
    // A second owner, so this isn't also blocked by "last remaining owner"
    // — this test is specifically about the active-membership guard.
    const secondOwnerUserId = await createUser();
    await addMembership(secondOwnerUserId, owner.academyId, "academy_owner");
    const [profile] = await db
      .insert(staffProfiles)
      .values({ academyId: owner.academyId, userId: secondOwnerUserId, fullName: "Second Owner", phone: "+1-555-0002" })
      .returning({ id: staffProfiles.id });

    const eligibility = await getStaffDeletionEligibility(owner.context, profile.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.hasActiveMembership).toBe(true);
    }

    const result = await deleteStaff(owner.context, profile.id, "Second Owner");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("the last remaining owner cannot be deleted (still has an active membership)", async () => {
    const owner = await setupAcademy("academy_owner");
    const [profile] = await db
      .insert(staffProfiles)
      .values({ academyId: owner.academyId, userId: owner.userId, fullName: "Only Owner", phone: "+1-555-0003" })
      .returning({ id: staffProfiles.id });

    const result = await deleteStaff(owner.context, profile.id, "Only Owner");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");

    // The membership itself is completely untouched.
    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, owner.userId), eq(academyMemberships.academyId, owner.academyId)));
    expect(membership.status).toBe("active");
    expect(membership.role).toBe("academy_owner");
  });

  it("removing access first (removeStaffMembership), then deleting, succeeds — the correct two-step workflow", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId, "trainer");

    const removed = await removeStaffMembership(context, target.userId);
    expect(removed.ok).toBe(true);

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    const deleted = await deleteStaff(context, target.staffProfileId, "Target Staff");
    expect(deleted.ok).toBe(true);
  });

  it("a staff member assigned as a course instructor is blocked from deletion", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Instructor Staff");
    const branchId = await insertBranchDirect(academyId);
    const { courseId } = await insertProgramCourseBatch(academyId, branchId);
    await assignInstructorToCourse(courseId, target.staffProfileId);

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.instructorCourseCount).toBe(1);
    }

    const deleted = await deleteStaff(context, target.staffProfileId, "Instructor Staff");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a staff member assigned as a batch trainer is blocked from deletion", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Trainer Staff");
    const branchId = await insertBranchDirect(academyId);
    const { batchId } = await insertProgramCourseBatch(academyId, branchId);
    await assignTrainerToBatch(academyId, batchId, target.staffProfileId);

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.trainerAssignmentCount).toBe(1);
    }

    const deleted = await deleteStaff(context, target.staffProfileId, "Trainer Staff");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a staff member referenced in a timetable entry is blocked from deletion", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Timetable Staff");
    const branchId = await insertBranchDirect(academyId);
    const { batchId } = await insertProgramCourseBatch(academyId, branchId);
    await insertTimetableEntry(academyId, branchId, batchId, target.staffProfileId);

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.timetableCount).toBe(1);
    }

    const deleted = await deleteStaff(context, target.staffProfileId, "Timetable Staff");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("rejects a wrong confirmation name, and nothing is deleted", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Type Me Exactly");

    const result = await deleteStaff(context, target.staffProfileId, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const listed = await listStaff(context);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.staff.find((s) => s.id === target.staffProfileId)).toBeDefined();
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: delete allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(owner.academyId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await deleteStaff(actingContext, target.staffProfileId, "Unused Staff");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never deletes another academy's staff profile (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createStaffWithoutMembership(other.academyId, "Other Academy Staff");

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getStaffDeletionEligibility(context, otherTarget.staffProfileId);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteStaff(context, otherTarget.staffProfileId, "Other Academy Staff");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const listed = await listStaff(other.context);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.staff.find((s) => s.id === otherTarget.staffProfileId)).toBeDefined();
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Audited Deletion");

    const result = await deleteStaff(context, target.staffProfileId, "Audited Deletion");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, target.staffProfileId), eq(auditLogs.action, "deleteStaff")));
    expect(audit?.action).toBe("deleteStaff");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: a course-instructor assignment made after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createStaffWithoutMembership(academyId, "Race Condition Staff");

    const eligibility = await getStaffDeletionEligibility(context, target.staffProfileId);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent instructor assignment landing between the
    // UI's eligibility preview and the actual delete call.
    const branchId = await insertBranchDirect(academyId);
    const { courseId } = await insertProgramCourseBatch(academyId, branchId);
    await assignInstructorToCourse(courseId, target.staffProfileId);

    const result = await deleteStaff(context, target.staffProfileId, "Race Condition Staff");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });
});
