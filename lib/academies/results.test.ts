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
  batchTrainerAssignments,
  batches,
  branches,
  courses,
  examResults,
  exams,
  gradeBands,
  gradeConfigurations,
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
  approveResult,
  evaluateGradeBand,
  getResult,
  listResults,
  publishResults,
  rejectResult,
  submitResults,
  type ResultRecord,
} from "./results";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `results-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Results Test Plan ${randomUUID()}`,
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
      name: `Results Test Academy ${randomUUID()}`,
      slug: `results-test-${randomUUID()}`,
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

async function insertExamDirect(
  academyId: string,
  batchId: string,
  status: "scheduled" | "marks_entry" | "completed" | "archived" = "marks_entry",
): Promise<string> {
  const [row] = await db
    .insert(exams)
    .values({ academyId, batchId, name: `Exam ${randomUUID()}`, maxMarks: "100", status })
    .returning({ id: exams.id });
  return row.id;
}

interface ExamResultOverrides {
  marksObtained?: number | null;
  status?: "draft" | "marks_entered" | "submitted" | "under_review" | "approved" | "rejected" | "published";
  gradeBandLabel?: string | null;
  passFail?: "pending" | "pass" | "fail";
  submittedAt?: Date | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
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
      marksObtained: overrides.marksObtained !== undefined && overrides.marksObtained !== null
        ? String(overrides.marksObtained)
        : overrides.marksObtained === null
          ? null
          : "70",
      status: overrides.status ?? "draft",
      gradeBandLabel: overrides.gradeBandLabel ?? null,
      passFail: overrides.passFail ?? "pending",
      submittedAt: overrides.submittedAt ?? null,
      approvedBy: overrides.approvedBy ?? null,
      approvedAt: overrides.approvedAt ?? null,
      publishedAt: overrides.publishedAt ?? null,
    })
    .returning({ id: examResults.id });
  return row.id;
}

async function insertApprovalRequestDirect(
  academyId: string,
  entityId: string,
  requestedBy: string,
  status: "pending" | "approved" | "rejected" = "pending",
): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({ academyId, entityType: "result", entityId, requestedBy, status })
    .returning({ id: approvalRequests.id });
  return row.id;
}

interface SetupOptions {
  withActiveGradeConfig?: boolean;
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
  activeGradeConfigId: string | null;
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

  let activeGradeConfigId: string | null = null;
  if (options.withActiveGradeConfig !== false) {
    activeGradeConfigId = await insertGradeConfigDirect(academyId, creatorUserId, "active");
    await insertGradeBandsDirect(
      activeGradeConfigId,
      options.bands ?? [
        { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
        { label: "Pass", minMark: 50, maxMark: 100, isPass: true },
      ],
    );
  }

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

async function fetchResultRow(resultId: string) {
  const [row] = await db.select().from(examResults).where(eq(examResults.id, resultId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// evaluateGradeBand — pure function, boundary correctness.
// ---------------------------------------------------------------------------
describe("evaluateGradeBand", () => {
  const bands = [
    { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
    { label: "Pass", minMark: 50, maxMark: 79, isPass: true },
    { label: "Distinction", minMark: 80, maxMark: 100, isPass: true },
  ];

  it("maps a mark in the middle of a band correctly", () => {
    expect(evaluateGradeBand(65, bands)).toEqual(bands[1]);
  });

  it("is inclusive on the lower boundary", () => {
    expect(evaluateGradeBand(50, bands)).toEqual(bands[1]);
    expect(evaluateGradeBand(80, bands)).toEqual(bands[2]);
  });

  it("is inclusive on the upper boundary", () => {
    expect(evaluateGradeBand(49, bands)).toEqual(bands[0]);
    expect(evaluateGradeBand(79, bands)).toEqual(bands[1]);
  });

  it("returns null when no band covers the mark", () => {
    expect(evaluateGradeBand(150, bands)).toBeNull();
    expect(evaluateGradeBand(-5, bands)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitResults — permission matrix + state machine.
// ---------------------------------------------------------------------------
describe("submitResults — permission matrix (same gate as enterMarks)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
  ])("role %s: submitResults allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId,
      examId,
      setup.studentId,
      setup.batchId,
      setup.activeGradeConfigId!,
      setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("allows a trainer to submit results on their assigned batch", async () => {
    const setup = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(setup.academyId, setup.userId);
    await assignTrainerToBatchDirect(setup.academyId, setup.batchId, staffProfileId);
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId,
      examId,
      setup.studentId,
      setup.batchId,
      setup.activeGradeConfigId!,
      setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(true);
  });

  it("refuses a trainer submitting results on a batch they are NOT assigned to (IDOR-safe not_found)", async () => {
    const setup = await setupAcademy("trainer");
    // No batch_trainer_assignments row created for this trainer.
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId,
      examId,
      setup.studentId,
      setup.batchId,
      setup.activeGradeConfigId!,
      setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("submitResults — state machine", () => {
  it("Marks Entered -> Under Review, stamps submitted_at, and opens a pending approval_requests row", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId,
      examId,
      setup.studentId,
      setup.batchId,
      setup.activeGradeConfigId!,
      setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );

    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("under_review");
    expect(result.results[0].submittedAt).not.toBeNull();

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("under_review");

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(pending).toBeTruthy();
    expect(pending.status).toBe("pending");
    expect(pending.entityType).toBe("result");
    expect(pending.requestedBy).toBe(setup.userId);
  });

  it("refuses to submit a result that is still draft (no marks entered)", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId,
      examId,
      setup.studentId,
      setup.batchId,
      setup.activeGradeConfigId!,
      setup.creatorUserId,
      { status: "draft", marksObtained: null },
    );
    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("submits only a given studentIds subset, leaving other results untouched", async () => {
    const setup = await setupAcademy("academy_owner");
    const student2 = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    await enrollStudentDirect(setup.academyId, setup.batchId, student2);
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const result1 = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result2 = await insertExamResultDirect(
      setup.academyId, examId, student2, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 60 },
    );

    const result = await submitResults(setup.context, examId, { studentIds: [setup.studentId] });
    expect(result.ok).toBe(true);

    const row1 = await fetchResultRow(result1);
    const row2 = await fetchResultRow(result2);
    expect(row1.status).toBe("under_review");
    expect(row2.status).toBe("marks_entered");
  });

  it("cross-academy exam id is rejected as not_found (tenant isolation)", async () => {
    const setup = await setupAcademy("academy_owner");
    const result = await submitResults(setup.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// approveResult / rejectResult — permission matrix + state machine.
// ---------------------------------------------------------------------------
describe("approveResult/rejectResult — permission matrix (new academy.results row)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: approveResult allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const otherUser = await createUser();
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, otherUser);

    const result = await approveResult(setup.context, resultId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: rejectResult allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const otherUser = await createUser();
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, otherUser);

    const result = await rejectResult(setup.context, resultId, "Marks look wrong");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("approveResult — state machine", () => {
  it("Under Review -> Approved, stamps approved_by/approved_at", async () => {
    const setup = await setupAcademy("academy_owner");
    const submitter = await createUser();
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, submitter);

    const result = await approveResult(setup.context, resultId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("approved");
    expect(result.result.approvedBy).toBe(setup.userId);
    expect(result.result.approvedAt).not.toBeNull();

    const [decided] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe(setup.userId);
  });

  it("the submitter cannot approve their own submission (self-approval block)", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    // The approval request was requested by the owner themselves.
    await insertApprovalRequestDirect(setup.academyId, resultId, setup.userId);

    const result = await approveResult(setup.context, resultId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("under_review");
  });

  it("refuses to approve a result not currently under_review", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result = await approveResult(setup.context, resultId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("cross-academy / nonexistent result id is rejected as not_found", async () => {
    const setup = await setupAcademy("academy_owner");
    const result = await approveResult(setup.context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("rejectResult — state machine", () => {
  it("Under Review -> Draft (not the enum's literal 'rejected'), clears submitted_at, keeps marks_obtained, requires a reason", async () => {
    const setup = await setupAcademy("academy_owner");
    const submitter = await createUser();
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, submitter);

    const result = await rejectResult(setup.context, resultId, "Please recheck the marks");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("draft");
    expect(result.result.submittedAt).toBeNull();
    expect(result.result.marksObtained).toBe(70);

    const [decided] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, resultId));
    expect(decided.status).toBe("rejected");
    expect(decided.reason).toBe("Please recheck the marks");
  });

  it("requires a non-empty reason", async () => {
    const setup = await setupAcademy("academy_owner");
    const submitter = await createUser();
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, submitter);

    const result = await rejectResult(setup.context, resultId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("under_review");
  });

  it("the requester cannot reject their own submission (self-approval block reused)", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    await insertApprovalRequestDirect(setup.academyId, resultId, setup.userId);

    const result = await rejectResult(setup.context, resultId, "some reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");
  });

  it("refuses to reject a result not currently under_review", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const result = await rejectResult(setup.context, resultId, "some reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });
});

// ---------------------------------------------------------------------------
// publishResults — grade evaluation + state machine.
// ---------------------------------------------------------------------------
describe("publishResults — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: publishResults allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "approved", marksObtained: 70, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );
    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("publishResults — grade evaluation correctness", () => {
  it("evaluates marks against the active configuration's bands and snapshots grade_configuration_id/grade_band_label/pass_fail", async () => {
    const setup = await setupAcademy("academy_owner", {
      bands: [
        { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
        { label: "Pass", minMark: 50, maxMark: 79, isPass: true },
        { label: "Distinction", minMark: 80, maxMark: 100, isPass: true },
      ],
    });
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "approved", marksObtained: 85, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );

    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0].status).toBe("published");
    expect(result.results[0].gradeBandLabel).toBe("Distinction");
    expect(result.results[0].passFail).toBe("pass");
    expect(result.results[0].gradeConfigurationId).toBe(setup.activeGradeConfigId);
    expect(result.results[0].publishedAt).not.toBeNull();

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("published");
  });

  it("correctly evaluates marks at exact band boundaries", async () => {
    const setup = await setupAcademy("academy_owner", {
      bands: [
        { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
        { label: "Pass", minMark: 50, maxMark: 100, isPass: true },
      ],
    });
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultIdFail = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "approved", marksObtained: 49, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );

    const student2 = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    await enrollStudentDirect(setup.academyId, setup.batchId, student2);
    const resultIdPass = await insertExamResultDirect(
      setup.academyId, examId, student2, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "approved", marksObtained: 50, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );

    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(true);

    const failRow = await fetchResultRow(resultIdFail);
    const passRow = await fetchResultRow(resultIdPass);
    expect(failRow.gradeBandLabel).toBe("Fail");
    expect(failRow.passFail).toBe("fail");
    expect(passRow.gradeBandLabel).toBe("Pass");
    expect(passRow.passFail).toBe("pass");
  });

  it("refuses to publish when the academy has no active grade configuration", async () => {
    const setup = await setupAcademy("academy_owner", { withActiveGradeConfig: false });
    // Need a valid (non-active) grade_configuration_id to satisfy the
    // NOT NULL column on exam_results while leaving the academy without
    // an active one.
    const draftConfigId = await insertGradeConfigDirect(setup.academyId, setup.creatorUserId, "draft");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, draftConfigId, setup.creatorUserId,
      { status: "approved", marksObtained: 70, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );

    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/active grade configuration/i);
    }
  });

  it("refuses to publish when marks fall outside every grade band, leaving the row unpublished", async () => {
    const setup = await setupAcademy("academy_owner", {
      bands: [{ label: "Pass", minMark: 50, maxMark: 90, isPass: true }],
    });
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "approved", marksObtained: 95, approvedBy: setup.creatorUserId, approvedAt: new Date() },
    );

    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const row = await fetchResultRow(resultId);
    expect(row.status).toBe("approved");
  });

  it("refuses to publish a result that is not approved", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "under_review", marksObtained: 70, submittedAt: new Date() },
    );
    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });
});

// ---------------------------------------------------------------------------
// Immutability — PLAN.md-required test: once Published, no code path in
// this file may modify marks_obtained/grade_configuration_id/
// grade_band_label/pass_fail.
// ---------------------------------------------------------------------------
describe("immutability of a Published result", () => {
  async function setupPublishedResult() {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      {
        status: "published",
        marksObtained: 65,
        gradeBandLabel: "Pass",
        passFail: "pass",
        submittedAt: new Date(),
        approvedBy: setup.creatorUserId,
        approvedAt: new Date(),
        publishedAt: new Date(),
      },
    );
    return { setup, examId, resultId };
  }

  function assertUnchanged(before: Awaited<ReturnType<typeof fetchResultRow>>, after: Awaited<ReturnType<typeof fetchResultRow>>) {
    expect(after.marksObtained).toBe(before.marksObtained);
    expect(after.gradeConfigurationId).toBe(before.gradeConfigurationId);
    expect(after.gradeBandLabel).toBe(before.gradeBandLabel);
    expect(after.passFail).toBe(before.passFail);
    expect(after.status).toBe("published");
  }

  it("submitResults refuses on a published result and leaves it unchanged", async () => {
    const { setup, examId, resultId } = await setupPublishedResult();
    const before = await fetchResultRow(resultId);
    const result = await submitResults(setup.context, examId);
    expect(result.ok).toBe(false);
    const after = await fetchResultRow(resultId);
    assertUnchanged(before, after);
  });

  it("approveResult refuses on a published result and leaves it unchanged", async () => {
    const { setup, resultId } = await setupPublishedResult();
    const before = await fetchResultRow(resultId);
    const result = await approveResult(setup.context, resultId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
    const after = await fetchResultRow(resultId);
    assertUnchanged(before, after);
  });

  it("rejectResult refuses on a published result and leaves it unchanged", async () => {
    const { setup, resultId } = await setupPublishedResult();
    const before = await fetchResultRow(resultId);
    const result = await rejectResult(setup.context, resultId, "trying to reopen a published result");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
    const after = await fetchResultRow(resultId);
    assertUnchanged(before, after);
  });

  it("publishResults refuses to re-publish an already-published result and leaves it unchanged", async () => {
    const { setup, examId, resultId } = await setupPublishedResult();
    const before = await fetchResultRow(resultId);
    const result = await publishResults(setup.context, examId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
    const after = await fetchResultRow(resultId);
    assertUnchanged(before, after);
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration — the full lifecycle wired together.
// ---------------------------------------------------------------------------
describe("full lifecycle integration", () => {
  it("marks_entered -> under_review -> approved -> published, driven entirely through this module's own transitions", async () => {
    const owner = await setupAcademy("academy_owner");
    const manager = await createUser();
    await addMembership(manager, owner.academyId, "manager");
    const managerContext: AuthContext = { userId: manager, branchIds: [], academyWide: false };

    const examId = await insertExamDirect(owner.academyId, owner.batchId);
    const resultId = await insertExamResultDirect(
      owner.academyId, examId, owner.studentId, owner.batchId, owner.activeGradeConfigId!, owner.creatorUserId,
      { status: "marks_entered", marksObtained: 88 },
    );

    const submitted = await submitResults(owner.context, examId);
    expect(submitted.ok).toBe(true);

    // Owner submitted it, so Owner cannot approve their own submission —
    // a different Manager must.
    const selfApprove = await approveResult(owner.context, resultId);
    expect(selfApprove.ok).toBe(false);
    if (!selfApprove.ok) expect(selfApprove.error.code).toBe("self_approval");

    const approved = await approveResult(managerContext, resultId);
    expect(approved.ok).toBe(true);

    const published = await publishResults(managerContext, examId);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.results[0].status).toBe("published");
    expect(published.results[0].passFail).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// listResults / getResult — read helpers.
// ---------------------------------------------------------------------------
describe("listResults / getResult", () => {
  it("getResult reports isOwnSubmission for the current actor", async () => {
    const setup = await setupAcademy("academy_owner");
    const examId = await insertExamDirect(setup.academyId, setup.batchId);
    const resultId = await insertExamResultDirect(
      setup.academyId, examId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    await submitResults(setup.context, examId);

    const fetched = await getResult(setup.context, resultId);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.isOwnSubmission).toBe(true);
  });

  it("listResults scopes a trainer to only their assigned batches", async () => {
    const setup = await setupAcademy("trainer");
    // Second batch this trainer is NOT assigned to.
    const otherBatchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const otherStudent = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    await enrollStudentDirect(setup.academyId, otherBatchId, otherStudent);

    const staffProfileId = await insertStaffProfile(setup.academyId, setup.userId);
    await assignTrainerToBatchDirect(setup.academyId, setup.batchId, staffProfileId);

    const ownExamId = await insertExamDirect(setup.academyId, setup.batchId);
    await insertExamResultDirect(
      setup.academyId, ownExamId, setup.studentId, setup.batchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 70 },
    );
    const otherExamId = await insertExamDirect(setup.academyId, otherBatchId);
    await insertExamResultDirect(
      setup.academyId, otherExamId, otherStudent, otherBatchId, setup.activeGradeConfigId!, setup.creatorUserId,
      { status: "marks_entered", marksObtained: 60 },
    );

    const result = await listResults(setup.context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].batchId).toBe(setup.batchId);
  });
});

// Re-exported type used purely so the ResultRecord shape stays exercised by
// the TypeScript compiler across this test file (no behavior asserted here
// beyond what the tests above already cover).
type _AssertResultRecordShape = ResultRecord;
void (0 as unknown as _AssertResultRecordShape);
