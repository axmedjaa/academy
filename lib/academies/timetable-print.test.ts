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
  staffProfiles,
  subscriptionPlans,
  timetables,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createTimetableEntry } from "./timetables";
import { getTimetablePrintData } from "./timetable-print";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `timetable-print-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Timetable Print Test Plan ${randomUUID()}`,
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
    .values({ name: `Timetable Print Test Academy ${randomUUID()}`, slug: `timetable-print-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(academyId: string, name = `Branch ${randomUUID()}`): Promise<string> {
  const [row] = await db.insert(branches).values({ academyId, name, code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
  return row.id;
}

async function insertProgramAndCourse(academyId: string, name = `Course ${randomUUID()}`): Promise<string> {
  const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db.insert(courses).values({ academyId, programId: program.id, name }).returning({ id: courses.id });
  return course.id;
}

async function insertBatchDirect(academyId: string, branchId: string, courseId: string, name = `Batch ${randomUUID()}`): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId, name, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  return row.id;
}

async function insertStaffProfile(academyId: string, userId: string, fullName = "Test Instructor"): Promise<string> {
  const [profile] = await db.insert(staffProfiles).values({ academyId, userId, fullName, phone: "+1-555-0100" }).returning({ id: staffProfiles.id });
  return profile.id;
}

async function setupAcademy(role: AcademyRole) {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({ academyId, planId, status: "active", endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), createdBy: creatorUserId });
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { academyId, userId, context: { userId, branchIds: [], academyWide: false } as AuthContext };
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  for (const academyId of createdAcademyIds) {
    await db.delete(timetables).where(eq(timetables.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
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

describe("getTimetablePrintData", () => {
  it("with no filters, returns every visible entry grouped into the weekly grid", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "wed", startTime: "09:00", endTime: "11:00" });

    const result = await getTimetablePrintData(context, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.slots).toHaveLength(1); // same time range -> one row
      expect(result.data.slots[0].byDay.mon).toHaveLength(1);
      expect(result.data.slots[0].byDay.wed).toHaveLength(1);
      expect(result.data.scope.branchName).toBeNull(); // unfiltered -> "All Branches" in the view
    }
  });

  it("respects a branch filter and resolves the branch name for the header even with matching entries", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchA = await insertBranchDirect(academyId, "Main Branch");
    const branchB = await insertBranchDirect(academyId, "Second Branch");
    const courseId = await insertProgramAndCourse(academyId);
    const batchA = await insertBatchDirect(academyId, branchA, courseId);
    const batchB = await insertBatchDirect(academyId, branchB, courseId);
    await createTimetableEntry(context, { branchId: branchA, batchId: batchA, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    await createTimetableEntry(context, { branchId: branchB, batchId: batchB, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await getTimetablePrintData(context, { branchId: branchA });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scope.branchName).toBe("Main Branch");
      expect(result.data.slots).toHaveLength(1);
      expect(result.data.slots[0].byDay.mon.every((e) => e.branchId === branchA)).toBe(true);
    }
  });

  it("respects a course filter", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseA = await insertProgramAndCourse(academyId, "Web Development");
    const courseB = await insertProgramAndCourse(academyId, "Graphic Design");
    const batchA = await insertBatchDirect(academyId, branchId, courseA);
    const batchB = await insertBatchDirect(academyId, branchId, courseB);
    await createTimetableEntry(context, { branchId, batchId: batchA, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    await createTimetableEntry(context, { branchId, batchId: batchB, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await getTimetablePrintData(context, { courseId: courseA });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scope.courseName).toBe("Web Development");
      expect(result.data.slots[0].byDay.mon).toHaveLength(1);
      expect(result.data.slots[0].byDay.mon[0].courseId).toBe(courseA);
    }
  });

  it("respects a batch filter", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseId = await insertProgramAndCourse(academyId);
    const batchA = await insertBatchDirect(academyId, branchId, courseId, "Batch 03");
    const batchB = await insertBatchDirect(academyId, branchId, courseId, "Batch 05");
    await createTimetableEntry(context, { branchId, batchId: batchA, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });
    await createTimetableEntry(context, { branchId, batchId: batchB, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await getTimetablePrintData(context, { batchId: batchA });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scope.batchName).toBe("Batch 03");
      expect(result.data.slots[0].byDay.mon).toHaveLength(1);
      expect(result.data.slots[0].byDay.mon[0].batchId).toBe(batchA);
    }
  });

  it("respects an instructor filter", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    const instructorAUserId = await createUser();
    const instructorA = await insertStaffProfile(academyId, instructorAUserId, "Ahmed");
    const instructorBUserId = await createUser();
    const instructorB = await insertStaffProfile(academyId, instructorBUserId, "Fatima");
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", trainerStaffProfileId: instructorA });
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "tue", startTime: "09:00", endTime: "11:00", trainerStaffProfileId: instructorB });

    const result = await getTimetablePrintData(context, { instructorId: instructorA });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scope.instructorName).toBe("Ahmed");
      expect(result.data.slots[0].byDay.mon).toHaveLength(1);
      expect(result.data.slots[0].byDay.tue).toHaveLength(0);
    }
  });

  it("an empty filter result still returns a well-formed academy header with zero slots, never an error", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const otherBranchId = await insertBranchDirect(academyId, "Empty Branch");
    const result = await getTimetablePrintData(context, { branchId: otherBranchId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.slots).toEqual([]);
      expect(result.data.academy.name).toBeTruthy();
      expect(result.data.scope.branchName).toBe("Empty Branch");
    }
  });

  it("tenant isolation — never includes another academy's timetable entries, regardless of filters", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await createTimetableEntry(context, { branchId, batchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const other = await setupAcademy("academy_owner");
    const otherBranchId = await insertBranchDirect(other.academyId);
    const otherCourseId = await insertProgramAndCourse(other.academyId);
    const otherBatchId = await insertBatchDirect(other.academyId, otherBranchId, otherCourseId);
    await createTimetableEntry(other.context, { branchId: otherBranchId, batchId: otherBatchId, dayOfWeek: "mon", startTime: "09:00", endTime: "11:00" });

    const result = await getTimetablePrintData(context, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const allBatchIds = result.data.slots.flatMap((slot) => Object.values(slot.byDay).flat().map((e) => e.batchId));
      expect(allBatchIds).not.toContain(otherBatchId);
    }
  });

  it("is forbidden for roles with no timetable access", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await getTimetablePrintData(context, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
