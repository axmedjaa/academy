import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
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
import { listStaff } from "./staff";
import {
  assignStaffBranches,
  listAssignedBranches,
} from "./staff-branch-assignments";

/**
 * PLAN.md Phase 2, Item 36 — "Staff branch assignment (many-to-many) +
 * branch-scoped filter + IDOR test." Same "one top-level cleanup, every
 * test builds its own fully isolated fixture set" convention as
 * lib/academies/staff.test.ts / branches.test.ts.
 */

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `staff-branch-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Staff Branch Test Plan ${randomUUID()}`,
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
  return plan.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Staff Branch Test Academy ${randomUUID()}`,
      slug: `staff-branch-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function setupAcademy(
  role: AcademyRole,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return { academyId, userId, context: { userId, branchIds: [], academyWide: false } };
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

/** Creates a bare staff_profiles row (no branch assignments yet) for a
 * fresh user, mirroring lib/academies/staff.test.ts's createTargetStaff. */
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

/** Gives the actor themselves a staff_profiles row (+ optional branch
 * assignments) in their own academy — needed for every branch-scoping test
 * since the actor is also a staff member being filtered/joined against. */
async function giveActorStaffProfile(
  academyId: string,
  userId: string,
  branchIds: string[] = [],
): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Actor Staff", phone: "+1-555-0111" })
    .returning({ id: staffProfiles.id });
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profile.id, branchId });
  }
  return profile.id;
}

async function assignBranchesDirect(
  academyId: string,
  staffProfileId: string,
  branchIds: string[],
): Promise<void> {
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId, branchId });
  }
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
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
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

describe("assignStaffBranches — permission matrix (Full/Manage may assign, everyone else refused)", () => {
  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "allows %s to assign branches",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const branchId = await insertBranchDirect(academyId);

      const result = await assignStaffBranches(context, target.staffProfileId, [branchId]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.branchIds).toEqual([branchId]);
    },
  );

  it.each<AcademyRole>(["admissions_officer", "finance_officer", "trainer"])(
    "refuses %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const target = await createTargetStaff(academyId);
      const branchId = await insertBranchDirect(academyId);

      const result = await assignStaffBranches(context, target.staffProfileId, [branchId]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );
});

describe("assignStaffBranches — assign/reassign/unassign (diff + insert/delete)", () => {
  it("assigns a fresh set of branches", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);

    const result = await assignStaffBranches(context, target.staffProfileId, [branchA, branchB]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.branchIds.slice().sort()).toEqual([branchA, branchB].sort());

    const rows = await db
      .select({ branchId: staffBranchAssignments.branchId })
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, target.staffProfileId));
    expect(rows.map((r) => r.branchId).sort()).toEqual([branchA, branchB].sort());
  });

  it("reassigns: replaces the full set on a second call (diff adds and removes)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);
    const branchC = await insertBranchDirect(academyId);

    const first = await assignStaffBranches(context, target.staffProfileId, [branchA, branchB]);
    expect(first.ok).toBe(true);

    const second = await assignStaffBranches(context, target.staffProfileId, [branchB, branchC]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.branchIds.slice().sort()).toEqual([branchB, branchC].sort());

    const rows = await db
      .select({ branchId: staffBranchAssignments.branchId })
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, target.staffProfileId));
    expect(rows.map((r) => r.branchId).sort()).toEqual([branchB, branchC].sort());
  });

  it("unassigns: an empty array removes every existing assignment", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);
    await assignBranchesDirect(academyId, target.staffProfileId, [branchA]);

    const result = await assignStaffBranches(context, target.staffProfileId, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branchIds).toEqual([]);

    const rows = await db
      .select({ branchId: staffBranchAssignments.branchId })
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, target.staffProfileId));
    expect(rows).toEqual([]);
  });

  it("de-duplicates a caller-supplied duplicate branchId instead of erroring on the unique index", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);

    const result = await assignStaffBranches(context, target.staffProfileId, [branchA, branchA]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branchIds).toEqual([branchA]);
  });

  it("writes an audit row with before/after branchIds", async () => {
    const { academyId, userId: actorUserId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);
    await assignBranchesDirect(academyId, target.staffProfileId, [branchA]);
    const branchB = await insertBranchDirect(academyId);

    const result = await assignStaffBranches(context, target.staffProfileId, [branchB]);
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, target.staffProfileId), eq(auditLogs.action, "assignStaffBranches")),
      );
    expect(audit?.actorUserId).toBe(actorUserId);
    expect((audit?.before as { branchIds: string[] } | null)?.branchIds).toEqual([branchA]);
    expect((audit?.after as { branchIds: string[] } | null)?.branchIds).toEqual([branchB]);
  });
});

describe("assignStaffBranches — validation / IDOR", () => {
  it("returns 'not_found' for a staffProfileId belonging to another academy (tenant isolation / IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId);

    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);

    const result = await assignStaffBranches(context, otherTarget.staffProfileId, [branchId]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("returns the identical 'not_found' for a guessed/nonexistent staffProfileId", async () => {
    const { context } = await setupAcademy("academy_owner");

    const result = await assignStaffBranches(context, randomUUID(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a branchId belonging to another academy with code 'validation' (never silently attaches it)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranchId = await insertBranchDirect(other.academyId);

    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);

    const result = await assignStaffBranches(context, target.staffProfileId, [otherBranchId]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const rows = await db
      .select()
      .from(staffBranchAssignments)
      .where(eq(staffBranchAssignments.staffProfileId, target.staffProfileId));
    expect(rows).toEqual([]);
  });

  it("rejects a nonexistent/guessed branchId with code 'validation'", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);

    const result = await assignStaffBranches(context, target.staffProfileId, [randomUUID()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("listAssignedBranches", () => {
  it("returns the current branch set for a staff member (manage/full access)", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const target = await createTargetStaff(academyId);
    const branchA = await insertBranchDirect(academyId);
    await assignBranchesDirect(academyId, target.staffProfileId, [branchA]);

    const result = await listAssignedBranches(context, target.staffProfileId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branchIds).toEqual([branchA]);
  });

  it("refuses a view-level (trainer) or none-level caller with code 'forbidden'", async () => {
    const { academyId, context } = await setupAcademy("trainer");
    const target = await createTargetStaff(academyId);

    const result = await listAssignedBranches(context, target.staffProfileId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("returns 'not_found' for another academy's staffProfileId (IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherTarget = await createTargetStaff(other.academyId);

    const { context } = await setupAcademy("academy_owner");
    const result = await listAssignedBranches(context, otherTarget.staffProfileId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("listStaff branch-scoped filter (Item 36) — Trainer 'View self/assigned' vs. academy-wide roles", () => {
  it("a Trainer's listStaff returns only self + branch-shared staff", async () => {
    const { academyId, userId: trainerUserId, context } = await setupAcademy("trainer");
    const sharedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);

    const trainerProfileId = await giveActorStaffProfile(academyId, trainerUserId, [sharedBranch]);

    const sharedColleague = await createTargetStaff(academyId);
    await assignBranchesDirect(academyId, sharedColleague.staffProfileId, [sharedBranch]);

    const unsharedColleague = await createTargetStaff(academyId);
    await assignBranchesDirect(academyId, unsharedColleague.staffProfileId, [otherBranch]);

    const unassignedColleague = await createTargetStaff(academyId);
    // (no branch assignment at all for unassignedColleague)

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.staff.map((s) => s.id).sort();
    expect(ids).toEqual([trainerProfileId, sharedColleague.staffProfileId].sort());
    expect(ids).not.toContain(unsharedColleague.staffProfileId);
    expect(ids).not.toContain(unassignedColleague.staffProfileId);
  });

  it("a Trainer with no staff_profiles row of their own sees nothing (defensive empty, not an error)", async () => {
    const { academyId, context } = await setupAcademy("trainer");
    await createTargetStaff(academyId);

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staff).toEqual([]);
  });

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager"])(
    "an academy-wide role (%s)'s listStaff is unfiltered by branch",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      const branchA = await insertBranchDirect(academyId);
      const branchB = await insertBranchDirect(academyId);

      const staffOnA = await createTargetStaff(academyId);
      await assignBranchesDirect(academyId, staffOnA.staffProfileId, [branchA]);
      const staffOnB = await createTargetStaff(academyId);
      await assignBranchesDirect(academyId, staffOnB.staffProfileId, [branchB]);
      const staffUnassigned = await createTargetStaff(academyId);

      const result = await listStaff(context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ids = result.staff.map((s) => s.id);
      expect(ids).toContain(staffOnA.staffProfileId);
      expect(ids).toContain(staffOnB.staffProfileId);
      expect(ids).toContain(staffUnassigned.staffProfileId);
    },
  );

  it("IDOR: a Trainer with zero shared branches never sees the other staff member's record, including via a guessed id", async () => {
    const { academyId, userId: trainerUserId, context } = await setupAcademy("trainer");
    const trainerBranch = await insertBranchDirect(academyId);
    await giveActorStaffProfile(academyId, trainerUserId, [trainerBranch]);

    const strangerBranch = await insertBranchDirect(academyId);
    const stranger = await createTargetStaff(academyId);
    await assignBranchesDirect(academyId, stranger.staffProfileId, [strangerBranch]);

    const result = await listStaff(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staff.map((s) => s.id)).not.toContain(stranger.staffProfileId);

    // The Trainer also has no manage-level access to the stranger's
    // staffProfileId at all (guessed or not) — assignStaffBranches/
    // updateStaff both refuse "forbidden" regardless of branch overlap,
    // since Trainer's academy.staff level is "view", never "manage"/"full".
    const guessResult = await assignStaffBranches(context, stranger.staffProfileId, []);
    expect(guessResult.ok).toBe(false);
    if (!guessResult.ok) expect(guessResult.error.code).toBe("forbidden");

    const guessedId = await assignStaffBranches(context, randomUUID(), []);
    expect(guessedId.ok).toBe(false);
    if (!guessedId.ok) expect(guessedId.error.code).toBe("forbidden");
  });
});
