import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  courses,
  programs,
  staffBranchAssignments,
  staffProfiles,
  students,
  subscriptionPlans,
  timetables,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  archiveBranch,
  createBranch,
  deleteBranch,
  getBranch,
  getBranchDeletionEligibility,
  listBranches,
  updateBranch,
  type CreateBranchInput,
} from "./branches";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/settings.test.ts / access-gate.test.ts.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `branches-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxBranches = 3): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Branches Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches,
      maxStudents: 100,
      maxStaff: 10,
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
      name: `Branches Test Academy ${randomUUID()}`,
      slug: `branches-test-${randomUUID()}`,
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

/** Full fixture: a fresh academy, one active plan/subscription (default 3
 * branches allowed), and one membership of the given role. */
async function setupAcademy(
  role: AcademyRole,
  maxBranches = 3,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan(maxBranches);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
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

/** Directly inserts a branches row, bypassing checkAllowance/createBranch —
 * used to set up fixture branches for IDOR/scope tests without exercising
 * the create action itself. */
async function insertBranchDirect(
  academyId: string,
  code = `BR-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

/** Directly inserts staff_profiles + staff_branch_assignments rows,
 * bypassing not-yet-built Items 35/36 (staff create, branch assignment) —
 * per the task brief, tests build this fixture data directly. */
async function assignUserToBranches(
  academyId: string,
  userId: string,
  branchIds: string[],
): Promise<void> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({
      academyId,
      userId,
      fullName: "Test Staff Member",
      phone: "+1-555-0100",
    })
    .returning({ id: staffProfiles.id });

  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({
      academyId,
      staffProfileId: profile.id,
      branchId,
    });
  }
}

async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8)}`,
      fullName: "Test Student",
      createdBy: creatorUserId,
    })
    .returning({ id: students.id });
  return row.id;
}

async function insertProgramAndCourse(academyId: string): Promise<string> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  return course.id;
}

async function insertBatchDirect(academyId: string, branchId: string, courseId: string): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId,
      name: `Batch ${randomUUID()}`,
      code: `B-${randomUUID().slice(0, 8)}`,
      startDate: "2026-01-01",
    })
    .returning({ id: batches.id });
  return row.id;
}

function validInput(overrides: Partial<CreateBranchInput> = {}): CreateBranchInput {
  return {
    name: `Test Branch ${randomUUID()}`,
    code: `BR${randomUUID().slice(0, 8).toUpperCase()}`,
    address: "1 Test St",
    phone: "+1-555-0199",
    ...overrides,
  };
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
    await db.delete(timetables).where(eq(timetables.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    const profiles = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    for (const profile of profiles) {
      await db
        .delete(staffBranchAssignments)
        .where(eq(staffBranchAssignments.staffProfileId, profile.id));
    }
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
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

describe("createBranch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context } = await setupAcademy(role);
    const result = await createBranch(context, validInput());
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("writes an audit row on successful creation", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const result = await createBranch(context, validInput({ name: "Audited Branch" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.branch.id));
    expect(audit?.action).toBe("createBranch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects an empty name with code 'validation'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createBranch(context, validInput({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a duplicate branch code within the same academy with code 'conflict'", async () => {
    const { context } = await setupAcademy("academy_owner");
    const input = validInput({ code: "DUPCODE" });
    const first = await createBranch(context, input);
    expect(first.ok).toBe(true);

    const second = await createBranch(context, validInput({ code: "DUPCODE" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});

describe("checkAllowance('branches') — hard block at plan limit", () => {
  it("allows creation up to the plan limit and hard-blocks the next one", async () => {
    const { context } = await setupAcademy("academy_owner", 1);

    const first = await createBranch(context, validInput());
    expect(first.ok).toBe(true);

    const second = await createBranch(context, validInput());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("allowance");
      expect(second.error.message).toMatch(/limit/i);
    }
  });

  it("archiving a branch frees the allowance slot for a new one", async () => {
    const { context } = await setupAcademy("academy_owner", 1);

    const first = await createBranch(context, validInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await createBranch(context, validInput());
    expect(blocked.ok).toBe(false);

    const archived = await archiveBranch(context, first.branch.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) {
      expect(archived.branch.status).toBe("archived");
    }

    const afterArchive = await createBranch(context, validInput());
    expect(afterArchive.ok).toBe(true);
  });
});

describe("updateBranch / archiveBranch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: update/archive allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const branchResult = await createBranch(owner.context, validInput());
    expect(branchResult.ok).toBe(true);
    if (!branchResult.ok) return;

    // Re-use the same academy for a second membership of the role under test.
    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const updateResult = await updateBranch(actingContext, branchResult.branch.id, {
      name: "Renamed",
      code: branchResult.branch.code,
    });
    expect(updateResult.ok).toBe(allowed);
    if (!updateResult.ok) expect(updateResult.error.code).toBe("forbidden");

    const archiveResult = await archiveBranch(actingContext, branchResult.branch.id);
    expect(archiveResult.ok).toBe(allowed);
    if (!archiveResult.ok) expect(archiveResult.error.code).toBe("forbidden");
  });
});

describe("listBranches / getBranch — academy-wide roles see everything", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "role %s sees every branch in the academy, unfiltered by assignment",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const branchA = await insertBranchDirect(academyId);
      const branchB = await insertBranchDirect(academyId);

      const result = await listBranches(context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.branches.map((b) => b.id).sort();
      expect(ids).toEqual([branchA, branchB].sort());
      expect(result.canManage).toBe(true);
    },
  );

  it("finance_officer is refused entirely with code 'forbidden'", async () => {
    const { academyId, context } = await setupAcademy("finance_officer");
    await insertBranchDirect(academyId);

    const result = await listBranches(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("listBranches / getBranch — branch-limited roles (Admissions Officer, Trainer)", () => {
  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s sees only their assigned branch(es)",
    async (role) => {
      const { academyId, userId, context } = await setupAcademy(role);
      const assigned = await insertBranchDirect(academyId);
      const unassigned = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assigned]);

      const result = await listBranches(context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branches.map((b) => b.id)).toEqual([assigned]);
      expect(result.canManage).toBe(false);
      void unassigned;
    },
  );

  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s with no staff_profiles/assignment rows sees no branches",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      await insertBranchDirect(academyId);

      const result = await listBranches(context);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.branches).toEqual([]);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s: getBranch on an unassigned branch returns 404-equivalent 'not_found' (IDOR)",
    async (role) => {
      const { academyId, userId, context } = await setupAcademy(role);
      const assigned = await insertBranchDirect(academyId);
      const other = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assigned]);

      const okResult = await getBranch(context, assigned);
      expect(okResult.ok).toBe(true);

      const idorResult = await getBranch(context, other);
      expect(idorResult.ok).toBe(false);
      if (!idorResult.ok) expect(idorResult.error.code).toBe("not_found");
    },
  );

  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s: getBranch on a guessed/nonexistent id returns the identical 'not_found'",
    async (role) => {
      const { academyId, userId, context } = await setupAcademy(role);
      const assigned = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assigned]);

      const guessed = await getBranch(context, randomUUID());
      expect(guessed.ok).toBe(false);
      if (!guessed.ok) expect(guessed.error.code).toBe("not_found");
    },
  );
});

describe("tenant isolation — cross-academy access", () => {
  it("never returns another academy's branches from listBranches", async () => {
    const other = await setupAcademy("academy_owner");
    await insertBranchDirect(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listBranches(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branches).toEqual([]);
  });

  it("getBranch returns 'not_found' (never 'forbidden') for a branch belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranchId = await insertBranchDirect(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await getBranch(context, otherBranchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("subscription-state gating", () => {
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
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await listBranches({ userId, branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});

describe("getBranchDeletionEligibility / deleteBranch", () => {
  it("an unused branch (zero students/batches) is eligible and deletes", async () => {
    const { context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Unused Branch" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getBranchDeletionEligibility(context, created.branch.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteBranch(context, created.branch.id, "Unused Branch");
    expect(deleted.ok).toBe(true);

    const stillThere = await getBranch(context, created.branch.id);
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.error.code).toBe("not_found");
  });

  it("a branch with a student is blocked from deletion, and nothing is deleted", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Branch With Student" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await insertStudentDirect(academyId, created.branch.id, userId);

    const eligibility = await getBranchDeletionEligibility(context, created.branch.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.studentCount).toBe(1);
    }

    const deleted = await deleteBranch(context, created.branch.id, "Branch With Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    const stillThere = await getBranch(context, created.branch.id);
    expect(stillThere.ok).toBe(true);
  });

  it("a branch with a batch is blocked from deletion", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Branch With Batch" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const courseId = await insertProgramAndCourse(academyId);
    await insertBatchDirect(academyId, created.branch.id, courseId);

    const eligibility = await getBranchDeletionEligibility(context, created.branch.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.batchCount).toBe(1);
    }

    const deleted = await deleteBranch(context, created.branch.id, "Branch With Batch");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("rejects a wrong confirmation name, and nothing is deleted", async () => {
    const { context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Type Me Exactly" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteBranch(context, created.branch.id, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const stillThere = await getBranch(context, created.branch.id);
    expect(stillThere.ok).toBe(true);
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: delete allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const created = await createBranch(owner.context, validInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await deleteBranch(actingContext, created.branch.id, created.branch.name);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never deletes another academy's branch (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherCreated = await createBranch(other.context, validInput({ name: "Other Academy Branch" }));
    expect(otherCreated.ok).toBe(true);
    if (!otherCreated.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getBranchDeletionEligibility(context, otherCreated.branch.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteBranch(context, otherCreated.branch.id, "Other Academy Branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const stillThere = await getBranch(other.context, otherCreated.branch.id);
    expect(stillThere.ok).toBe(true);
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Audited Deletion" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteBranch(context, created.branch.id, "Audited Deletion");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.branch.id), eq(auditLogs.action, "deleteBranch")));
    expect(audit?.action).toBe("deleteBranch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: a student registered after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const created = await createBranch(context, validInput({ name: "Race Condition Branch" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const eligibility = await getBranchDeletionEligibility(context, created.branch.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent student registration landing between the
    // UI's eligibility preview and the actual delete call.
    await insertStudentDirect(academyId, created.branch.id, userId);

    const result = await deleteBranch(context, created.branch.id, "Race Condition Branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });
});
