import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
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
  subscriptionPlans,
  timetables,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  createTimetableEntry,
  deleteTimetableEntry,
  listTimetableEntries,
  updateTimetableEntry,
} from "./timetables";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `timetables-test-${randomUUID()}@example.com`,
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
      name: `Timetables Test Plan ${randomUUID()}`,
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
      name: `Timetables Test Academy ${randomUUID()}`,
      slug: `timetables-test-${randomUUID()}`,
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

async function insertBatchDirect(
  academyId: string,
  branchId: string,
  courseId: string,
): Promise<string> {
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

async function insertStaffProfile(academyId: string, userId: string): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  return profile.id;
}

async function assignUserToBranches(
  academyId: string,
  userId: string,
  branchIds: string[],
): Promise<string> {
  const profileId = await insertStaffProfile(academyId, userId);
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profileId, branchId });
  }
  return profileId;
}

async function setupAcademy(role: AcademyRole): Promise<{
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
    await db.delete(timetables).where(eq(timetables.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
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

describe("createTimetableEntry — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["finance_officer", false],
  ])("role %s: create allowed = %s", async (role, allowed) => {
    const { context, branchId, batchId } = await setupAcademy(role);

    const result = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("admissions_officer ('view') is refused even for its own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId } = await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const result = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') succeeds within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const result = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "tue",
      startTime: "11:00",
      endTime: "12:00",
    });
    expect(result.ok).toBe(true);
  });

  it("trainer is refused outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, batchId } = await setupAcademy("trainer");
    const otherBranchId = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [otherBranchId]);
    const unassignedBranchId = await insertBranchDirect(academyId);

    const result = await createTimetableEntry(context, {
      branchId: unassignedBranchId,
      batchId,
      dayOfWeek: "wed",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("createTimetableEntry — validation", () => {
  it("rejects end_time <= start_time at the Zod layer", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");

    const result = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "10:00",
      endTime: "09:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects end_time <= start_time at the DB check constraint (bypassing app validation)", async () => {
    const { academyId, branchId, batchId } = await setupAcademy("academy_owner");

    await expect(
      db.insert(timetables).values({
        academyId,
        branchId,
        batchId,
        dayOfWeek: "mon",
        startTime: "10:00",
        endTime: "09:00",
      }),
    ).rejects.toThrow();
  });

  it("rejects a batch_id that doesn't exist (FK violation) with a not_found error", async () => {
    const { context, branchId } = await setupAcademy("academy_owner");

    const result = await createTimetableEntry(context, {
      branchId,
      batchId: randomUUID(),
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("does not persist any attendance/check-in field — schema has none", () => {
    const columns = Object.keys(timetables);
    expect(columns.some((c) => /attend|check.?in/i.test(c))).toBe(false);
  });
});

describe("listTimetableEntries", () => {
  it("returns entries for a batch, scoped to the caller's academy", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });

    const result = await listTimetableEntries(context, batchId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.canManage).toBe(true);
    }
  });

  it("hides entries outside a branch-limited caller's assigned branch(es)", async () => {
    const { academyId, userId, context, branchId, courseId, batchId } =
      await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);

    const otherBranchId = await insertBranchDirect(academyId);
    const otherBatchId = await insertBatchDirect(academyId, otherBranchId, courseId);
    await db.insert(timetables).values({
      academyId,
      branchId: otherBranchId,
      batchId: otherBatchId,
      dayOfWeek: "fri",
      startTime: "13:00",
      endTime: "14:00",
    });
    await db.insert(timetables).values({
      academyId,
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });

    const resultOwnBranch = await listTimetableEntries(context, batchId);
    expect(resultOwnBranch.ok).toBe(true);
    if (resultOwnBranch.ok) expect(resultOwnBranch.entries).toHaveLength(1);

    const resultOtherBranch = await listTimetableEntries(context, otherBatchId);
    expect(resultOtherBranch.ok).toBe(true);
    if (resultOtherBranch.ok) expect(resultOtherBranch.entries).toHaveLength(0);
  });

  it("returns not_found for a batch in a different academy", async () => {
    const { context } = await setupAcademy("academy_owner");
    const { batchId: otherBatchId } = await setupAcademy("academy_owner");

    const result = await listTimetableEntries(context, otherBatchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("updateTimetableEntry", () => {
  it("updates fields and re-validates the resulting time range", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const created = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateTimetableEntry(context, created.entry.id, { room: "Room 1" });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.entry.room).toBe("Room 1");

    const invalid = await updateTimetableEntry(context, created.entry.id, { startTime: "11:00" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("validation");
  });

  it("rejects a branch-limited caller updating an out-of-scope entry (IDOR)", async () => {
    const { academyId, context: ownerContext, branchId, batchId } =
      await setupAcademy("academy_owner");
    const created = await createTimetableEntry(ownerContext, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const trainerUserId = await createUser();
    await addMembership(trainerUserId, academyId, "trainer");
    const otherBranchId = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, trainerUserId, [otherBranchId]);
    const trainerContext: AuthContext = { userId: trainerUserId, branchIds: [], academyWide: false };

    const result = await updateTimetableEntry(trainerContext, created.entry.id, { room: "Hacked" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("deleteTimetableEntry", () => {
  it("hard-deletes the row (no status column exists on this table)", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const created = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "mon",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteTimetableEntry(context, created.entry.id);
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(timetables).where(eq(timetables.id, created.entry.id));
    expect(row).toBeUndefined();
  });

  it("returns not_found for an already-deleted or nonexistent entry", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await deleteTimetableEntry(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
