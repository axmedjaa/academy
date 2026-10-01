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
  createWeeklyTimetableEntries,
  deleteTimetableEntry,
  listAcademyTimetable,
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

  it("creates an entry when the batch's own branch matches the supplied branchId", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");

    const result = await createTimetableEntry(context, {
      branchId,
      batchId,
      dayOfWeek: "thu",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.branchId).toBe(branchId);
      expect(result.entry.batchId).toBe(batchId);
    }
  });

  it("rejects a batchId whose actual branch differs from the supplied (in-scope) branchId, and creates no entry", async () => {
    const { academyId, context, branchId, courseId } = await setupAcademy("academy_owner");
    const otherBranchId = await insertBranchDirect(academyId);
    const otherBranchBatchId = await insertBatchDirect(academyId, otherBranchId, courseId);

    const result = await createTimetableEntry(context, {
      branchId,
      batchId: otherBranchBatchId,
      dayOfWeek: "fri",
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const entries = await db
      .select()
      .from(timetables)
      .where(eq(timetables.batchId, otherBranchBatchId));
    expect(entries).toHaveLength(0);
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

  it("deleting one day's entry for a batch leaves the batch's other days untouched", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const monday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    const wednesday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "wed", startTime: "09:00", endTime: "11:00" });
    expect(monday.ok && wednesday.ok).toBe(true);
    if (!monday.ok || !wednesday.ok) return;

    const result = await deleteTimetableEntry(context, monday.entry.id);
    expect(result.ok).toBe(true);

    const remaining = await listTimetableEntries(context, batchId);
    expect(remaining.ok).toBe(true);
    if (remaining.ok) {
      expect(remaining.entries).toHaveLength(1);
      expect(remaining.entries[0].id).toBe(wednesday.entry.id);
      expect(remaining.entries[0].dayOfWeek).toBe("wed");
    }
  });
});

describe("createTimetableEntry / updateTimetableEntry — conflict detection", () => {
  it("creates a basic entry with Branch + Course + Batch + Monday + 09:00-11:00 (course is derived via the batch, never its own field)", async () => {
    const { context, branchId, batchId, courseId } = await setupAcademy("academy_owner");
    const result = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(result.ok).toBe(true);

    const listed = await listAcademyTimetable(context);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const entry = listed.entries.find((e) => e.id === (result.ok ? result.entry.id : undefined));
      expect(entry).toBeDefined();
      expect(entry?.branchName).toBeTruthy();
      expect(entry?.batchName).toBeTruthy();
      // courseId isn't a field anywhere — confirm the joined courseName
      // actually resolves to the batch's own course, not a coincidence.
      const [course] = await db.select({ name: courses.name }).from(courses).where(eq(courses.id, courseId));
      expect(entry?.courseName).toBe(course.name);
    }
  });

  it("allows the same batch to teach on multiple different days (Monday + Wednesday = two entries)", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const monday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    const wednesday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "wed", startTime: "09:00", endTime: "11:00" });
    expect(monday.ok).toBe(true);
    expect(wednesday.ok).toBe(true);

    const entries = await listTimetableEntries(context, batchId);
    expect(entries.ok).toBe(true);
    if (entries.ok) expect(entries.entries).toHaveLength(2);
  });

  it("allows the same batch on the same day at non-overlapping times", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const morning = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    const afternoon = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "13:00", endTime: "15:00" });
    expect(morning.ok).toBe(true);
    expect(afternoon.ok).toBe(true);
  });

  it("rejects the same batch overlapping on the same day (09:00-11:00 vs 10:00-12:00)", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(first.ok).toBe(true);

    const second = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "10:00", endTime: "12:00" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("rejects the same instructor double-booked across two different batches on an overlapping day/time", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const instructorUserId = await createUser();
    const trainerStaffProfileId = await insertStaffProfile(academyId, instructorUserId);
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);

    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", trainerStaffProfileId });
    expect(first.ok).toBe(true);

    const second = await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "mon", startTime: "10:00", endTime: "12:00", trainerStaffProfileId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("rejects the same room double-booked (same branch) on an overlapping day/time, case/whitespace-insensitively", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);

    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(first.ok).toBe(true);

    const second = await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "mon", startTime: "10:00", endTime: "12:00", room: "  room a  " });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("never compares across different days — same batch/instructor/room on different days is allowed", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const instructorUserId = await createUser();
    const trainerStaffProfileId = await insertStaffProfile(academyId, instructorUserId);
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);

    const monday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A", trainerStaffProfileId });
    expect(monday.ok).toBe(true);

    // Same instructor AND same room AND overlapping time, but a DIFFERENT
    // day and a different batch — must be allowed, never cross-day compared.
    const tuesday = await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "tue", startTime: "09:00", endTime: "11:00", room: "Room A", trainerStaffProfileId });
    expect(tuesday.ok).toBe(true);
  });

  it("two entries with no instructor set on an overlapping day/time do not conflict with each other", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);

    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(first.ok).toBe(true);
    const second = await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(second.ok).toBe(true);
  });

  it("two entries with no room set on an overlapping day/time do not conflict with each other", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);

    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(first.ok).toBe(true);
    const second = await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(second.ok).toBe(true);
  });

  it("the conflict check is tenant-isolated — an identical slot in a different academy never conflicts", async () => {
    const { context: contextA, branchId: branchA, batchId: batchA } = await setupAcademy("academy_owner");
    const { context: contextB, branchId: branchB, batchId: batchB } = await setupAcademy("academy_owner");

    const first = await createTimetableEntry(contextA, { branchId: branchA, batchId: batchA, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(first.ok).toBe(true);

    // Same day/time/room string, but a completely different academy/batch —
    // must not be treated as a conflict.
    const second = await createTimetableEntry(contextB, { branchId: branchB, batchId: batchB, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(second.ok).toBe(true);
  });

  it("edit: moving an entry from Monday to Wednesday succeeds, and re-checks conflicts against the NEW day", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const monday = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(monday.ok).toBe(true);
    if (!monday.ok) return;

    // Nothing else on Wednesday yet — the move should succeed.
    const moved = await updateTimetableEntry(context, monday.entry.id, { dayOfWeek: "wed" });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.entry.dayOfWeek).toBe("wed");

    // A second entry already sitting on Wednesday at the same time should
    // now block a second move into that slot.
    const anotherBatchEntry = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(anotherBatchEntry.ok).toBe(true);
    if (!anotherBatchEntry.ok) return;
    const blockedMove = await updateTimetableEntry(context, anotherBatchEntry.entry.id, { dayOfWeek: "wed" });
    expect(blockedMove.ok).toBe(false);
    if (!blockedMove.ok) expect(blockedMove.error.code).toBe("conflict");
  });

  it("edit: an entry never conflicts with itself when the patch doesn't change anything relevant", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const created = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateTimetableEntry(context, created.entry.id, { room: "Room A" });
    expect(updated.ok).toBe(true);
  });

  it("edit: changing a time range so it would now overlap a different existing entry is rejected", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const first = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    const second = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "13:00", endTime: "15:00" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const result = await updateTimetableEntry(context, second.entry.id, { startTime: "10:00", endTime: "12:00" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });
});

describe("createWeeklyTimetableEntries — multi-day creation", () => {
  it("creates one row per selected day, all sharing the same time/batch/instructor/room", async () => {
    const { academyId, context, branchId, batchId } = await setupAcademy("academy_owner");
    const instructorUserId = await createUser();
    const trainerStaffProfileId = await insertStaffProfile(academyId, instructorUserId);

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "wed"],
      startTime: "09:00",
      endTime: "11:00",
      room: "Room A",
      trainerStaffProfileId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.dayOfWeek).sort()).toEqual(["mon", "wed"]);
    for (const entry of result.entries) {
      // Postgres `time` columns round-trip with seconds appended.
      expect(entry.startTime).toBe("09:00:00");
      expect(entry.endTime).toBe("11:00:00");
      expect(entry.room).toBe("Room A");
      expect(entry.trainerStaffProfileId).toBe(trainerStaffProfileId);
      expect(entry.batchId).toBe(batchId);
    }
  });

  it("Monday through Friday creates five rows", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(5);
  });

  it("a single selected day creates exactly one row", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["fri"],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
  });

  it("rejects an empty day selection, server-side, regardless of client validation", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: [],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/at least one/i);
    }
  });

  it("deduplicates a day submitted more than once — never creates duplicate rows", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "mon", "wed", "mon"],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries.map((e) => e.dayOfWeek).sort()).toEqual(["mon", "wed"]);
    }
  });

  it("is forbidden for roles without manage access, identically to single-day creation", async () => {
    const { context, branchId, batchId } = await setupAcademy("finance_officer");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue"],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("createWeeklyTimetableEntries — atomicity", () => {
  async function countEntries(batchId: string): Promise<number> {
    const rows = await db.select().from(timetables).where(eq(timetables.batchId, batchId));
    return rows.length;
  }

  it("creates nothing when the FIRST selected day conflicts", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue", "wed"],
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(await countEntries(batchId)).toBe(1); // only the pre-existing Monday row
  });

  it("creates nothing when the MIDDLE selected day conflicts", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "wed", startTime: "09:00", endTime: "11:00" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "wed", "fri"],
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(await countEntries(batchId)).toBe(1); // only the pre-existing Wednesday row — Monday never got created
  });

  it("creates nothing when the LAST selected day conflicts", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "fri", startTime: "09:00", endTime: "11:00" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(await countEntries(batchId)).toBe(1); // Mon/Tue/Wed/Thu never got created
  });

  it("the conflict message names the day, the conflicting resource, and the existing time range", async () => {
    const { academyId, context, branchId, batchId } = await setupAcademy("academy_owner");
    const otherBatchId = await insertBatchDirect(academyId, branchId, await insertProgramAndCourse(academyId));
    await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "wed", startTime: "10:00", endTime: "12:00", room: "Room A" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "wed"],
      startTime: "09:00",
      endTime: "11:00",
      room: "Room A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Wednesday");
      expect(result.error.message).toContain("Room A");
      expect(result.error.message).toContain("10:00");
      expect(result.error.message).toContain("12:00");
    }
  });

  it("leaves pre-existing rows completely untouched after a failed weekly creation", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const existing = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "tue", startTime: "09:00", endTime: "11:00", room: "Original Room" });
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;

    await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue"],
      startTime: "10:00",
      endTime: "12:00",
    });

    const [row] = await db.select().from(timetables).where(eq(timetables.id, existing.entry.id));
    expect(row.room).toBe("Original Room");
    expect(row.startTime).toBe("09:00:00");
  });
});

describe("createWeeklyTimetableEntries — conflict rules exercised through the weekly path", () => {
  it("same batch overlap on one of the selected days rejects the whole operation", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "thu", startTime: "09:00", endTime: "11:00" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "thu"],
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(result.ok).toBe(false);
  });

  it("same instructor overlap, across a different batch, on one of the selected days rejects the whole operation", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const instructorUserId = await createUser();
    const trainerStaffProfileId = await insertStaffProfile(academyId, instructorUserId);
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);
    await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "fri", startTime: "09:00", endTime: "11:00", trainerStaffProfileId });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "fri"],
      startTime: "10:00",
      endTime: "12:00",
      trainerStaffProfileId,
    });
    expect(result.ok).toBe(false);
  });

  it("same room overlap, same branch, on one of the selected days rejects the whole operation", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const otherBatchId = await insertBatchDirect(academyId, branchId, courseId);
    await createTimetableEntry(context, { branchId, batchId: otherBatchId, dayOfWeek: "sat", startTime: "09:00", endTime: "11:00", room: "  Room B " });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "sat"],
      startTime: "10:00",
      endTime: "12:00",
      room: "room b",
    });
    expect(result.ok).toBe(false);
  });

  it("same room in a DIFFERENT branch does not conflict (room conflicts remain branch-scoped)", async () => {
    const { academyId, context, branchId, courseId, batchId } = await setupAcademy("academy_owner");
    const otherBranchId = await insertBranchDirect(academyId);
    const otherBranchBatchId = await insertBatchDirect(academyId, otherBranchId, courseId);
    await createTimetableEntry(context, { branchId: otherBranchId, batchId: otherBranchBatchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon"],
      startTime: "09:00",
      endTime: "11:00",
      room: "Room A",
    });
    expect(result.ok).toBe(true);
  });

  it("the same time on different days succeeds (never cross-day compared)", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(5);
  });

  it("non-overlapping times on the same day succeed", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon"],
      startTime: "13:00",
      endTime: "15:00",
    });
    expect(result.ok).toBe(true);
  });

  it("tenant isolation — an identical weekly slot in a different academy never conflicts", async () => {
    const { context: contextA, branchId: branchA, batchId: batchA } = await setupAcademy("academy_owner");
    const { context: contextB, branchId: branchB, batchId: batchB } = await setupAcademy("academy_owner");

    const first = await createWeeklyTimetableEntries(contextA, { branchId: branchA, batchId: batchA, daysOfWeek: ["mon", "tue"], startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(first.ok).toBe(true);

    const second = await createWeeklyTimetableEntries(contextB, { branchId: branchB, batchId: batchB, daysOfWeek: ["mon", "tue"], startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(second.ok).toBe(true);
  });
});

describe("createWeeklyTimetableEntries — instructor tenant scoping", () => {
  it("rejects a cross-academy instructor id (previously only validated as 'a UUID', never that it belongs to this academy)", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const foreignInstructorUserId = await createUser();
    const foreignTrainerStaffProfileId = await insertStaffProfile(other.academyId, foreignInstructorUserId);

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon"],
      startTime: "09:00",
      endTime: "11:00",
      trainerStaffProfileId: foreignTrainerStaffProfileId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const rows = await db.select().from(timetables).where(eq(timetables.batchId, batchId));
    expect(rows).toHaveLength(0);
  });

  it("accepts an instructor that genuinely belongs to this academy", async () => {
    const { academyId, context, branchId, batchId } = await setupAcademy("academy_owner");
    const instructorUserId = await createUser();
    const trainerStaffProfileId = await insertStaffProfile(academyId, instructorUserId);

    const result = await createWeeklyTimetableEntries(context, {
      branchId,
      batchId,
      daysOfWeek: ["mon"],
      startTime: "09:00",
      endTime: "11:00",
      trainerStaffProfileId,
    });
    expect(result.ok).toBe(true);
  });

  it("updateTimetableEntry also rejects a cross-academy instructor id", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const foreignInstructorUserId = await createUser();
    const foreignTrainerStaffProfileId = await insertStaffProfile(other.academyId, foreignInstructorUserId);

    const created = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateTimetableEntry(context, created.entry.id, { trainerStaffProfileId: foreignTrainerStaffProfileId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("createTimetableEntry — still works as the single-day entry point (wrapper regression check)", () => {
  it("single-day creation still works exactly as before", async () => {
    const { context, branchId, batchId } = await setupAcademy("academy_owner");
    const result = await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", room: "Room A" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.dayOfWeek).toBe("mon");
      expect(result.entry.room).toBe("Room A");
    }
  });
});
