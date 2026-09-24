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
  examResults,
  exams,
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
  archiveExam,
  createExam,
  deleteExam,
  enterMarks,
  getExam,
  getExamDeletionEligibility,
  listExamResults,
  listExams,
  restoreExam,
} from "./exams";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `exams-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Exams Test Plan ${randomUUID()}`,
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
      name: `Exams Test Academy ${randomUUID()}`,
      slug: `exams-test-${randomUUID()}`,
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

interface SetupOptions {
  withActiveGradeConfig?: boolean;
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

  const activeGradeConfigId =
    options.withActiveGradeConfig === false
      ? null
      : await insertGradeConfigDirect(academyId, creatorUserId, "active");

  return {
    academyId,
    userId,
    creatorUserId,
    branchId,
    courseId,
    batchId,
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
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
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

describe("createExam — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: createExam allowed = %s", async (role, allowed) => {
    const { context, batchId } = await setupAcademy(role);
    const result = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("createExam — active grade_configuration precondition", () => {
  it("refuses to create an exam when the academy has no active grade configuration", async () => {
    const { context, batchId } = await setupAcademy("academy_owner", { withActiveGradeConfig: false });
    const result = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/active grade configuration/i);
    }
  });

  it("rejects a batch belonging to another academy with 'not_found' (cross-academy IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const { context } = await setupAcademy("academy_owner");
    const result = await createExam(context, { batchId: other.batchId, name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("createExam — implicitly creates Draft exam_results rows", () => {
  it("creates one Draft exam_results row per actively-enrolled student, stamped with the active grade configuration", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, activeGradeConfigId } =
      await setupAcademy("academy_owner");
    const studentId1 = await insertStudentDirect(academyId, branchId, creatorUserId);
    const studentId2 = await insertStudentDirect(academyId, branchId, creatorUserId);
    const unenrolledStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId1);
    await enrollStudentDirect(academyId, batchId, studentId2);

    const result = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resultCount).toBe(2);

    const rows = await db.select().from(examResults).where(eq(examResults.examId, result.exam.id));
    expect(rows.length).toBe(2);
    const studentIds = rows.map((row) => row.studentId);
    expect(studentIds).toContain(studentId1);
    expect(studentIds).toContain(studentId2);
    expect(studentIds).not.toContain(unenrolledStudentId);
    for (const row of rows) {
      expect(row.status).toBe("draft");
      expect(row.passFail).toBe("pending");
      expect(row.gradeBandLabel).toBeNull();
      expect(row.marksObtained).toBeNull();
      expect(row.gradeConfigurationId).toBe(activeGradeConfigId);
    }
  });

  it("writes an audit row on successful creation", async () => {
    const { context, academyId, userId, batchId } = await setupAcademy("academy_owner");
    const result = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, result.exam.id));
    expect(audit?.action).toBe("createExam");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });
});

describe("enterMarks — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
  ])("role %s: enterMarks allowed = %s", async (role, allowed) => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy(role);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    // The exam must be created by a role that can (owner/admin/manager) —
    // a fresh owner membership, independent of the role under test.
    const ownerContext: AuthContext = { userId: await createUser(), branchIds: [], academyWide: false };
    await addMembership(ownerContext.userId, academyId, "academy_owner");
    const exam = await createExam(ownerContext, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 80 }]);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('enter_marks') can enter marks for an exam on their own assigned batch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(academyId, userId);
    await assignTrainerToBatchDirect(academyId, batchId, staffProfileId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);

    const ownerContext: AuthContext = { userId: await createUser(), branchIds: [], academyWide: false };
    await addMembership(ownerContext.userId, academyId, "academy_owner");
    const exam = await createExam(ownerContext, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 80 }]);
    expect(result.ok).toBe(true);
  });

  it("trainer cannot enter marks for an exam on a batch they are not assigned to (IDOR)", async () => {
    const { academyId, context, branchId, batchId, creatorUserId } = await setupAcademy("trainer");
    // Deliberately no batch_trainer_assignments row for this trainer.
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);

    const ownerContext: AuthContext = { userId: await createUser(), branchIds: [], academyWide: false };
    await addMembership(ownerContext.userId, academyId, "academy_owner");
    const exam = await createExam(ownerContext, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 80 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("trainer cannot enter marks by guessing an exam id on another academy's batch (IDOR)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherStudentId = await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);
    await enrollStudentDirect(other.academyId, other.batchId, otherStudentId);
    const otherExam = await createExam(other.context, { batchId: other.batchId, name: "Midterm", maxMarks: 100 });
    expect(otherExam.ok).toBe(true);
    if (!otherExam.ok) return;

    const trainer = await setupAcademy("trainer");
    const staffProfileId = await insertStaffProfile(trainer.academyId, trainer.userId);
    await assignTrainerToBatchDirect(trainer.academyId, trainer.batchId, staffProfileId);

    const result = await enterMarks(trainer.context, otherExam.exam.id, [
      { studentId: otherStudentId, marksObtained: 80 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enterMarks — marks_obtained vs max_marks sanity check", () => {
  it("refuses marksObtained greater than the exam's max_marks", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 50 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 75 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/max_marks/);
    }
  });

  it("rejects a negative marksObtained at the schema layer", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 50 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: -5 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("enterMarks — (exam_id, student_id) uniqueness: update-in-place", () => {
  it("re-entering marks for the same student updates the existing row rather than creating a second one", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const first = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 60 }]);
    expect(first.ok).toBe(true);
    const second = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 90 }]);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.results[0].marksObtained).toBe(90);
      expect(second.results[0].status).toBe("marks_entered");
    }

    const rows = await db
      .select()
      .from(examResults)
      .where(eq(examResults.examId, exam.exam.id));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].marksObtained)).toBe(90);
  });

  it("bumps exams.status from scheduled to marks_entry on first marks entry", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;
    expect(exam.exam.status).toBe("scheduled");

    const entered = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 60 }]);
    expect(entered.ok).toBe(true);

    const updatedExam = await getExam(context, exam.exam.id);
    expect(updatedExam.ok).toBe(true);
    if (updatedExam.ok) expect(updatedExam.exam.status).toBe("marks_entry");
  });

  it("refuses to enter marks once a result has moved past marks_entered", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    // Bypass this item's scope (submitResults is Item 49) to force the
    // row into a later status directly, exercising enterMarks' own guard.
    await db
      .update(examResults)
      .set({ status: "submitted" })
      .where(eq(examResults.examId, exam.exam.id));

    const result = await enterMarks(context, exam.exam.id, [{ studentId, marksObtained: 70 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });
});

describe("enterMarks — late-enrollment edge case + active grade_configuration precondition", () => {
  it("inserts a fresh row for a student enrolled after createExam already ran", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, activeGradeConfigId } =
      await setupAcademy("academy_owner");
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;
    expect(exam.resultCount).toBe(0);

    const lateStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, lateStudentId);

    const result = await enterMarks(context, exam.exam.id, [{ studentId: lateStudentId, marksObtained: 55 }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].status).toBe("marks_entered");
      expect(result.results[0].gradeConfigurationId).toBe(activeGradeConfigId);
    }
  });

  it("refuses the late-enrollment insert when the academy no longer has an active grade configuration", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, activeGradeConfigId } =
      await setupAcademy("academy_owner");
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    // Retire the only active configuration, leaving the academy with none.
    await db
      .update(gradeConfigurations)
      .set({ status: "retired" })
      .where(eq(gradeConfigurations.id, activeGradeConfigId!));

    const lateStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, lateStudentId);

    const result = await enterMarks(context, exam.exam.id, [{ studentId: lateStudentId, marksObtained: 55 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/active grade configuration/i);
    }
  });

  it("refuses to enter marks for a student not actively enrolled in the exam's batch", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const exam = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;

    const unenrolledStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const result = await enterMarks(context, exam.exam.id, [
      { studentId: unenrolledStudentId, marksObtained: 55 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("cross-academy tenant isolation", () => {
  it("getExam/listExamResults return 'not_found' for an exam belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherExam = await createExam(other.context, { batchId: other.batchId, name: "Midterm", maxMarks: 100 });
    expect(otherExam.ok).toBe(true);
    if (!otherExam.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const getResult = await getExam(context, otherExam.exam.id);
    expect(getResult.ok).toBe(false);
    if (!getResult.ok) expect(getResult.error.code).toBe("not_found");

    const rosterResult = await listExamResults(context, otherExam.exam.id);
    expect(rosterResult.ok).toBe(false);
    if (!rosterResult.ok) expect(rosterResult.error.code).toBe("not_found");
  });

  it("listExams never returns another academy's exams", async () => {
    const other = await setupAcademy("academy_owner");
    await createExam(other.context, { batchId: other.batchId, name: "Other Academy Exam", maxMarks: 100 });

    const { context } = await setupAcademy("academy_owner");
    const result = await listExams(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exams.every((exam) => exam.academyId !== other.academyId)).toBe(true);
    }
  });
});

describe("FK integrity", () => {
  it("createExam with a nonexistent batchId returns not_found", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await createExam(context, { batchId: randomUUID(), name: "Midterm", maxMarks: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("enterMarks with a nonexistent examId returns not_found", async () => {
    const { context, academyId, branchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const result = await enterMarks(context, randomUUID(), [{ studentId, marksObtained: 50 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("archiveExam / restoreExam", () => {
  it("archives then restores an exam, round-tripping status without touching exam_results", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const created = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const archived = await archiveExam(context, created.exam.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.exam.status).toBe("archived");

    const restored = await restoreExam(context, created.exam.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.exam.status).toBe("scheduled");

    const roster = await listExamResults(context, created.exam.id);
    expect(roster.ok).toBe(true);
    if (roster.ok) expect(roster.results).toHaveLength(1);
  });

  it("forbids a Trainer from archiving an exam (Trainer may enter marks, not manage exams)", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const created = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const trainerUserId = await createUser();
    await addMembership(trainerUserId, academyId, "trainer");
    const trainerContext: AuthContext = { userId: trainerUserId, branchIds: [], academyWide: false };

    const result = await archiveExam(trainerContext, created.exam.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never archives another academy's exam (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherExam = await createExam(other.context, { batchId: other.batchId, name: "Other", maxMarks: 100 });
    expect(otherExam.ok).toBe(true);
    if (!otherExam.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const result = await archiveExam(context, otherExam.exam.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("getExamDeletionEligibility / deleteExam", () => {
  it("an exam with zero exam_results (no students were enrolled when it was created) is eligible for permanent deletion", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const created = await createExam(context, { batchId, name: "Unused Exam", maxMarks: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.resultCount).toBe(0);

    const eligibility = await getExamDeletionEligibility(context, created.exam.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.hasResults).toBe(false);
    }

    const deleted = await deleteExam(context, created.exam.id);
    expect(deleted.ok).toBe(true);

    const afterDelete = await getExam(context, created.exam.id);
    expect(afterDelete.ok).toBe(false);
    if (!afterDelete.ok) expect(afterDelete.error.code).toBe("not_found");
  });

  it("an exam with exam_results (a student was enrolled when it was created) is blocked from permanent deletion, and nothing is deleted", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    await enrollStudentDirect(academyId, batchId, studentId);
    const created = await createExam(context, { batchId, name: "Midterm", maxMarks: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.resultCount).toBe(1);

    const eligibility = await getExamDeletionEligibility(context, created.exam.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.hasResults).toBe(true);
    }

    const deleted = await deleteExam(context, created.exam.id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    // Nothing was silently deleted to force the delete through.
    const stillThere = await getExam(context, created.exam.id);
    expect(stillThere.ok).toBe(true);
    const rosterStillThere = await listExamResults(context, created.exam.id);
    expect(rosterStillThere.ok).toBe(true);
    if (rosterStillThere.ok) expect(rosterStillThere.results).toHaveLength(1);
  });

  it("forbids a Trainer from deleting an exam even when it is otherwise eligible", async () => {
    const { context, academyId, batchId } = await setupAcademy("academy_owner");
    const created = await createExam(context, { batchId, name: "Unused Exam", maxMarks: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const trainerUserId = await createUser();
    await addMembership(trainerUserId, academyId, "trainer");
    const trainerContext: AuthContext = { userId: trainerUserId, branchIds: [], academyWide: false };

    const result = await deleteExam(trainerContext, created.exam.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");

    const stillThere = await getExam(context, created.exam.id);
    expect(stillThere.ok).toBe(true);
  });

  it("never deletes another academy's exam (tenant isolation), and the eligibility preview agrees", async () => {
    const other = await setupAcademy("academy_owner");
    const otherExam = await createExam(other.context, { batchId: other.batchId, name: "Other", maxMarks: 100 });
    expect(otherExam.ok).toBe(true);
    if (!otherExam.ok) return;

    const { context } = await setupAcademy("academy_owner");

    const eligibility = await getExamDeletionEligibility(context, otherExam.exam.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteExam(context, otherExam.exam.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const stillThere = await getExam(other.context, otherExam.exam.id);
    expect(stillThere.ok).toBe(true);
  });
});
