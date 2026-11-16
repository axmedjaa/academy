import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll } from "vitest";
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
import type { PaymentPlanInput } from "./batch-assignments";
import { courseOfBatch } from "@/lib/academies/test-batch-course";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";

/**
 * Shared fixtures for the batch-assignment test files
 * (batch-assignments.test.ts and batch-enrollment-fees-deletion.test.ts),
 * moved here unchanged from the original single test file. Not a test file
 * itself (it doesn't match *.test.ts).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Every enrollment now requires an initial payment plan (approved
 * architecture: "no successful enrollment without its required initial
 * payment plan") — this is the default plan every test in this file that
 * doesn't care about the plan's own specifics uses, so each call site
 * doesn't have to restate it. */
export const DEFAULT_PAYMENT_PLAN: PaymentPlanInput = {
  intervalMonths: 1,
  amountCents: 5_000,
  anchorDate: "2026-01-01",
};

export const createdUserIds: string[] = [];
export const createdAcademyIds: string[] = [];
export const createdPlanIds: string[] = [];

export async function createUser(): Promise<string> {
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

export async function createPlan(): Promise<string> {
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

export async function createAcademy(creatorUserId: string): Promise<string> {
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

export async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
}

/** Adds a second user with the given role to an existing academy — used
 * where a test needs an approver distinct from the recorder (self-approval
 * is allowed for Manager, but these tests specifically want a genuinely
 * separate actor). */
export async function addActingUser(academyId: string, role: AcademyRole): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
}

export async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  return row.id;
}

export async function insertProgramAndCourse(academyId: string): Promise<string> {
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

export async function insertBatchDirect(
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

export async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string): Promise<string> {
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
export async function insertStaffProfile(academyId: string, userId: string): Promise<string> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId, fullName: "Test Staff Member", phone: "+1-555-0100" })
    .returning({ id: staffProfiles.id });
  return profile.id;
}

export async function assignUserToBranches(academyId: string, userId: string, branchIds: string[]): Promise<string> {
  const profileId = await insertStaffProfile(academyId, userId);
  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profileId, branchId });
  }
  return profileId;
}

export async function insertGradeConfigDirect(academyId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(gradeConfigurations)
    .values({ academyId, name: `Config ${randomUUID()}`, createdBy: creatorUserId, status: "active" })
    .returning({ id: gradeConfigurations.id });
  return row.id;
}

export async function insertExamResultDirect(
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

export async function insertCertificateDirect(
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

export async function setupAcademy(
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

/** Registers this file's cleanup (every row its tests created). Call once at
 * the top level of each test file that uses these fixtures; each test file
 * gets its own copy of the created-id lists above (Vitest isolates modules
 * per file). */
export function registerFixtureCleanup(): void {
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
}
