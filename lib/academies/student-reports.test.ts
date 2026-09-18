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
import * as studentReportsModule from "./student-reports";
import { getStudentReports } from "./student-reports";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `student-reports-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Student Reports Test Plan ${randomUUID()}`,
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
      name: `Student Reports Test Academy ${randomUUID()}`,
      slug: `student-reports-test-${randomUUID()}`,
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

async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
  status: "active" | "archived" = "active",
  createdAt?: Date,
): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8)}`,
      fullName: `Test Student ${randomUUID()}`,
      createdBy: creatorUserId,
      status,
      ...(createdAt ? { createdAt } : {}),
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

async function enrollStudentDirect(
  academyId: string,
  batchId: string,
  studentId: string,
  status: "active" | "withdrawn" | "completed" = "active",
  enrolledAt?: Date,
): Promise<void> {
  await db
    .insert(batchEnrollments)
    .values({ academyId, batchId, studentId, status, ...(enrolledAt ? { enrolledAt } : {}) });
}

async function insertStaffProfile(academyId: string, userId: string): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  return profile.id;
}

async function assignBranchToStaff(academyId: string, staffProfileId: string, branchId: string): Promise<void> {
  await db.insert(staffBranchAssignments).values({ academyId, staffProfileId, branchId });
}

async function setupAcademy(
  role: AcademyRole,
): Promise<{
  academyId: string;
  branchId: string;
  creatorUserId: string;
  userId: string;
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
  const branchId = await insertBranchDirect(academyId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    branchId,
    creatorUserId,
    userId,
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
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
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

describe("getStudentReports — aggregation correctness", () => {
  it("counts total students and the active/archived status breakdown correctly", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    await insertStudentDirect(academyId, branchId, creatorUserId, "active");
    await insertStudentDirect(academyId, branchId, creatorUserId, "active");
    await insertStudentDirect(academyId, branchId, creatorUserId, "archived");

    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.totalStudents).toBe(3);
    expect(result.report.statusBreakdown).toEqual(
      expect.arrayContaining([
        { status: "active", count: 2 },
        { status: "archived", count: 1 },
      ]),
    );
  });

  it("computes branch distribution across multiple branches", async () => {
    const { academyId, branchId: branchA, creatorUserId, context } = await setupAcademy("academy_owner");
    const branchB = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchA, creatorUserId);
    await insertStudentDirect(academyId, branchA, creatorUserId);
    await insertStudentDirect(academyId, branchB, creatorUserId);

    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byBranch = new Map(result.report.branchDistribution.map((row) => [row.branchId, row.count]));
    expect(byBranch.get(branchA)).toBe(2);
    expect(byBranch.get(branchB)).toBe(1);
  });

  it("builds the enrollment trend grouped by month and the enrollment status breakdown", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    const studentA = await insertStudentDirect(academyId, branchId, creatorUserId);
    const studentB = await insertStudentDirect(academyId, branchId, creatorUserId);
    const studentC = await insertStudentDirect(academyId, branchId, creatorUserId);

    await enrollStudentDirect(academyId, batchId, studentA, "active", new Date("2025-06-10T00:00:00Z"));
    await enrollStudentDirect(academyId, batchId, studentB, "active", new Date("2025-06-20T00:00:00Z"));
    await enrollStudentDirect(academyId, batchId, studentC, "withdrawn", new Date("2025-07-01T00:00:00Z"));

    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.enrollmentTrend).toEqual(
      expect.arrayContaining([
        { period: "2025-06", count: 2 },
        { period: "2025-07", count: 1 },
      ]),
    );
    expect(result.report.enrollmentStatusBreakdown).toEqual(
      expect.arrayContaining([
        { status: "active", count: 2 },
        { status: "withdrawn", count: 1 },
        { status: "completed", count: 0 },
      ]),
    );
  });

  it("dateFrom/dateTo narrow the student status breakdown to registrations in range, inclusive", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    await insertStudentDirect(academyId, branchId, creatorUserId, "active", new Date("2025-03-01T00:00:00Z"));
    await insertStudentDirect(academyId, branchId, creatorUserId, "active", new Date("2025-06-15T00:00:00Z"));
    await insertStudentDirect(academyId, branchId, creatorUserId, "active", new Date("2025-09-01T00:00:00Z"));

    const result = await getStudentReports(context, {
      dateFrom: new Date("2025-06-01T00:00:00Z"),
      dateTo: new Date("2025-06-30T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.totalStudents).toBe(1);
  });
});

describe("getStudentReports — tenant isolation", () => {
  it("never includes another academy's students or enrollments", async () => {
    const other = await setupAcademy("academy_owner");
    await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);
    await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId, "archived");

    const { context } = await setupAcademy("academy_owner");
    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.totalStudents).toBe(0);
    expect(result.report.branchDistribution).toEqual([]);
  });

  it("a branchId belonging to a different academy yields an empty (not leaked) report", async () => {
    const other = await setupAcademy("academy_owner");
    await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);

    const { context } = await setupAcademy("academy_owner");
    const result = await getStudentReports(context, { branchId: other.branchId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.totalStudents).toBe(0);
  });
});

describe("getStudentReports — permission gating", () => {
  it("a caller not signed in / not a member gets a 'blocked' error", async () => {
    const result = await getStudentReports({ userId: randomUUID(), branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });

  // ACADEMY_STUDENTS_ACTION (lib/auth/academy-permissions.ts) grants every
  // one of the six academy roles at least "view" — owner/admin "full",
  // manager/admissions_officer "manage", finance_officer/trainer "view" —
  // so unlike a permission row with a genuine "none" entry, there is no
  // academy role this report can reject outright once membership exists.
  // This positively asserts that reuse (every role reaches the report at
  // all) rather than a "forbidden role" case, which this specific
  // permission row has none of.
  it.each<AcademyRole>([
    "academy_owner",
    "academy_admin",
    "manager",
    "admissions_officer",
    "finance_officer",
    "trainer",
  ])("role %s is never forbidden outright (ACADEMY_STUDENTS_ACTION has no 'none' entry for any role)", async (role) => {
    const { context } = await setupAcademy(role);
    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
  });

  it("a branch-limited role (admissions_officer) only sees students in their assigned branch", async () => {
    const { academyId, branchId: branchA, creatorUserId, userId, context } = await setupAcademy("admissions_officer");
    const branchB = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchA, creatorUserId);
    await insertStudentDirect(academyId, branchB, creatorUserId);

    const staffProfileId = await insertStaffProfile(academyId, userId);
    await assignBranchToStaff(academyId, staffProfileId, branchA);

    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.totalStudents).toBe(1);
    expect(result.report.branchDistribution).toEqual([
      { branchId: branchA, branchName: expect.any(String), count: 1 },
    ]);
  });

  it("a branch-limited role with zero assigned branches gets an empty report, not an error", async () => {
    const { academyId, branchId, creatorUserId, context } = await setupAcademy("trainer");
    await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await getStudentReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.totalStudents).toBe(0);
  });
});

describe("getStudentReports — module surface", () => {
  it("exports exactly the documented runtime functions (no accidental extra surface)", () => {
    const exported = Object.keys(studentReportsModule).sort();
    expect(exported).toEqual(["getAssignedBranchIds", "getStudentReports", "studentReportFiltersSchema"].sort());
  });
});
