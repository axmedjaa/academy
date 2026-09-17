import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  branches,
  courses,
  programs,
  staffBranchAssignments,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  assignTrainerToBatch,
  enrollStudentInBatch,
  getAssignedBatchIds,
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
  unassignTrainerFromBatch,
  withdrawStudentFromBatch,
} from "./batch-assignments";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `batch-assignments-test-${randomUUID()}@example.com`,
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
      name: `Batch Assignments Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
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
      name: `Batch Assignments Test Academy ${randomUUID()}`,
      slug: `batch-assignments-test-${randomUUID()}`,
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

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
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

/** Creates a staff_profiles row for userId in academyId, returning its id. */
async function insertStaffProfile(academyId: string, userId: string): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  return profile.id;
}

async function assignUserToBranches(academyId: string, userId: string, branchIds: string[]): Promise<string> {
  const profileId = await insertStaffProfile(academyId, userId);
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profileId, branchId });
  }
  return profileId;
}

async function setupAcademy(
  role: AcademyRole,
): Promise<{
  academyId: string;
  userId: string;
  creatorUserId: string;
  branchId: string;
  courseId: string;
  batchId: string;
  context: AuthContext;
}> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);
  const branchId = await insertBranchDirect(academyId);
  const courseId = await insertProgramAndCourse(academyId);
  const batchId = await insertBatchDirect(academyId, branchId, courseId);

  return {
    academyId,
    userId,
    creatorUserId,
    branchId,
    courseId,
    batchId,
    context: { userId, branchIds: [], academyWide: false },
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
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    const profiles = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(eq(staffProfiles.academyId, academyId));
    for (const profile of profiles) {
      await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, profile.id));
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

describe("assignTrainerToBatch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["finance_officer", false],
  ])("role %s: assign allowed = %s", async (role, allowed) => {
    const { context, academyId, batchId } = await setupAcademy(role);
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("admissions_officer ('view') is refused even for its own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId } = await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can assign a trainer within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const otherTrainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, otherTrainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(true);
  });

  it("trainer cannot assign into a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);
    const otherTrainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, otherTrainerUserId);

    const result = await assignTrainerToBatch(context, { batchId: outOfScopeBatch, staffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a batch belonging to another academy with 'not_found' (cross-academy IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const { context, academyId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId: other.batchId, staffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent staffProfileId with 'not_found'", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const result = await assignTrainerToBatch(context, { batchId, staffProfileId: randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful assignment", async () => {
    const { context, academyId, userId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const result = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.assignment.id));
    expect(audit?.action).toBe("assignTrainerToBatch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });
});

describe("assign/unassign trainer — unique constraint + reactivation", () => {
  it("assigning the same staff member to the same batch twice while active is a conflict", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const first = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(first.ok).toBe(true);

    const second = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("unassigning then reassigning the same pair reactivates the same row (no duplicate insert)", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const first = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const unassigned = await unassignTrainerFromBatch(context, first.assignment.id);
    expect(unassigned.ok).toBe(true);
    if (unassigned.ok) expect(unassigned.assignment.status).toBe("removed");

    const reassigned = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(reassigned.ok).toBe(true);
    if (reassigned.ok) {
      expect(reassigned.assignment.id).toBe(first.assignment.id);
      expect(reassigned.assignment.status).toBe("active");
    }

    const rows = await db
      .select()
      .from(batchTrainerAssignments)
      .where(eq(batchTrainerAssignments.staffProfileId, staffProfileId));
    expect(rows.length).toBe(1);
  });

  it("unassigning an already-removed assignment returns 'invalid_transition'", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);

    const created = await assignTrainerToBatch(context, { batchId, staffProfileId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(first.ok).toBe(true);

    const second = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_transition");
  });

  it("trainer cannot unassign outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);

    const ownerContext: AuthContext = { userId: await createUser(), branchIds: [], academyWide: false };
    await addMembership(ownerContext.userId, academyId, "academy_owner");
    const trainerUserId = await createUser();
    const staffProfileId = await insertStaffProfile(academyId, trainerUserId);
    const created = await assignTrainerToBatch(ownerContext, { batchId: outOfScopeBatch, staffProfileId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await unassignTrainerFromBatch(context, created.assignment.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enrollStudentInBatch — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["finance_officer", false],
  ])("role %s: enroll allowed = %s", async (role, allowed) => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy(role);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("admissions_officer ('view') is refused even for its own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } =
      await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can enroll within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId });
    expect(result.ok).toBe(true);
  });

  it("trainer cannot enroll into a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId, creatorUserId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);
    const studentId = await insertStudentDirect(academyId, otherBranch, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId: outOfScopeBatch, studentId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent studentId with 'not_found'", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const result = await enrollStudentInBatch(context, { batchId, studentId: randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful enrollment", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, userId } = await setupAcademy(
      "academy_owner",
    );
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.enrollment.id));
    expect(audit?.action).toBe("enrollStudentInBatch");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });
});

describe("cross-academy integrity check — enrollStudentInBatch", () => {
  it("rejects enrollment when the student belongs to a different academy than the batch", async () => {
    const home = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const otherAcademyStudentId = await insertStudentDirect(
      other.academyId,
      other.branchId,
      other.creatorUserId,
    );

    const result = await enrollStudentInBatch(home.context, {
      batchId: home.batchId,
      studentId: otherAcademyStudentId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects enrollment when the batch belongs to a different academy than the student", async () => {
    const home = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const homeStudentId = await insertStudentDirect(home.academyId, home.branchId, home.creatorUserId);

    // Caller is a member of `home`, so `other.batchId` is out-of-tenant
    // from the caller's own perspective too — resolved before the student
    // check ever runs, but exercises the same "batch not in my academy"
    // path with a same-academy student on the other side of the mismatch.
    const result = await enrollStudentInBatch(home.context, {
      batchId: other.batchId,
      studentId: homeStudentId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enroll/withdraw student — unique-for-active-enrollment enforcement", () => {
  it("enrolling the same student in the same batch twice while active is a conflict", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId });
    expect(first.ok).toBe(true);

    const second = await enrollStudentInBatch(context, { batchId, studentId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("a withdrawn enrollment allows re-enrollment (new row, not a reactivation)", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const withdrawn = await withdrawStudentFromBatch(context, first.enrollment.id);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) expect(withdrawn.enrollment.status).toBe("withdrawn");

    const reenrolled = await enrollStudentInBatch(context, { batchId, studentId });
    expect(reenrolled.ok).toBe(true);
    if (reenrolled.ok) {
      expect(reenrolled.enrollment.id).not.toBe(first.enrollment.id);
      expect(reenrolled.enrollment.status).toBe("active");
    }

    const rows = await db
      .select()
      .from(batchEnrollments)
      .where(eq(batchEnrollments.studentId, studentId));
    expect(rows.length).toBe(2);
  });

  it("withdrawing an already-withdrawn enrollment returns 'invalid_transition'", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const created = await enrollStudentInBatch(context, { batchId, studentId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(first.ok).toBe(true);

    const second = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_transition");
  });
});

describe("getAssignedBatchIds", () => {
  it("returns only batches with an ACTIVE trainer assignment for this user+academy", async () => {
    const { academyId, userId, batchId } = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(academyId, userId);
    // Bypass permission gating: insert directly to set up two assignments,
    // one active and one removed, plus a batch with no assignment at all.
    const branchId2 = await insertBranchDirect(academyId);
    const courseId2 = await insertProgramAndCourse(academyId);
    const otherAssignedBatch = await insertBatchDirect(academyId, branchId2, courseId2);
    const unassignedBatch = await insertBatchDirect(academyId, branchId2, courseId2);

    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId, staffProfileId, status: "active" });
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId: otherAssignedBatch, staffProfileId, status: "removed" });

    const assignedIds = await getAssignedBatchIds(db, userId, academyId);
    expect(assignedIds).toEqual([batchId]);
    expect(assignedIds).not.toContain(otherAssignedBatch);
    expect(assignedIds).not.toContain(unassignedBatch);
  });

  it("returns an empty list for a user with no staff_profiles row", async () => {
    const { academyId } = await setupAcademy("trainer");
    const randomUserId = await createUser();
    const assignedIds = await getAssignedBatchIds(db, randomUserId, academyId);
    expect(assignedIds).toEqual([]);
  });

  it("never crosses academy boundaries — same user, different academy, no leakage", async () => {
    const first = await setupAcademy("trainer");
    const second = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(first.academyId, first.userId);
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId: first.academyId, batchId: first.batchId, staffProfileId, status: "active" });

    const idsInSecondAcademy = await getAssignedBatchIds(db, first.userId, second.academyId);
    expect(idsInSecondAcademy).toEqual([]);
  });

  it("listMyAssignedBatches exposes the same result through the gated wrapper", async () => {
    const { academyId, userId, batchId, context } = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(academyId, userId);
    await db
      .insert(batchTrainerAssignments)
      .values({ academyId, batchId, staffProfileId, status: "active" });

    const result = await listMyAssignedBatches(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.batchIds).toEqual([batchId]);
  });
});

describe("listBatchTrainerAssignments / listBatchEnrollments — branch scoping", () => {
  it("branch-limited role cannot list a batch's roster outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);

    const assignmentsResult = await listBatchTrainerAssignments(context, outOfScopeBatch);
    expect(assignmentsResult.ok).toBe(false);
    if (!assignmentsResult.ok) expect(assignmentsResult.error.code).toBe("not_found");

    const enrollmentsResult = await listBatchEnrollments(context, outOfScopeBatch);
    expect(enrollmentsResult.ok).toBe(false);
    if (!enrollmentsResult.ok) expect(enrollmentsResult.error.code).toBe("not_found");
  });

  it("returns 'not_found' (never 'forbidden') for a batch belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");

    const result = await listBatchTrainerAssignments(context, other.batchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
