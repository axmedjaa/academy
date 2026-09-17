import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  certificateVerifications,
  certificates,
  courses,
  examResults,
  exams,
  gradeBands,
  gradeConfigurations,
  programs,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { checkCertificateVerifyRateLimit } from "./certificate-verify-rate-limit";
import {
  cancelCertificate,
  getCertificate,
  issueCertificate,
  listCertificates,
  verifyCertificate,
  type PublicCertificateVerification,
} from "./certificates";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup helpers — same shape/conventions as lib/academies/results.test.ts
// (this file's own copies, per this codebase's per-test-file convention).
// ---------------------------------------------------------------------------

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `certificates-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Certificates Test Plan ${randomUUID()}`,
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
      name: `Certificates Test Academy ${randomUUID()}`,
      slug: `certificates-test-${randomUUID()}`,
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

async function insertProgramAndCourse(
  academyId: string,
  programName: string = `Program ${randomUUID()}`,
): Promise<{ courseId: string; programName: string }> {
  const [program] = await db
    .insert(programs)
    .values({ academyId, name: programName })
    .returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  return { courseId: course.id, programName };
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

async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
  fullName: string = "Test Student",
): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8)}`,
      fullName,
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

async function insertGradeBandsDirect(
  gradeConfigurationId: string,
  bands: { label: string; minMark: number; maxMark: number; isPass: boolean }[] = [
    { label: "Fail", minMark: 0, maxMark: 49, isPass: false },
    { label: "Pass", minMark: 50, maxMark: 100, isPass: true },
  ],
): Promise<void> {
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
  passFail?: "pending" | "pass" | "fail";
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
        overrides.marksObtained === undefined
          ? "70"
          : overrides.marksObtained === null
            ? null
            : String(overrides.marksObtained),
      status: overrides.status ?? "published",
      passFail: overrides.passFail ?? "pass",
      publishedAt: overrides.status === undefined || overrides.status === "published" ? new Date() : null,
    })
    .returning({ id: examResults.id });
  return row.id;
}

interface AcademySetup {
  academyId: string;
  creatorUserId: string;
  userId: string;
  branchId: string;
  courseId: string;
  programName: string;
  activeGradeConfigId: string;
  context: AuthContext;
}

async function setupAcademy(role: AcademyRole, programName?: string): Promise<AcademySetup> {
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
  const { courseId, programName: resolvedProgramName } = await insertProgramAndCourse(academyId, programName);
  const activeGradeConfigId = await insertGradeConfigDirect(academyId, creatorUserId);
  await insertGradeBandsDirect(activeGradeConfigId);

  return {
    academyId,
    creatorUserId,
    userId,
    branchId,
    courseId,
    programName: resolvedProgramName,
    activeGradeConfigId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

/** Creates a student + batch in `setup`'s academy with one published Pass result — eligible for a certificate. */
async function createEligibleStudentAndBatch(
  setup: AcademySetup,
  studentName: string = "Test Student",
): Promise<{ studentId: string; batchId: string }> {
  const studentId = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId, studentName);
  const batchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
  const examId = await insertExamDirect(setup.academyId, batchId);
  await insertExamResultDirect(
    setup.academyId,
    examId,
    studentId,
    batchId,
    setup.activeGradeConfigId,
    setup.creatorUserId,
    { marksObtained: 80, status: "published", passFail: "pass" },
  );
  return { studentId, batchId };
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
    const certRows = await db
      .select({ id: certificates.id })
      .from(certificates)
      .where(eq(certificates.academyId, academyId));
    if (certRows.length > 0) {
      await db
        .delete(certificateVerifications)
        .where(
          inArray(
            certificateVerifications.certificateId,
            certRows.map((row) => row.id),
          ),
        );
    }
    await db.delete(certificates).where(eq(certificates.academyId, academyId));
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

async function fetchCertificateRow(certificateId: string) {
  const [row] = await db.select().from(certificates).where(eq(certificates.id, certificateId)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// issueCertificate — permission matrix
// ---------------------------------------------------------------------------
describe("issueCertificate — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: issueCertificate allowed = %s", async (role, allowed) => {
    const setup = await setupAcademy(role);
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const result = await issueCertificate(setup.context, studentId, batchId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// cancelCertificate — permission matrix
// ---------------------------------------------------------------------------
describe("cancelCertificate — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: cancelCertificate allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(owner);
    const issued = await issueCertificate(owner.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const actorUserId = await createUser();
    await addMembership(actorUserId, owner.academyId, role);
    const actorContext: AuthContext = { userId: actorUserId, branchIds: [], academyWide: false };

    const result = await cancelCertificate(actorContext, issued.certificate.id, "Test cancellation reason");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
describe("issueCertificate — eligibility", () => {
  it("a published + Pass result in the batch makes the student eligible", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const result = await issueCertificate(setup.context, studentId, batchId);
    expect(result.ok).toBe(true);
  });

  it("an unpublished result only is not eligible", async () => {
    const setup = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    const batchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const examId = await insertExamDirect(setup.academyId, batchId);
    await insertExamResultDirect(
      setup.academyId, examId, studentId, batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { marksObtained: 80, status: "approved", passFail: "pending" },
    );
    const result = await issueCertificate(setup.context, studentId, batchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_eligible");
  });

  it("a published + Fail result only is not eligible", async () => {
    const setup = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    const batchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const examId = await insertExamDirect(setup.academyId, batchId);
    await insertExamResultDirect(
      setup.academyId, examId, studentId, batchId, setup.activeGradeConfigId, setup.creatorUserId,
      { marksObtained: 10, status: "published", passFail: "fail" },
    );
    const result = await issueCertificate(setup.context, studentId, batchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_eligible");
  });

  it("a student with zero results is not eligible", async () => {
    const setup = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    const batchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const result = await issueCertificate(setup.context, studentId, batchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_eligible");
  });

  it("a published + Pass result in a DIFFERENT batch does not make the student eligible for this batch", async () => {
    const setup = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(setup.academyId, setup.branchId, setup.creatorUserId);
    const otherBatchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const otherExamId = await insertExamDirect(setup.academyId, otherBatchId);
    await insertExamResultDirect(
      setup.academyId, otherExamId, studentId, otherBatchId, setup.activeGradeConfigId, setup.creatorUserId,
      { marksObtained: 90, status: "published", passFail: "pass" },
    );

    const targetBatchId = await insertBatchDirect(setup.academyId, setup.branchId, setup.courseId);
    const result = await issueCertificate(setup.context, studentId, targetBatchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_eligible");
  });
});

// ---------------------------------------------------------------------------
// Duplicate prevention
// ---------------------------------------------------------------------------
describe("issueCertificate — duplicate prevention", () => {
  it("a second certificate for the same (student, batch) is rejected and no second row is created", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);

    const first = await issueCertificate(setup.context, studentId, batchId);
    expect(first.ok).toBe(true);

    const second = await issueCertificate(setup.context, studentId, batchId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");

    const rows = await db
      .select()
      .from(certificates)
      .where(and(eq(certificates.studentId, studentId), eq(certificates.batchId, batchId)));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-academy IDOR
// ---------------------------------------------------------------------------
describe("cross-academy isolation (IDOR)", () => {
  it("cannot issue a certificate for a student/batch belonging to a different academy (generic not_found)", async () => {
    const actorSetup = await setupAcademy("academy_owner");
    const otherSetup = await setupAcademy("academy_owner");
    const { studentId: otherStudentId, batchId: otherBatchId } = await createEligibleStudentAndBatch(otherSetup);

    const result = await issueCertificate(actorSetup.context, otherStudentId, otherBatchId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("getCertificate never returns another academy's certificate", async () => {
    const actorSetup = await setupAcademy("academy_owner");
    const otherSetup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(otherSetup);
    const issued = await issueCertificate(otherSetup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = await getCertificate(actorSetup.context, issued.certificate.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("listCertificates never returns another academy's certificates", async () => {
    const actorSetup = await setupAcademy("academy_owner");
    const { studentId: ownStudentId, batchId: ownBatchId } = await createEligibleStudentAndBatch(actorSetup);
    const ownIssued = await issueCertificate(actorSetup.context, ownStudentId, ownBatchId);
    expect(ownIssued.ok).toBe(true);

    const otherSetup = await setupAcademy("academy_owner");
    const { studentId: otherStudentId, batchId: otherBatchId } = await createEligibleStudentAndBatch(otherSetup);
    await issueCertificate(otherSetup.context, otherStudentId, otherBatchId);

    const result = await listCertificates(actorSetup.context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.certificates.length).toBeGreaterThan(0);
    for (const cert of result.certificates) {
      expect(cert.academyId).toBe(actorSetup.academyId);
    }
  });
});

// ---------------------------------------------------------------------------
// cancelCertificate — non-destructive state machine
// ---------------------------------------------------------------------------
describe("cancelCertificate — non-destructive cancellation", () => {
  it("keeps the row after cancellation, sets status/cancelledAt/cancelledBy/cancellationReason, and writes both audit rows", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const certificateId = issued.certificate.id;

    const cancelled = await cancelCertificate(setup.context, certificateId, "Issued in error");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    const row = await fetchCertificateRow(certificateId);
    expect(row).toBeTruthy();
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.cancelledBy).toBe(setup.userId);
    expect(row.cancellationReason).toBe("Issued in error");

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "certificate"), eq(auditLogs.entityId, certificateId)));
    const actions = auditRows.map((r) => r.action).sort();
    expect(actions).toEqual(["cancelCertificate", "issueCertificate"]);
  });

  it("cancelling an already-cancelled certificate returns already_cancelled and does not overwrite the original fields", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const certificateId = issued.certificate.id;

    const firstCancel = await cancelCertificate(setup.context, certificateId, "First reason");
    expect(firstCancel.ok).toBe(true);
    const before = await fetchCertificateRow(certificateId);

    // A different actor attempts to cancel again with a different reason.
    const secondActorId = await createUser();
    await addMembership(secondActorId, setup.academyId, "academy_admin");
    const secondContext: AuthContext = { userId: secondActorId, branchIds: [], academyWide: false };
    const secondCancel = await cancelCertificate(secondContext, certificateId, "Second reason, should be ignored");
    expect(secondCancel.ok).toBe(false);
    if (!secondCancel.ok) expect(secondCancel.error.code).toBe("already_cancelled");

    const after = await fetchCertificateRow(certificateId);
    expect(after.cancelledAt?.getTime()).toBe(before.cancelledAt?.getTime());
    expect(after.cancelledBy).toBe(before.cancelledBy);
    expect(after.cancellationReason).toBe("First reason");
  });

  it("rejects an empty or whitespace-only cancellation reason", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const emptyResult = await cancelCertificate(setup.context, issued.certificate.id, "");
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(emptyResult.error.code).toBe("validation");

    const whitespaceResult = await cancelCertificate(setup.context, issued.certificate.id, "   ");
    expect(whitespaceResult.ok).toBe(false);
    if (!whitespaceResult.ok) expect(whitespaceResult.error.code).toBe("validation");

    const row = await fetchCertificateRow(issued.certificate.id);
    expect(row.status).toBe("issued");
  });
});

// ---------------------------------------------------------------------------
// verifyCertificate — public lookup
// ---------------------------------------------------------------------------
describe("verifyCertificate", () => {
  it("returns exactly the four documented public fields for a valid certificate, nothing else", async () => {
    const setup = await setupAcademy("academy_owner", "Verify Program Alpha");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup, "Alice Verifyworthy");
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = await verifyCertificate(issued.certificate.certificateCode, `test-ip-${randomUUID()}`, "vitest-agent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.certificate).sort()).toEqual(
      ["issuedAt", "programName", "status", "studentName"].sort(),
    );
    expect(result.certificate.studentName).toBe("Alice Verifyworthy");
    expect(result.certificate.programName).toBe("Verify Program Alpha");
    expect(result.certificate.status).toBe("valid");
    expect(result.certificate.issuedAt).toBeInstanceOf(Date);

    // No internal ids anywhere in the response — direct key check plus a
    // stringified-value check against every internal id this lookup
    // touched (certificate/student/batch/academy/issuedBy).
    const serialized = JSON.stringify(result.certificate);
    for (const forbiddenId of [
      issued.certificate.id,
      studentId,
      batchId,
      setup.academyId,
      issued.certificate.issuedBy,
    ]) {
      expect(serialized).not.toContain(forbiddenId);
    }
    const keys = Object.keys(result.certificate as unknown as Record<string, unknown>);
    for (const forbiddenKey of ["id", "studentId", "batchId", "academyId", "issuedBy", "cancelledBy"]) {
      expect(keys).not.toContain(forbiddenKey);
    }
  });

  it("a cancelled certificate still verifies (ok: true, status 'cancelled'), never as not_found", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const cancelled = await cancelCertificate(setup.context, issued.certificate.id, "No longer valid");
    expect(cancelled.ok).toBe(true);

    const result = await verifyCertificate(issued.certificate.certificateCode, `test-ip-${randomUUID()}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.certificate.status).toBe("cancelled");
  });

  it("an invalid, nonexistent, or malformed code returns the generic not_found error", async () => {
    const nonexistent = await verifyCertificate("ZZZZ-ZZZZ-ZZZZ-ZZZZ", `test-ip-${randomUUID()}`);
    expect(nonexistent.ok).toBe(false);
    if (!nonexistent.ok) expect(nonexistent.error.code).toBe("not_found");

    const empty = await verifyCertificate("", `test-ip-${randomUUID()}`);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("not_found");

    const tooLong = await verifyCertificate("X".repeat(200), `test-ip-${randomUUID()}`);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("not_found");
  });

  it("writes a certificate_verifications row on a successful lookup, and none on a failed lookup", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const before = await db
      .select()
      .from(certificateVerifications)
      .where(eq(certificateVerifications.certificateId, issued.certificate.id));
    expect(before).toHaveLength(0);

    const successIp = `test-ip-success-${randomUUID()}`;
    const success = await verifyCertificate(issued.certificate.certificateCode, successIp);
    expect(success.ok).toBe(true);

    const afterSuccess = await db
      .select()
      .from(certificateVerifications)
      .where(eq(certificateVerifications.certificateId, issued.certificate.id));
    expect(afterSuccess).toHaveLength(1);
    expect(afterSuccess[0].ip).toBe(successIp);

    const failIp = `test-ip-fail-${randomUUID()}`;
    const failed = await verifyCertificate("BOGUS-CODE-0000-0000", failIp);
    expect(failed.ok).toBe(false);

    const rowsWithFailIp = await db
      .select()
      .from(certificateVerifications)
      .where(eq(certificateVerifications.ip, failIp));
    expect(rowsWithFailIp).toHaveLength(0);

    // Still exactly one row total for this certificate — the failed lookup added nothing.
    const afterFail = await db
      .select()
      .from(certificateVerifications)
      .where(eq(certificateVerifications.certificateId, issued.certificate.id));
    expect(afterFail).toHaveLength(1);
  });

  it("works identically for a certificate whose academy has been permanently closed", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup, "Closed Academy Student");
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    await db.update(academies).set({ closedAt: new Date() }).where(eq(academies.id, setup.academyId));

    const result = await verifyCertificate(issued.certificate.certificateCode, `test-ip-${randomUUID()}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.certificate.studentName).toBe("Closed Academy Student");
    expect(result.certificate.status).toBe("valid");
  });

  it("works identically for a certificate whose academy subscription is suspended", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup, "Suspended Academy Student");
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    await db
      .update(academySubscriptions)
      .set({ status: "suspended" })
      .where(eq(academySubscriptions.academyId, setup.academyId));

    const result = await verifyCertificate(issued.certificate.certificateCode, `test-ip-${randomUUID()}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.certificate.studentName).toBe("Suspended Academy Student");
    expect(result.certificate.status).toBe("valid");
  });

  it("never mixes data across academies: each code returns only its own academy's student/program", async () => {
    const setupA = await setupAcademy("academy_owner", "Program A");
    const { studentId: studentIdA, batchId: batchIdA } = await createEligibleStudentAndBatch(setupA, "Student A");
    const issuedA = await issueCertificate(setupA.context, studentIdA, batchIdA);
    expect(issuedA.ok).toBe(true);
    if (!issuedA.ok) return;

    const setupB = await setupAcademy("academy_owner", "Program B");
    const { studentId: studentIdB, batchId: batchIdB } = await createEligibleStudentAndBatch(setupB, "Student B");
    const issuedB = await issueCertificate(setupB.context, studentIdB, batchIdB);
    expect(issuedB.ok).toBe(true);
    if (!issuedB.ok) return;

    const resultA = await verifyCertificate(issuedA.certificate.certificateCode, `test-ip-${randomUUID()}`);
    const resultB = await verifyCertificate(issuedB.certificate.certificateCode, `test-ip-${randomUUID()}`);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.certificate.studentName).toBe("Student A");
    expect(resultA.certificate.programName).toBe("Program A");
    expect(resultB.certificate.studentName).toBe("Student B");
    expect(resultB.certificate.programName).toBe("Program B");
  });
});

// ---------------------------------------------------------------------------
// verifyCertificate — rate limiting
// ---------------------------------------------------------------------------
describe("verifyCertificate — rate limiting", () => {
  it("checkCertificateVerifyRateLimit blocks after the default threshold (20 attempts / window) for one IP", async () => {
    const ip = `rl-unit-${randomUUID()}`;
    try {
      for (let i = 1; i <= 20; i += 1) {
        const result = await checkCertificateVerifyRateLimit(ip);
        expect(result.allowed).toBe(true);
      }
      const blocked = await checkCertificateVerifyRateLimit(ip);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await redis.del(`ratelimit:verify-certificate:${ip}`);
    }
  });

  it("verifyCertificate itself returns a distinct rate_limited result once the same IP exceeds the threshold, and stops logging verifications", async () => {
    const setup = await setupAcademy("academy_owner");
    const { studentId, batchId } = await createEligibleStudentAndBatch(setup);
    const issued = await issueCertificate(setup.context, studentId, batchId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const ip = `rl-integration-${randomUUID()}`;
    try {
      for (let i = 1; i <= 20; i += 1) {
        const result = await verifyCertificate(issued.certificate.certificateCode, ip);
        expect(result.ok).toBe(true);
      }
      const blocked = await verifyCertificate(issued.certificate.certificateCode, ip);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe("rate_limited");

      const verifications = await db
        .select()
        .from(certificateVerifications)
        .where(eq(certificateVerifications.certificateId, issued.certificate.id));
      // Exactly the 20 allowed lookups were logged — the 21st, blocked call
      // never reached the DB-write path.
      expect(verifications).toHaveLength(20);
    } finally {
      await redis.del(`ratelimit:verify-certificate:${ip}`);
    }
  });
});

// Re-exported type used purely so the PublicCertificateVerification shape
// stays exercised by the TypeScript compiler across this test file.
type _AssertPublicShape = PublicCertificateVerification;
void (0 as unknown as _AssertPublicShape);
