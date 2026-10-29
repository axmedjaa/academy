import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  batchCourses,
  academies,
  academyMemberships,
  academySubscriptions,
  approvalRequests,
  auditLogs,
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  branches,
  certificates,
  courses,
  enrollmentFeeSchedules,
  examResults,
  exams,
  feePeriods,
  gradeConfigurations,
  notifications,
  paymentAllocations,
  programs,
  staffBranchAssignments,
  staffProfiles,
  students,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getEnrollmentPaymentSummary, recordFeePeriodPayment, todayDateOnlyInAcademyTimezone } from "./fee-periods";
import {
  assignTrainerToBatch,
  deleteBatchEnrollment,
  enrollStudentInBatch,
  getActiveCoursesForStudents,
  getAssignedBatchIds,
  getEnrollmentDeletionEligibility,
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
  type PaymentPlanInput,
  unassignTrainerFromBatch,
  updateStudentEnrollment,
  withdrawStudentFromBatch,
  listEnrollmentWithdrawals,
} from "./batch-assignments";
import { courseOfBatch } from "@/lib/academies/test-batch-course";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every enrollment now requires an initial payment plan (approved
 * architecture: "no successful enrollment without its required initial
 * payment plan") — this is the default plan every test in this file that
 * doesn't care about the plan's own specifics uses, so each call site
 * doesn't have to restate it. */
const DEFAULT_PAYMENT_PLAN: PaymentPlanInput = {
  intervalMonths: 1,
  amountCents: 5_000,
  anchorDate: "2026-01-01",
};

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
      // Never offered at registration, even if cleanup is interrupted.
      isActive: false,
      description: "Automated test fixture (lib/academies/batch-assignments.test.ts)",
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

/** Adds a second user with the given role to an existing academy — used
 * where a test needs an approver distinct from the recorder (self-approval
 * is allowed for Manager, but these tests specifically want a genuinely
 * separate actor). */
async function addActingUser(academyId: string, role: AcademyRole): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
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
  startDate: string = "2026-01-01",
): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId,
      name: `Batch ${randomUUID()}`,
      code: `B-${randomUUID().slice(0, 8)}`,
      startDate,
    })
    .returning({ id: batches.id });
  // Link the batch's course, as createBatch does (enrollment reads batch_courses).
  await courseOfBatch(row.id);
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

async function insertGradeConfigDirect(academyId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status: "active" })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

async function insertExamResultDirect(
  academyId: string,
  batchId: string,
  studentId: string,
  creatorUserId: string,
): Promise<void> {
  const [exam] = await db
    .insert(exams)
    .values({ academyId, batchId, courseId: await courseOfBatch(batchId), name: `Exam ${randomUUID()}`, maxMarks: "100" })
    .returning({ id: exams.id });
  const gradeConfigurationId = await insertGradeConfigDirect(academyId, creatorUserId);
  await db.insert(examResults).values({
    academyId,
    examId: exam.id,
    batchId,
    studentId,
    gradeConfigurationId,
    enteredBy: creatorUserId,
  });
}

async function insertCertificateDirect(
  academyId: string,
  studentId: string,
  batchId: string,
  issuedBy: string,
): Promise<void> {
  await db.insert(certificates).values({
    academyId,
    studentId,
    batchId,
    courseId: await courseOfBatch(batchId),
    certificateCode: `CERT-${randomUUID()}`,
    issuedBy,
  });
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
  if (createdAcademyIds.length > 0) {
    await db.delete(approvalRequests).where(or(...createdAcademyIds.map((id) => eq(approvalRequests.academyId, id))));
    await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(certificates).where(eq(certificates.academyId, academyId));
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    // Every enrollment now creates an enrollment_fee_schedules row (and
    // usually a fee_periods row too) in the same transaction — both
    // reference batch_enrollments and must be cleaned up before it.
    // student_payments/payment_allocations only exist for the handful of
    // tests that also record a fee-period payment, but are cleaned up
    // unconditionally for every academy in this file.
    await db.delete(paymentAllocations).where(eq(paymentAllocations.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(feePeriods).where(eq(feePeriods.academyId, academyId));
    await db.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batchCourses).where(eq(batchCourses.academyId, academyId));
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

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("admissions_officer ('view') is refused even for its own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } =
      await setupAcademy("admissions_officer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("trainer ('manage assigned') can enroll within their own assigned branch", async () => {
    const { academyId, userId, context, branchId, batchId, creatorUserId } = await setupAcademy("trainer");
    await assignUserToBranches(academyId, userId, [branchId]);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(true);
  });

  it("trainer cannot enroll into a batch outside their assigned branch (IDOR)", async () => {
    const { academyId, userId, context, courseId, creatorUserId } = await setupAcademy("trainer");
    const otherBranch = await insertBranchDirect(academyId);
    const assignedBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);
    const outOfScopeBatch = await insertBatchDirect(academyId, otherBranch, courseId);
    const studentId = await insertStudentDirect(academyId, otherBranch, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId: outOfScopeBatch, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent studentId with 'not_found'", async () => {
    const { context, batchId } = await setupAcademy("academy_owner");
    const result = await enrollStudentInBatch(context, { batchId, studentId: randomUUID(), paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("writes an audit row on successful enrollment", async () => {
    const { context, academyId, branchId, batchId, creatorUserId, userId } = await setupAcademy(
      "academy_owner",
    );
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
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
      paymentPlan: DEFAULT_PAYMENT_PLAN,
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
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("enrollStudentInBatch — atomic initial payment plan", () => {
  it("rejects enrollment with a missing payment plan, and creates no enrollment row at all", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      // @ts-expect-error — deliberately omitted to prove the schema itself requires it.
      paymentPlan: undefined,
    });
    expect(result.ok).toBe(false);

    const rows = await db.select().from(batchEnrollments).where(eq(batchEnrollments.studentId, studentId));
    expect(rows).toHaveLength(0);
  });

  it("rejects an interval outside the supported set (1/2/3/4/6/12 months)", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      paymentPlan: { intervalMonths: 5 as 6, amountCents: 5000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("atomically creates the enrollment, its fee schedule, and the first fee period in one transaction", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      // Anchored in the future so the first period is never "overdue" —
      // this test is about the initial UNPAID state, not overdue
      // derivation (covered separately by fee-periods.test.ts).
      paymentPlan: { intervalMonths: 3, amountCents: 15_000, anchorDate: "2030-01-01" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [schedule] = await db
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, result.enrollment.id));
    expect(schedule.intervalMonths).toBe(3);
    expect(schedule.amountCents).toBe(15_000);

    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, result.enrollment.id));
    expect(periods.length).toBeGreaterThan(0);
    // $150.00 total over 3 monthly installments = $50.00/month — see
    // fee-periods.ts's own module comment ("Payment schedule model"):
    // intervalMonths is the installment COUNT, never a per-period amount.
    expect(periods[0].expectedAmountCents).toBe(5_000);

    // Approved architecture: "Initial state: Expected > 0, Paid = 0, Status = UNPAID."
    const summary = await getEnrollmentPaymentSummary(context, result.enrollment.id);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.expectedCents).toBeGreaterThan(0);
      expect(summary.summary.paidCents).toBe(0);
      expect(summary.summary.status).toBe("unpaid");
    }

    // No fake payment was ever created just because the enrollment/schedule
    // exists — zero student_payments rows for this student.
    const payments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, studentId));
    expect(payments).toHaveLength(0);
  });

  it("defaults the anchor date to TODAY (the enrollment moment), never the batch's own start_date", async () => {
    const { context, academyId, branchId, courseId, creatorUserId } = await setupAcademy("manager");
    // insertBatchDirect's own default startDate is "2026-01-01" — fixed,
    // and deliberately far from "today" in practice, so this test can't
    // pass by accident if the old "anchors to batch.startDate" behavior
    // ever crept back in.
    const specificBatchId = await insertBatchDirect(academyId, branchId, courseId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId: specificBatchId,
      studentId,
      paymentPlan: { intervalMonths: 1, amountCents: 5000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [schedule] = await db
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, result.enrollment.id));
    expect(schedule.anchorDate).toBe(todayDateOnlyInAcademyTimezone());
    expect(schedule.anchorDate).not.toBe("2026-01-01");

    // The direct, user-visible consequence of the fix: the first fee
    // period starts TODAY and is due TODAY — never "Upcoming," never
    // anchored to a batch start date weeks or months away.
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, result.enrollment.id))
      .orderBy(feePeriods.periodStart);
    const firstPeriod = periods[0];
    expect(firstPeriod.periodStart).toBe(todayDateOnlyInAcademyTimezone());
    expect(firstPeriod.dueDate).toBe(todayDateOnlyInAcademyTimezone());
  });

  it("every supported payment-plan interval (1/2/3/4/6/12 months) generates that many monthly installments, each exactly ONE calendar month, splitting the total fee evenly", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");
    const today = todayDateOnlyInAcademyTimezone();

    // Expected period-end for a ONE-calendar-month period is "the day
    // before the same day-of-month next month, clamped to that month's
    // own length" — computed independently here (plain JS Date math on
    // the anchor's own parts) rather than by calling the production
    // addMonths/addDays helpers this test is meant to verify, so a bug in
    // those helpers can't hide itself from this assertion. The clamp
    // matters even for this "every interval" test (not just the dedicated
    // month-end-boundary test below) because `today` — whatever day this
    // test happens to run — could itself be the 29th/30th/31st of its
    // month on any given day. Every generated period is exactly one
    // month long regardless of `intervalMonths` — see fee-periods.ts's
    // own module comment ("Payment schedule model"): `intervalMonths` is
    // the installment COUNT, never a period length.
    function expectedPeriodEnd(startDate: string): string {
      const [y, m, d] = startDate.split("-").map(Number);
      const totalMonths = m - 1 + 1;
      const y2 = y + Math.floor(totalMonths / 12);
      const m2 = (totalMonths % 12) + 1;
      const lastDayOfMonth = new Date(Date.UTC(y2, m2, 0)).getUTCDate();
      const d2 = Math.min(d, lastDayOfMonth);
      const end = new Date(Date.UTC(y2, m2 - 1, d2));
      end.setUTCDate(end.getUTCDate() - 1);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
    }

    for (const intervalMonths of [1, 2, 3, 4, 6, 12] as const) {
      const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
      const totalCents = 12_000; // divides evenly by every supported interval
      const result = await enrollStudentInBatch(context, {
        batchId,
        studentId,
        paymentPlan: { intervalMonths, amountCents: totalCents },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const periods = await db
        .select()
        .from(feePeriods)
        .where(eq(feePeriods.enrollmentId, result.enrollment.id))
        .orderBy(feePeriods.periodStart);
      expect(periods).toHaveLength(intervalMonths);
      const firstPeriod = periods[0];

      expect(firstPeriod.periodStart).toBe(today);
      expect(firstPeriod.dueDate).toBe(today);
      expect(firstPeriod.periodEnd).toBe(expectedPeriodEnd(today));
      expect(firstPeriod.expectedAmountCents).toBe(totalCents / intervalMonths);

      // The installments sum to EXACTLY the total fee, no rounding drift.
      const sum = periods.reduce((total, period) => total + period.expectedAmountCents, 0);
      expect(sum).toBe(totalCents);
    }
  });

  it("clamps correctly at month-end boundaries (e.g. enrolling Jan 29/30/31, or on Feb 29 in a leap year) — same day-clamping convention generateFeePeriodsForEnrollment already uses — every installment is exactly one month, regardless of the plan's own installment count", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");

    const cases: { anchorDate: string; intervalMonths: 1 | 2; expectedPeriodEnd: string }[] = [
      // Jan 31 + 1 month -> Feb has no 31st in 2027 (not a leap year) ->
      // clamps to Feb 28, so period end is one day before that: Feb 27.
      { anchorDate: "2027-01-31", intervalMonths: 1, expectedPeriodEnd: "2027-02-27" },
      // Jan 30 + 1 month -> Feb 28 (2027) -> period end Feb 27.
      { anchorDate: "2027-01-30", intervalMonths: 1, expectedPeriodEnd: "2027-02-27" },
      // Dec 31 + 1 month -> Jan 31 (2027) -> period end Jan 30. The plan's
      // OWN installment count (2) never changes a period's own length —
      // only how many separate monthly installments exist in total and
      // what each one's own expectedAmountCents is.
      { anchorDate: "2026-12-31", intervalMonths: 2, expectedPeriodEnd: "2027-01-30" },
      // Jan 31, 2028 (a leap year) + 1 month -> Feb 29 -> period end Feb 28.
      { anchorDate: "2028-01-31", intervalMonths: 1, expectedPeriodEnd: "2028-02-28" },
    ];

    for (const { anchorDate, intervalMonths, expectedPeriodEnd } of cases) {
      const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
      const result = await enrollStudentInBatch(context, {
        batchId,
        studentId,
        paymentPlan: { intervalMonths, amountCents: 5_000, anchorDate },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const [firstPeriod] = await db
        .select()
        .from(feePeriods)
        .where(eq(feePeriods.enrollmentId, result.enrollment.id))
        .orderBy(feePeriods.periodStart)
        .limit(1);
      expect(firstPeriod.periodStart).toBe(anchorDate);
      expect(firstPeriod.periodEnd).toBe(expectedPeriodEnd);
    }
  });

  it("regression: a batch whose start_date is in the FUTURE relative to the enrollment moment still anchors the first period to TODAY, not the batch's start_date", async () => {
    const { context, academyId, branchId, courseId, creatorUserId } = await setupAcademy("manager");
    const today = todayDateOnlyInAcademyTimezone();

    // The exact shape of the reported bug: a batch starting weeks/months
    // from now, enrolled into today. Picks a start date structurally
    // guaranteed to be after "today" regardless of when this test runs.
    const futureStartDate = formatFutureDate(today, 60);
    const futureBatchId = await insertBatchDirect(academyId, branchId, courseId, futureStartDate);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId: futureBatchId,
      studentId,
      paymentPlan: { intervalMonths: 1, amountCents: 10_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [schedule] = await db
      .select()
      .from(enrollmentFeeSchedules)
      .where(eq(enrollmentFeeSchedules.enrollmentId, result.enrollment.id));
    expect(schedule.anchorDate).toBe(today);
    expect(schedule.anchorDate).not.toBe(futureStartDate);

    const [firstPeriod] = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, result.enrollment.id))
      .orderBy(feePeriods.periodStart)
      .limit(1);
    expect(firstPeriod.periodStart).toBe(today);
    expect(firstPeriod.dueDate).toBe(today);
    expect(firstPeriod.periodStart).not.toBe(futureStartDate);
    expect(firstPeriod.dueDate).not.toBe(futureStartDate);

    // The "Upcoming (not yet due)" UI wording (student-detail.tsx /
    // fee-periods-manager.tsx) is driven by comparing `dueDate` against
    // today, not by the batch's own start_date — so a due date of today
    // must never be treated as in the future.
    expect(compareDateOnlyForTest(firstPeriod.dueDate, today)).toBe(0);
  });
});

/** Adds `days` calendar days to a "YYYY-MM-DD" date-only string without any
 * timezone-sensitive Date-object local-time drift (plain UTC arithmetic on
 * the parsed parts only) — used solely to build a start date this test can
 * guarantee is in the future relative to `today`, not production logic. */
function formatFutureDate(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function compareDateOnlyForTest(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("enroll/withdraw student — unique-for-active-enrollment enforcement", () => {
  it("enrolling the same student in the same batch twice while active is a conflict", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);

    const second = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("a withdrawn enrollment allows re-enrollment (new row, not a reactivation)", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const withdrawn = await withdrawStudentFromBatch(context, first.enrollment.id);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) expect(withdrawn.enrollment.status).toBe("withdrawn");

    const reenrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
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

    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(first.ok).toBe(true);

    const second = await withdrawStudentFromBatch(context, created.enrollment.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_transition");
  });
});

describe("withdraw reason and listEnrollmentWithdrawals", () => {
  it("records the reason with the withdrawal and reports when and why", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const before = Date.now();
    const withdrawn = await withdrawStudentFromBatch(context, created.enrollment.id, { reason: "  Moved to another city  " });
    expect(withdrawn.ok).toBe(true);

    const details = await listEnrollmentWithdrawals(context, [created.enrollment.id]);
    const detail = details.get(created.enrollment.id);
    expect(detail?.reason).toBe("Moved to another city");
    expect(detail?.withdrawnAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it("still withdraws without a reason (batch roster) and reports no reason", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");

    expect((await withdrawStudentFromBatch(context, created.enrollment.id)).ok).toBe(true);
    const detail = (await listEnrollmentWithdrawals(context, [created.enrollment.id])).get(created.enrollment.id);
    expect(detail).toBeDefined();
    expect(detail?.reason).toBeNull();
  });

  it("rejects an over-long reason without withdrawing", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const created = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");

    const result = await withdrawStudentFromBatch(context, created.enrollment.id, { reason: "x".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, created.enrollment.id));
    expect(row.status).toBe("active");
  });

  it("never reports another academy's withdrawals", async () => {
    const a = await setupAcademy("academy_owner");
    const b = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(a.academyId, a.branchId, a.creatorUserId);
    const created = await enrollStudentInBatch(a.context, { batchId: a.batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    if (!created.ok) throw new Error("setup failed");
    await withdrawStudentFromBatch(a.context, created.enrollment.id, { reason: "Private" });

    const seenByOther = await listEnrollmentWithdrawals(b.context, [created.enrollment.id]);
    expect(seenByOther.size).toBe(0);
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

// Simple course/enrollment model — the student registration form's
// "Course" select and the `/academy/students` list's "Course" column both
// build on these two functions.
describe("getActiveCoursesForStudents", () => {
  it("returns each student's active-enrollment course/batch names, keyed by studentId", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const otherStudentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);

    const result = await getActiveCoursesForStudents(academyId, [studentId, otherStudentId]);
    expect(result.get(studentId)).toHaveLength(1);
    expect(result.get(studentId)?.[0].batchId).toBe(batchId);
    expect(result.get(otherStudentId) ?? []).toEqual([]);
  });

  it("excludes withdrawn enrollments", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    const withdrawn = await withdrawStudentFromBatch(context, enrolled.enrollment.id);
    expect(withdrawn.ok).toBe(true);

    const result = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(result.get(studentId) ?? []).toEqual([]);
  });

  it("returns an empty map for an empty studentIds list", async () => {
    const result = await getActiveCoursesForStudents(randomUUID(), []);
    expect(result.size).toBe(0);
  });
});

describe("updateStudentEnrollment", () => {
  it("enrolls a not-yet-enrolled student into the chosen batch", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(result.ok).toBe(true);

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)?.[0].batchId).toBe(batchId);
  });

  it("adds an enrollment in another batch without withdrawing the first", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const secondBatchId = await insertBatchDirect(academyId, branchId, courseId);
    await courseOfBatch(secondBatchId);

    const first = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(first.ok).toBe(true);

    const second = await updateStudentEnrollment(context, studentId, secondBatchId, DEFAULT_PAYMENT_PLAN);
    expect(second.ok).toBe(true);

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)?.map((c) => c.batchId).sort()).toEqual([batchId, secondBatchId].sort());
  });

  it("refuses without a batch (it never withdraws on its own)", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const enrolled = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(enrolled.ok).toBe(true);

    const cleared = await updateStudentEnrollment(context, studentId, undefined);
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.error.code).toBe("validation");

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)).toHaveLength(1);
  });

  it("refuses a duplicate enrollment in the same batch course", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(first.ok).toBe(true);
    const second = await updateStudentEnrollment(context, studentId, batchId, DEFAULT_PAYMENT_PLAN);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");

    const active = await getActiveCoursesForStudents(academyId, [studentId]);
    expect(active.get(studentId)).toHaveLength(1);
  });
});

describe("enrollStudentInBatch — multi-course batches", () => {
  async function addCourseToBatch(academyId: string, batchId: string): Promise<string> {
    const courseId = await insertProgramAndCourse(academyId);
    await db.insert(batchCourses).values({ academyId, batchId, courseId });
    return courseId;
  }

  it("enrolls one student in two courses of a batch, each with its own fee schedule", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const secondCourseId = await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [courseId, secondCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollments.map((e) => e.courseId).sort()).toEqual([courseId, secondCourseId].sort());

    const schedules = await db
      .select({ enrollmentId: enrollmentFeeSchedules.enrollmentId })
      .from(enrollmentFeeSchedules)
      .where(inArray(enrollmentFeeSchedules.enrollmentId, result.enrollments.map((e) => e.id)));
    expect(schedules).toHaveLength(2);

    const students = await db.select({ id: batchEnrollments.studentId }).from(batchEnrollments).where(eq(batchEnrollments.batchId, batchId));
    expect(new Set(students.map((row) => row.id))).toEqual(new Set([studentId]));
  });

  it("requires a course choice when the batch runs several courses", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a course that isn't part of the batch, and writes nothing", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const outsideCourseId = await insertProgramAndCourse(academyId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [outsideCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    const rows = await db.select({ id: batchEnrollments.id }).from(batchEnrollments).where(eq(batchEnrollments.studentId, studentId));
    expect(rows).toHaveLength(0);
  });

  it("rejects another academy's course even when named explicitly", async () => {
    const { batchId, academyId, branchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const other = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [other.courseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(result.ok).toBe(false);
  });

  it("rolls back every course when one of them is already enrolled", async () => {
    const { academyId, branchId, courseId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const secondCourseId = await addCourseToBatch(academyId, batchId);
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const first = await enrollStudentInBatch(context, { batchId, studentId, courseIds: [courseId], paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(first.ok).toBe(true);
    const both = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      courseIds: [courseId, secondCourseId],
      paymentPlan: DEFAULT_PAYMENT_PLAN,
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.code).toBe("conflict");

    const rows = await db
      .select({ courseId: batchEnrollments.courseId })
      .from(batchEnrollments)
      .where(and(eq(batchEnrollments.studentId, studentId), eq(batchEnrollments.status, "active")));
    expect(rows.map((row) => row.courseId)).toEqual([courseId]);
  });
});

describe("getEnrollmentDeletionEligibility / deleteBatchEnrollment", () => {
  it("an enrollment with no exam results/certificates is eligible and deletes, regardless of status", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const eligibility = await getEnrollmentDeletionEligibility(context, enrolled.enrollment.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(deleted.ok).toBe(true);

    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, enrolled.enrollment.id));
    expect(row).toBeUndefined();
  });

  it("an enrollment with an exam result for that student+batch is blocked from deletion, and nothing is deleted", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    await insertExamResultDirect(academyId, batchId, studentId, creatorUserId);

    const eligibility = await getEnrollmentDeletionEligibility(context, enrolled.enrollment.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.examResultCount).toBe(1);
    }

    const deleted = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, enrolled.enrollment.id));
    expect(row).toBeDefined();
  });

  it("an enrollment with a certificate for that student+batch is blocked from deletion", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    await insertCertificateDirect(academyId, studentId, batchId, creatorUserId);

    const eligibility = await getEnrollmentDeletionEligibility(context, enrolled.enrollment.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.certificateCount).toBe(1);
    }

    const deleted = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a withdrawn enrollment with no protected history is still eligible for deletion", async () => {
    const { branchId, batchId, creatorUserId, academyId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    const withdrawn = await withdrawStudentFromBatch(context, enrolled.enrollment.id);
    expect(withdrawn.ok).toBe(true);

    const deleted = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(deleted.ok).toBe(true);
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: delete allowed = %s (Trainer's own-branch withdraw access does not extend to delete)", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(owner.academyId, owner.branchId, owner.creatorUserId);
    const enrolled = await enrollStudentInBatch(owner.context, { batchId: owner.batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    if (role === "trainer" || role === "admissions_officer") {
      await assignUserToBranches(owner.academyId, actingUserId, [owner.branchId]);
    }
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await deleteBatchEnrollment(actingContext, enrolled.enrollment.id);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never deletes another academy's enrollment (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherStudentId = await insertStudentDirect(other.academyId, other.branchId, other.creatorUserId);
    const otherEnrolled = await enrollStudentInBatch(other.context, { batchId: other.batchId, studentId: otherStudentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(otherEnrolled.ok).toBe(true);
    if (!otherEnrolled.ok) return;

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getEnrollmentDeletionEligibility(context, otherEnrolled.enrollment.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteBatchEnrollment(context, otherEnrolled.enrollment.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, otherEnrolled.enrollment.id));
    expect(row).toBeDefined();
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const result = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, enrolled.enrollment.id), eq(auditLogs.action, "deleteBatchEnrollment")));
    expect(audit?.action).toBe("deleteBatchEnrollment");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: an exam result recorded after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const enrolled = await enrollStudentInBatch(context, { batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const eligibility = await getEnrollmentDeletionEligibility(context, enrolled.enrollment.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent exam result landing between the UI's
    // eligibility preview and the actual delete call.
    await insertExamResultDirect(academyId, batchId, studentId, creatorUserId);

    const result = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("an enrollment with an approved fee-period payment is blocked from deletion (never destroys financial history)", async () => {
    const { academyId, branchId, batchId, creatorUserId, context } = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
    const manager = await addActingUser(academyId, "manager");
    const enrolled = await enrollStudentInBatch(manager.context, {
      batchId,
      studentId,
      paymentPlan: { intervalMonths: 1, amountCents: 5000, anchorDate: "2020-01-01" },
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, enrolled.enrollment.id));
    const recorded = await recordFeePeriodPayment(manager.context, {
      studentId,
      enrollmentId: enrolled.enrollment.id,
      allocations: [{ feePeriodId: period.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const eligibility = await getEnrollmentDeletionEligibility(context, enrolled.enrollment.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.paymentActivityCount).toBe(1);
    }

    const deleted = await deleteBatchEnrollment(context, enrolled.enrollment.id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });
});
