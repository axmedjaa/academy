import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
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
  examResults,
  exams,
  gradeConfigurations,
  programs,
  staffProfiles,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import * as academicReportsModule from "./academic-reports";
import { getAcademicReports } from "./academic-reports";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `academic-reports-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Academic Reports Test Plan ${randomUUID()}`,
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
      name: `Academic Reports Test Academy ${randomUUID()}`,
      slug: `academic-reports-test-${randomUUID()}`,
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

async function insertProgramAndCourse(academyId: string, courseName = `Course ${randomUUID()}`): Promise<string> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: `Program ${randomUUID()}` })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: courseName })
    .returning({ id: courses.id });
  return course.id;
}

async function insertBatchDirect(
  academyId: string,
  branchId: string,
  courseId: string,
  name = `Batch ${randomUUID()}`,
): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId, name, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
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
      fullName: `Test Student ${randomUUID()}`,
      createdBy: creatorUserId,
    })
    .returning({ id: students.id });
  return row.id;
}

async function insertGradeConfigDirect(academyId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status: "active" })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

async function insertExamDirect(academyId: string, batchId: string): Promise<string> {
  const [row] = await db
    .insert(exams)
    .values({ academyId, batchId, name: `Exam ${randomUUID()}`, maxMarks: "100", status: "completed" })
    .returning({ id: exams.id });
  return row.id;
}

async function insertPublishedResultDirect(
  academyId: string,
  examId: string,
  studentId: string,
  batchId: string,
  gradeConfigurationId: string,
  enteredBy: string,
  passFail: "pass" | "fail",
  gradeBandLabel: string,
  publishedAt: Date = new Date(),
): Promise<void> {
  await db.insert(examResults).values({
    academyId,
    examId,
    studentId,
    batchId,
    gradeConfigurationId,
    enteredBy,
    marksObtained: passFail === "pass" ? "80" : "20",
    passFail,
    gradeBandLabel,
    status: "published",
    publishedAt,
  });
}

async function insertDraftResultDirect(
  academyId: string,
  examId: string,
  studentId: string,
  batchId: string,
  gradeConfigurationId: string,
  enteredBy: string,
): Promise<void> {
  await db.insert(examResults).values({
    academyId,
    examId,
    studentId,
    batchId,
    gradeConfigurationId,
    enteredBy,
    status: "draft",
  });
}

async function insertStaffProfile(academyId: string, userId: string): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  return profile.id;
}

async function assignTrainerToBatchDirect(academyId: string, batchId: string, staffProfileId: string): Promise<void> {
  await db.insert(batchTrainerAssignments).values({ academyId, batchId, staffProfileId, status: "active" });
}

interface Fixture {
  academyId: string;
  branchId: string;
  courseId: string;
  batchId: string;
  gradeConfigId: string;
  creatorUserId: string;
  userId: string;
  context: AuthContext;
}

async function setupAcademy(role: AcademyRole): Promise<Fixture> {
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
  const courseId = await insertProgramAndCourse(academyId);
  const batchId = await insertBatchDirect(academyId, branchId, courseId);
  const gradeConfigId = await insertGradeConfigDirect(academyId, creatorUserId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    branchId,
    courseId,
    batchId,
    gradeConfigId,
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
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    await db.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
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

describe("getAcademicReports — aggregation correctness", () => {
  it("counts only published results, computes pass/fail counts and passRate per batch, and grade distribution", async () => {
    const fixture = await setupAcademy("academy_owner");
    const { academyId, batchId, gradeConfigId, creatorUserId, context } = fixture;
    const examId = await insertExamDirect(academyId, batchId);
    const s1 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);
    const s2 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);
    const s3 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);
    const s4 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);

    await insertPublishedResultDirect(academyId, examId, s1, batchId, gradeConfigId, creatorUserId, "pass", "A");
    await insertPublishedResultDirect(academyId, examId, s2, batchId, gradeConfigId, creatorUserId, "pass", "B");
    await insertPublishedResultDirect(academyId, examId, s3, batchId, gradeConfigId, creatorUserId, "fail", "F");
    // Draft result must never count toward "published" aggregates.
    await insertDraftResultDirect(academyId, examId, s4, batchId, gradeConfigId, creatorUserId);

    const result = await getAcademicReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.resultsPublishedCount).toBe(3);
    expect(result.report.passFailByBatch).toHaveLength(1);
    const batchRow = result.report.passFailByBatch[0];
    expect(batchRow.batchId).toBe(batchId);
    expect(batchRow.passCount).toBe(2);
    expect(batchRow.failCount).toBe(1);
    expect(batchRow.pendingCount).toBe(0);
    expect(batchRow.passRate).toBeCloseTo(2 / 3);

    expect(result.report.gradeDistribution).toEqual(
      expect.arrayContaining([
        { gradeBandLabel: "A", count: 1 },
        { gradeBandLabel: "B", count: 1 },
        { gradeBandLabel: "F", count: 1 },
      ]),
    );
  });

  it("dateFrom/dateTo narrow published results by publishedAt, inclusive", async () => {
    const fixture = await setupAcademy("academy_owner");
    const { academyId, batchId, gradeConfigId, creatorUserId, context } = fixture;
    const examId = await insertExamDirect(academyId, batchId);
    const s1 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);
    const s2 = await insertStudentDirect(academyId, fixture.branchId, creatorUserId);

    await insertPublishedResultDirect(
      academyId, examId, s1, batchId, gradeConfigId, creatorUserId, "pass", "A",
      new Date("2025-06-15T00:00:00Z"),
    );
    await insertPublishedResultDirect(
      academyId, examId, s2, batchId, gradeConfigId, creatorUserId, "pass", "A",
      new Date("2025-12-01T00:00:00Z"),
    );

    const result = await getAcademicReports(context, {
      dateFrom: new Date("2025-06-01T00:00:00Z"),
      dateTo: new Date("2025-06-30T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.resultsPublishedCount).toBe(1);
  });

  it("courseId filter narrows to batches under that course", async () => {
    const fixture = await setupAcademy("academy_owner");
    const { academyId, branchId, gradeConfigId, creatorUserId, context } = fixture;
    const courseA = fixture.courseId;
    const courseB = await insertProgramAndCourse(academyId);
    const batchB = await insertBatchDirect(academyId, branchId, courseB);
    const examA = await insertExamDirect(academyId, fixture.batchId);
    const examB = await insertExamDirect(academyId, batchB);
    const s1 = await insertStudentDirect(academyId, branchId, creatorUserId);
    const s2 = await insertStudentDirect(academyId, branchId, creatorUserId);

    await insertPublishedResultDirect(academyId, examA, s1, fixture.batchId, gradeConfigId, creatorUserId, "pass", "A");
    await insertPublishedResultDirect(academyId, examB, s2, batchB, gradeConfigId, creatorUserId, "pass", "A");

    const result = await getAcademicReports(context, { courseId: courseA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.resultsPublishedCount).toBe(1);
    expect(result.report.passFailByBatch.map((r) => r.batchId)).toEqual([fixture.batchId]);
  });
});

describe("getAcademicReports — tenant isolation", () => {
  it("never includes another academy's exam results", async () => {
    const other = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(other.academyId, other.batchId);
    const s1 = await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);
    await insertPublishedResultDirect(
      other.academyId, examId, s1, other.batchId, other.gradeConfigId, other.creatorUserId, "pass", "A",
    );

    const { context } = await setupAcademy("academy_owner");
    const result = await getAcademicReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.resultsPublishedCount).toBe(0);
    expect(result.report.passFailByBatch).toEqual([]);
  });
});

describe("getAcademicReports — permission gating", () => {
  it("a caller not signed in / not a member gets a 'blocked' error", async () => {
    const result = await getAcademicReports({ userId: randomUUID(), branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", true],
  ])(
    "role %s: allowed = %s (neither ACADEMY_EXAMS_ACTION nor ACADEMY_RESULTS_ACTION grants admissions_officer/finance_officer any level)",
    async (role, allowed) => {
      const { context } = await setupAcademy(role);
      const result = await getAcademicReports(context);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("a Trainer only sees results for batches they're assigned to teach", async () => {
    const fixture = await setupAcademy("trainer");
    const { academyId, branchId, courseId, batchId: assignedBatch, gradeConfigId, creatorUserId, userId, context } =
      fixture;
    const otherBatch = await insertBatchDirect(academyId, branchId, courseId);
    const examAssigned = await insertExamDirect(academyId, assignedBatch);
    const examOther = await insertExamDirect(academyId, otherBatch);
    const s1 = await insertStudentDirect(academyId, branchId, creatorUserId);
    const s2 = await insertStudentDirect(academyId, branchId, creatorUserId);

    await insertPublishedResultDirect(academyId, examAssigned, s1, assignedBatch, gradeConfigId, creatorUserId, "pass", "A");
    await insertPublishedResultDirect(academyId, examOther, s2, otherBatch, gradeConfigId, creatorUserId, "fail", "F");

    const staffProfileId = await insertStaffProfile(academyId, userId);
    await assignTrainerToBatchDirect(academyId, assignedBatch, staffProfileId);

    const result = await getAcademicReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.resultsPublishedCount).toBe(1);
    expect(result.report.passFailByBatch.map((r) => r.batchId)).toEqual([assignedBatch]);
  });

  it("a Trainer with zero assigned batches gets an empty report, not an error", async () => {
    const fixture = await setupAcademy("trainer");
    const examId = await insertExamDirect(fixture.academyId, fixture.batchId);
    const s1 = await insertStudentDirect(fixture.academyId, fixture.branchId, fixture.creatorUserId);
    await insertPublishedResultDirect(
      fixture.academyId, examId, s1, fixture.batchId, fixture.gradeConfigId, fixture.creatorUserId, "pass", "A",
    );

    const result = await getAcademicReports(fixture.context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.resultsPublishedCount).toBe(0);
  });
});

describe("getAcademicReports — module surface", () => {
  it("exports exactly the documented runtime functions (no accidental extra surface)", () => {
    const exported = Object.keys(academicReportsModule).sort();
    expect(exported).toEqual(["academicReportFiltersSchema", "getAcademicReports"].sort());
  });
});
