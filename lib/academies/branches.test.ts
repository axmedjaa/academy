import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  staffBranchAssignments,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  archiveBranch,
  createBranch,
  getBranch,
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
