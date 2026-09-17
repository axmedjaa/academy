import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  approvalRequests,
  auditLogs,
  batchEnrollments,
  batches,
  branches,
  courses,
  examResults,
  exams,
  gradeBands,
  gradeConfigurations,
  programs,
  resultCorrections,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  approveResultCorrection,
  rejectResultCorrection,
  requestResultCorrection,
} from "./result-corrections";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `result-corrections-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Result Corrections Test Plan ${randomUUID()}`,
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
      name: `Result Corrections Test Academy ${randomUUID()}`,
      slug: `result-corrections-test-${randomUUID()}`,
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

async function enrollStudentDirect(academyId: string, batchId: string, studentId: string): Promise<void> {
  await db.insert(batchEnrollments).values({ academyId, batchId, studentId, status: "active" });
}

async function insertGradeConfigDirect(
  academyId: string,
  creatorUserId: string,
  status: "draft" | "pending_approval" | "approved" | "active" | "retired",
): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

async function insertGradeBandsDirect(
  gradeConfigurationId: string,
  bands: { label: string; minMark: number; maxMark: number; isPass: boolean }[],
): Promise<void> {
  if (bands.length === 0) return;
  await db.insert(gradeBands).values(
    bands.map((band) => ({
      gradeConfigurationId,
      label: band.label,
      minMark: String(band.minMark),
      maxMark: String(band.maxMark),
      isPass: band.isPass,
    })),
  );
}

async function insertExamDirect(academyId: string, batchId: string): Promise<string> {
  const [row] = await db
    .insert(exams)
    .values({ academyId, batchId, name: `Exam ${randomUUID()}`, maxMarks: "100", status: "completed" })
    .returning({ id: exams.id });
  return row.id;
}

interface ExamResultOverrides {
  marksObtained?: number | null;
  status?: "draft" | "marks_entered" | "submitted" | "under_review" | "approved" | "rejected" | "published";
  gradeBandLabel?: string | null;
  passFail?: "pending" | "pass" | "fail";
  publishedAt?: Date | null;
}

async function insertExamResultDirect(
  academyId: string,
  examId: string,
  studentId: string,
  batchId: string,
  gradeConfigurationId: string,
  enteredBy: string,
  overrides: ExamResultOverrides = {},
): Promise<string> {
  const [row] = await db
    .insert(examResults)
    .values({
      academyId,
      examId,
      studentId,
      batchId,
      gradeConfigurationId,
      enteredBy,
      marksObtained:
        overrides.marksObtained !== undefined && overrides.marksObtained !== null
          ? String(overrides.marksObtained)
          : overrides.marksObtained === null
            ? null
            : "60",
      status: overrides.status ?? "published",
      gradeBandLabel: overrides.gradeBandLabel ?? null,
      passFail: overrides.passFail ?? "pending",
      publishedAt: overrides.publishedAt ?? new Date(),
    })
    .returning({ id: examResults.id });
  return row.id;
}

interface SetupOptions {
  bands?: { label: string; minMark: number; maxMark: number; isPass: boolean }[];
}

async function setupAcademy(
  role: AcademyRole,
  options: SetupOptions = {},
): Promise<{
  academyId: string;
  userId: string;
  creatorUserId: string;
  branchId: string;
  courseId: string;
  batchId: string;
  studentId: string;
  activeGradeConfigId: string;
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
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
  await enrollStudentDirect(academyId, batchId, studentId);

  const activeGradeConfigId = await insertGradeConfigDirect(academyId, creatorUserId, "active");
  await insertGradeBandsDirect(
    activeGradeConfigId,
    options.bands ?? [
      { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
      { label: "Pass", minMark: 50, maxMark: 100, isPass: true },
    ],
  );

  return {
    academyId,
    userId,
    creatorUserId,
    branchId,
    courseId,
    batchId,
    studentId,
    activeGradeConfigId,
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
    await db.delete(resultCorrections).where(eq(resultCorrections.academyId, academyId));
    await db.delete(approvalRequests).where(eq(approvalRequests.academyId, academyId));
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    const configs = await db
      .select({ id: gradeConfigurations.id })
      .from(gradeConfigurations)
      .where(eq(gradeConfigurations.academyId, academyId));
    for (const config of configs) {
      await db.delete(gradeBands).where(eq(gradeBands.gradeConfigurationId, config.id));
    }
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
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

async function fetchResultRow(resultId: string) {
  const [row] = await db.select().from(examResults).where(eq(examResults.id, resultId)).limit(1);
  return row;
}

async function fetchCorrectionRow(correctionId: string) {
  const [row] = await db.select().from(resultCorrections).where(eq(resultCorrections.id, correctionId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// requestResultCorrection
// ---------------------------------------------------------------------------
describe("requestResultCorrection — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: requestResultCorrection allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const result = await requestResultCorrection(setup.context, resultId, {
      reason: "Transcription error",
      proposedMarksObtained: 65,
    });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("requestResultCorrection — validation and state", () => {
  it("creates a requested result_corrections row and a matching pending approval_requests row", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40, gradeBandLabel: "Fail", passFail: "fail" },
    );

    const result = await requestResultCorrection(setup.context, resultId, {
      reason: "Transcription error, should be 65",
      proposedMarksObtained: 65,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.correction.status).toBe("requested");
    expect(result.correction.originalResultId).toBe(resultId);
    expect(result.correction.proposedMarksObtained).toBe(65);
    expect(result.correction.requestedBy).toBe(setup.userId);

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(pending).toBeTruthy();
    expect(pending.status).toBe("pending");
    expect(pending.entityType).toBe("result");
    expect(pending.requestedBy).toBe(setup.userId);

    // The underlying exam_results row is untouched by the request itself.
    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("published");
    expect(row.marksObtained).toBe("40");
  });

  it("requires a non-empty reason", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const result = await requestResultCorrection(setup.context, resultId, {
      reason: "   ",
      proposedMarksObtained: 65,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it.each<["draft" | "marks_entered" | "submitted" | "under_review" | "approved" | "rejected"]>([
    ["draft"],
    ["marks_entered"],
    ["under_review"],
    ["approved"],
  ])("refuses when the result is %s, not published", async (status) => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status, marksObtained: 40, publishedAt: null },
    );
    const result = await requestResultCorrection(setup.context, resultId, {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("cross-academy / nonexistent result id is rejected as not_found", async () => {
    const setup = await setupAcademy("academy_owner");
    const result = await requestResultCorrection(setup.context, randomUUID(), {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// approveResultCorrection / rejectResultCorrection
// ---------------------------------------------------------------------------
describe("approveResultCorrection/rejectResultCorrection — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: approveResultCorrection allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const requester = await createUser();
    const requesterContext: AuthContext = { userId: requester, branchIds: [], academyWide: false };
    await addMembership(requester, setup.academyId, "manager");

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40, gradeBandLabel: "Fail", passFail: "fail" },
    );
    const requested = await requestResultCorrection(requesterContext, resultId, {
      reason: "Transcription error",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const result = await approveResultCorrection(setup.context, requested.correction.id);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("approveResultCorrection — full lifecycle: request -> approve -> applied", () => {
  it("updates exam_results.marks_obtained/pass_fail/grade_band_label atomically and flips the correction to applied", async () => {
    const setup = await setupAcademy("academy_owner", {
      bands: [
        { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
        { label: "Pass", minMark: 50, maxMark: 100, isPass: true },
      ],
    });
    const manager = await createUser();
    await addMembership(manager, setup.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40, gradeBandLabel: "Fail", passFail: "fail" },
    );

    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "Transcription error, should be 65",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const approved = await approveResultCorrection(managerContext, requested.correction.id);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.correction.status).toBe("applied");
    expect(approved.correction.appliedAt).not.toBeNull();
    expect(approved.result.marksObtained).toBe(65);
    expect(approved.result.gradeBandLabel).toBe("Pass");
    expect(approved.result.passFail).toBe("pass");
    expect(approved.result.status).toBe("published");

    const row = await fetchResultRow(resultId);
    expect(row.marksObtained).toBe("65");
    expect(row.gradeBandLabel).toBe("Pass");
    expect(row.passFail).toBe("pass");
    expect(row.status).toBe("published");

    const correctionRow = await fetchCorrectionRow(requested.correction.id);
    expect(correctionRow.status).toBe("applied");
    expect(correctionRow.decidedBy).toBe(manager);

    const [decidedRequest] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(decidedRequest.status).toBe("approved");
  });

  it("re-evaluates against the result's own snapshotted grade configuration, not whatever is active now", async () => {
    const setup = await setupAcademy("academy_owner", {
      bands: [
        { label: "Fail", minMark: 0, maxMark: 39, isPass: false },
        { label: "Pass", minMark: 40, maxMark: 100, isPass: true },
      ],
    });
    const manager = await createUser();
    await addMembership(manager, setup.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 20, gradeBandLabel: "Fail", passFail: "fail" },
    );

    // A NEW active configuration replaces the old one after publish, with
    // a much stricter pass mark. This must NOT affect the correction.
    await db.update(gradeConfigurations).set({ status: "retired" }).where(eq(gradeConfigurations.id, setup.activeGradeConfigId));
    const newConfigId = await insertGradeConfigDirect(setup.academyId, setup.creatorUserId, "active");
    await insertGradeBandsDirect(newConfigId, [
      { label: "Fail (strict)", minMark: 0, maxMark: 89, isPass: false },
      { label: "Pass (strict)", minMark: 90, maxMark: 100, isPass: true },
    ]);

    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "Transcription error, should be 45",
      proposedMarksObtained: 45,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const approved = await approveResultCorrection(managerContext, requested.correction.id);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    // Under the OLD (snapshotted) config, 45 is "Pass" — under the new
    // strict config it would have been "Fail (strict)".
    expect(approved.result.gradeBandLabel).toBe("Pass");
    expect(approved.result.passFail).toBe("pass");
    expect(approved.result.gradeConfigurationId).toBe(setup.activeGradeConfigId);
  });

  it("the requester cannot approve their own correction request (self-approval block reused)", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const result = await approveResultCorrection(setup.context, requested.correction.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    const row = await fetchResultRow(resultId);
    expect(row.marksObtained).toBe("40");
    const correctionRow = await fetchCorrectionRow(requested.correction.id);
    expect(correctionRow.status).toBe("requested");
  });

  it("refuses to approve a correction that isn't in requested status", async () => {
    const setup = await setupAcademy("academy_owner");
    const manager = await createUser();
    await addMembership(manager, setup.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const first = await approveResultCorrection(managerContext, requested.correction.id);
    expect(first.ok).toBe(true);

    const second = await approveResultCorrection(managerContext, requested.correction.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_state");
  });

  it("cross-academy / nonexistent correction id is rejected as not_found", async () => {
    const setup = await setupAcademy("academy_owner");
    const result = await approveResultCorrection(setup.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("rejectResultCorrection — request -> reject -> exam_results untouched", () => {
  it("leaves exam_results at its original published values and flips the correction to rejected", async () => {
    const setup = await setupAcademy("academy_owner");
    const manager = await createUser();
    await addMembership(manager, setup.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40, gradeBandLabel: "Fail", passFail: "fail" },
    );
    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "Transcription error",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const rejected = await rejectResultCorrection(managerContext, requested.correction.id, "Marks were correct as-is");
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.correction.status).toBe("rejected");

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("published");
    expect(row.marksObtained).toBe("40");
    expect(row.gradeBandLabel).toBe("Fail");
    expect(row.passFail).toBe("fail");

    const [decidedRequest] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(decidedRequest.status).toBe("rejected");
    expect(decidedRequest.reason).toBe("Marks were correct as-is");
  });

  it("requires a non-empty rejection reason", async () => {
    const setup = await setupAcademy("academy_owner");
    const manager = await createUser();
    await addMembership(manager, setup.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const result = await rejectResultCorrection(managerContext, requested.correction.id, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("the requester cannot reject their own correction request", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { status: "published", marksObtained: 40 },
    );
    const requested = await requestResultCorrection(setup.context, resultId, {
      reason: "some reason",
      proposedMarksObtained: 65,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const result = await rejectResultCorrection(setup.context, requested.correction.id, "some reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");
  });
});
