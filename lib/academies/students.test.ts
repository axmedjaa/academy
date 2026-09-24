import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
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
  certificates,
  courses,
  examResults,
  exams,
  gradeConfigurations,
  programs,
  staffBranchAssignments,
  staffProfiles,
  studentCharges,
  studentDocuments,
  studentPayments,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  deleteStudent,
  getAdmissionsView,
  getStudent,
  getStudentDeletionEligibility,
  searchStudents,
  updateStudent,
} from "./students";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/branches.test.ts.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `students-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(maxStudents = 100): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Students Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents,
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
      name: `Students Test Academy ${randomUUID()}`,
      slug: `students-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(
  userId: string,
  academyId: string,
  role: AcademyRole,
): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

/** Full fixture: a fresh academy, one active plan/subscription, and one
 * membership of the given role. */
async function setupAcademy(
  role: AcademyRole,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
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

  return {
    academyId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({
      academyId,
      name: `Branch ${randomUUID().slice(0, 8)}`,
      code: `BR-${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: branches.id });
  return row.id;
}

/** Directly inserts staff_profiles + staff_branch_assignments rows,
 * bypassing not-yet-built staff/branch-assignment actions — per the task
 * brief, tests build this fixture data directly. */
async function assignUserToBranches(
  academyId: string,
  userId: string,
  branchIds: string[],
): Promise<void> {
  const [profile] = await db
    .insert(staffProfiles)
    .values({
      academyId,
      userId,
      fullName: "Test Staff Member",
      phone: "+1-555-0100",
    })
    .returning({ id: staffProfiles.id });

  for (const branchId of branchIds) {
    await db.insert(staffBranchAssignments).values({
      academyId,
      staffProfileId: profile.id,
      branchId,
    });
  }
}

/** Directly inserts a `students` row, bypassing the not-yet-existing
 * registerStudent (Item 38) — per the task brief, this item's tests build
 * fixture students directly rather than exercising registration. */
async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
  overrides: Partial<typeof students.$inferInsert> = {},
): Promise<typeof students.$inferSelect> {
  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber: `STD-${randomUUID().slice(0, 8).toUpperCase()}`,
      fullName: `Test Student ${randomUUID().slice(0, 8)}`,
      phone: "+1-555-0177",
      createdBy: creatorUserId,
      ...overrides,
    })
    .returning();
  return row;
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

async function enrollStudentDirect(academyId: string, batchId: string, studentId: string): Promise<void> {
  await db.insert(batchEnrollments).values({ academyId, batchId, studentId, status: "active" });
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
    .values({ academyId, batchId, name: `Exam ${randomUUID()}`, maxMarks: "100" })
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

async function insertChargeDirect(academyId: string, studentId: string, creatorUserId: string): Promise<void> {
  await db.insert(studentCharges).values({
    academyId,
    studentId,
    description: "Test charge",
    amountCents: 10_000,
    currency: "USD",
    createdBy: creatorUserId,
  });
}

async function insertPaymentDirect(academyId: string, studentId: string, recordedBy: string): Promise<void> {
  await db.insert(studentPayments).values({
    academyId,
    studentId,
    amountCents: 10_000,
    currency: "USD",
    method: "cash",
    receivedAt: new Date(),
    recordedBy,
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
    certificateCode: `CERT-${randomUUID()}`,
    issuedBy,
  });
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
    await db.delete(certificates).where(eq(certificates.academyId, academyId));
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));

    const studentRows = await db
      .select({ id: students.id })
      .from(students)
      .where(eq(students.academyId, academyId));
    for (const student of studentRows) {
      await db.delete(studentDocuments).where(eq(studentDocuments.studentId, student.id));
    }
    await db.delete(students).where(eq(students.academyId, academyId));

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

describe("searchStudents — permission matrix (read)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", true],
    ["finance_officer", true],
    ["trainer", true],
  ])("role %s: search allowed = %s", async (role, allowed) => {
    const { academyId, userId, context } = await setupAcademy(role);
    const branchId = await insertBranchDirect(academyId);
    if (role === "admissions_officer" || role === "trainer") {
      await assignUserToBranches(academyId, userId, [branchId]);
    }
    await insertStudentDirect(academyId, branchId, userId);

    const result = await searchStudents(context);
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });
});

describe("searchStudents — filtering by name/student number", () => {
  it("filters by full name (case-insensitive, partial match)", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchId, userId, { fullName: "Amina Yusuf" });
    await insertStudentDirect(academyId, branchId, userId, { fullName: "Bashir Ali" });

    const result = await searchStudents(context, { searchTerm: "amina" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].fullName).toBe("Amina Yusuf");
  });

  it("filters by student number (exact/partial match)", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const target = await insertStudentDirect(academyId, branchId, userId, {
      studentNumber: "STD-000123",
    });
    await insertStudentDirect(academyId, branchId, userId, { studentNumber: "STD-000456" });

    const result = await searchStudents(context, { searchTerm: "000123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toEqual([target.id]);
  });

  it("filters by status", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchId, userId, { status: "active" });
    const archived = await insertStudentDirect(academyId, branchId, userId, {
      status: "archived",
    });

    const result = await searchStudents(context, { status: "archived" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toEqual([archived.id]);
  });

  it("returns no matches for a search term that matches nothing", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchId, userId, { fullName: "Zainab Kabir" });

    const result = await searchStudents(context, { searchTerm: "nonexistent-xyz" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([]);
  });
});

describe("updateStudent — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", true],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: update allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(owner.academyId);
    const student = await insertStudentDirect(owner.academyId, branchId, owner.userId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    if (role === "admissions_officer" || role === "trainer") {
      await assignUserToBranches(owner.academyId, actingUserId, [branchId]);
    }
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await updateStudent(actingContext, student.id, {
      fullName: "Updated Name",
      phone: student.phone ?? undefined,
    });
    expect(result.ok).toBe(allowed);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    } else {
      expect(result.student.fullName).toBe("Updated Name");
    }
  });

  it("updates editable fields and writes an audit row", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId);

    const result = await updateStudent(context, student.id, {
      fullName: "Renamed Student",
      phone: "+1-555-9999",
      email: "student@example.com",
      guardianName: "Guardian Name",
      guardianPhone: "+1-555-8888",
      status: "archived",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.fullName).toBe("Renamed Student");
    expect(result.student.phone).toBe("+1-555-9999");
    expect(result.student.email).toBe("student@example.com");
    expect(result.student.status).toBe("archived");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, student.id));
    expect(audit?.action).toBe("updateStudent");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("rejects an empty full name with code 'validation'", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId);

    const result = await updateStudent(context, student.id, { fullName: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("academy-wide roles may transfer a student to another branch via branchId", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchA, userId);

    const result = await updateStudent(context, student.id, {
      fullName: student.fullName,
      branchId: branchB,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.student.branchId).toBe(branchB);
  });

  it("rejects transferring a student to a branch belonging to a DIFFERENT academy, and leaves the student unchanged", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId);

    const other = await setupAcademy("academy_owner");
    const otherAcademyBranch = await insertBranchDirect(other.academyId);

    const result = await updateStudent(context, student.id, {
      fullName: student.fullName,
      branchId: otherAcademyBranch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const [reloaded] = await db.select().from(students).where(eq(students.id, student.id));
    expect(reloaded.branchId).toBe(branchId);
    expect(reloaded.fullName).toBe(student.fullName);
  });

  it("admissions_officer (branch-limited) is refused if the update includes a branchId, even unchanged", async () => {
    const owner = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(owner.academyId);
    const student = await insertStudentDirect(owner.academyId, branchId, owner.userId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, "admissions_officer");
    await assignUserToBranches(owner.academyId, actingUserId, [branchId]);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await updateStudent(actingContext, student.id, {
      fullName: "Still Editable",
      branchId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("branch-scoped IDOR — Admissions Officer / Trainer", () => {
  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s: getStudent on a student in an unassigned branch returns 'not_found'",
    async (role) => {
      const { academyId, userId, context } = await setupAcademy(role);
      const assignedBranch = await insertBranchDirect(academyId);
      const otherBranch = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assignedBranch]);

      const creatorId = await createUser();
      const inScope = await insertStudentDirect(academyId, assignedBranch, creatorId);
      const outOfScope = await insertStudentDirect(academyId, otherBranch, creatorId);

      const okResult = await getStudent(context, inScope.id);
      expect(okResult.ok).toBe(true);

      const idorResult = await getStudent(context, outOfScope.id);
      expect(idorResult.ok).toBe(false);
      if (!idorResult.ok) expect(idorResult.error.code).toBe("not_found");
    },
  );

  it.each<AcademyRole>(["admissions_officer", "trainer"])(
    "role %s: getStudent on a guessed/nonexistent id returns the identical 'not_found'",
    async (role) => {
      const { academyId, userId, context } = await setupAcademy(role);
      const assignedBranch = await insertBranchDirect(academyId);
      await assignUserToBranches(academyId, userId, [assignedBranch]);

      const guessed = await getStudent(context, randomUUID());
      expect(guessed.ok).toBe(false);
      if (!guessed.ok) expect(guessed.error.code).toBe("not_found");
    },
  );

  it("admissions_officer cannot update a student in an unassigned branch (IDOR on write)", async () => {
    const owner = await setupAcademy("academy_owner");
    const assignedBranch = await insertBranchDirect(owner.academyId);
    const otherBranch = await insertBranchDirect(owner.academyId);
    const outOfScope = await insertStudentDirect(owner.academyId, otherBranch, owner.userId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, "admissions_officer");
    await assignUserToBranches(owner.academyId, actingUserId, [assignedBranch]);
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await updateStudent(actingContext, outOfScope.id, { fullName: "Hijacked" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("admissions_officer/trainer with no staff_profiles/assignment rows sees no students in search", async () => {
    const { academyId, userId, context } = await setupAcademy("admissions_officer");
    const branchId = await insertBranchDirect(academyId);
    await insertStudentDirect(academyId, branchId, userId);

    const result = await searchStudents(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rows).toEqual([]);
  });

  it("searchStudents scopes branch-limited roles to only their assigned branch(es)", async () => {
    const { academyId, userId, context } = await setupAcademy("trainer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const creatorId = await createUser();
    const inScope = await insertStudentDirect(academyId, assignedBranch, creatorId);
    await insertStudentDirect(academyId, otherBranch, creatorId);

    const result = await searchStudents(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toEqual([inScope.id]);
  });

  it("a branch-limited caller requesting an out-of-scope branchId filter gets an empty result, not another branch's data", async () => {
    const { academyId, userId, context } = await setupAcademy("admissions_officer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const creatorId = await createUser();
    await insertStudentDirect(academyId, otherBranch, creatorId);

    const result = await searchStudents(context, { branchId: otherBranch });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rows).toEqual([]);
  });
});

describe("tenant isolation — cross-academy access", () => {
  it("never returns another academy's students from searchStudents", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranch = await insertBranchDirect(other.academyId);
    await insertStudentDirect(other.academyId, otherBranch, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await searchStudents(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rows).toEqual([]);
  });

  it("getStudent returns 'not_found' (never 'forbidden') for a student belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranch = await insertBranchDirect(other.academyId);
    const otherStudent = await insertStudentDirect(other.academyId, otherBranch, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await getStudent(context, otherStudent.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("updateStudent cannot mutate a student belonging to another academy", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranch = await insertBranchDirect(other.academyId);
    const otherStudent = await insertStudentDirect(other.academyId, otherBranch, other.userId);

    const { context } = await setupAcademy("academy_owner");
    const result = await updateStudent(context, otherStudent.id, { fullName: "Hijacked" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("two academies may both use student number STD-000001 independently (Phase 2 §2/§8/§9 uniqueness scope)", async () => {
    const academyA = await setupAcademy("academy_owner");
    const branchA = await insertBranchDirect(academyA.academyId);
    const academyB = await setupAcademy("academy_owner");
    const branchB = await insertBranchDirect(academyB.academyId);

    const studentA = await insertStudentDirect(academyA.academyId, branchA, academyA.userId, {
      studentNumber: "STD-000001",
    });
    const studentB = await insertStudentDirect(academyB.academyId, branchB, academyB.userId, {
      studentNumber: "STD-000001",
    });
    expect(studentA.studentNumber).toBe(studentB.studentNumber);

    const resultA = await searchStudents(academyA.context, { searchTerm: "STD-000001" });
    expect(resultA.ok).toBe(true);
    if (resultA.ok) expect(resultA.data.rows.map((r) => r.id)).toEqual([studentA.id]);
  });
});

describe("subscription-state gating", () => {
  it("blocks with code 'blocked' when the academy's subscription is suspended", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const planId = await createPlan();
    await db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "suspended",
      createdBy: creatorUserId,
    });
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await searchStudents({ userId, branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});

describe("getAdmissionsView — recently-registered/pending-onboarding subset", () => {
  it("includes a student with zero documents regardless of age, excludes a settled old student", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const oldDate = new Date(Date.now() - 90 * DAY_MS);

    const pendingDocs = await insertStudentDirect(academyId, branchId, userId, {
      createdAt: oldDate,
    });
    const settled = await insertStudentDirect(academyId, branchId, userId, {
      createdAt: oldDate,
    });
    await db.insert(studentDocuments).values({
      academyId,
      studentId: settled.id,
      documentType: "id_copy",
      fileRef: "ref-1",
      uploadedBy: userId,
    });

    const result = await getAdmissionsView(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.rows.map((r) => r.id);
    expect(ids).toContain(pendingDocs.id);
    expect(ids).not.toContain(settled.id);
  });

  it("includes a recently-registered student even if fully documented", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);

    const recent = await insertStudentDirect(academyId, branchId, userId);
    await db.insert(studentDocuments).values({
      academyId,
      studentId: recent.id,
      documentType: "id_copy",
      fileRef: "ref-1",
      uploadedBy: userId,
    });

    const result = await getAdmissionsView(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toContain(recent.id);
    const row = result.data.rows.find((r) => r.id === recent.id);
    expect(row?.hasDocuments).toBe(true);
  });

  it("excludes archived students", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const archived = await insertStudentDirect(academyId, branchId, userId, {
      status: "archived",
    });

    const result = await getAdmissionsView(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).not.toContain(archived.id);
  });

  it("branch-limited caller only sees admissions candidates in their assigned branch(es)", async () => {
    const { academyId, userId, context } = await setupAcademy("admissions_officer");
    const assignedBranch = await insertBranchDirect(academyId);
    const otherBranch = await insertBranchDirect(academyId);
    await assignUserToBranches(academyId, userId, [assignedBranch]);

    const creatorId = await createUser();
    const inScope = await insertStudentDirect(academyId, assignedBranch, creatorId);
    await insertStudentDirect(academyId, otherBranch, creatorId);

    const result = await getAdmissionsView(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toEqual([inScope.id]);
  });
});

describe("getStudentDeletionEligibility / deleteStudent", () => {
  it("an unused student (zero enrollments/results/charges/payments/certificates) is eligible and deletes", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Unused Student" });

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(true);
      expect(eligibility.eligibility.reasons).toEqual([]);
    }

    const deleted = await deleteStudent(context, student.id, "Unused Student");
    expect(deleted.ok).toBe(true);

    const stillThere = await getStudent(context, student.id);
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.error.code).toBe("not_found");
  });

  it("a student with a batch enrollment is blocked from deletion, and nothing is deleted", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Enrolled Student" });
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await enrollStudentDirect(academyId, batchId, student.id);

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.enrollmentCount).toBe(1);
    }

    const deleted = await deleteStudent(context, student.id, "Enrolled Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");

    const stillThere = await getStudent(context, student.id);
    expect(stillThere.ok).toBe(true);
  });

  it("a student with an exam result is blocked from deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Exam Result Student" });
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await insertExamResultDirect(academyId, batchId, student.id, userId);

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.examResultCount).toBe(1);
    }

    const deleted = await deleteStudent(context, student.id, "Exam Result Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a student with a charge is blocked from deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Charged Student" });
    await insertChargeDirect(academyId, student.id, userId);

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.chargeCount).toBe(1);
    }

    const deleted = await deleteStudent(context, student.id, "Charged Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a student with a payment is blocked from deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Paid Student" });
    await insertPaymentDirect(academyId, student.id, userId);

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.paymentCount).toBe(1);
    }

    const deleted = await deleteStudent(context, student.id, "Paid Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("a student with a certificate is blocked from deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Certified Student" });
    const courseId = await insertProgramAndCourse(academyId);
    const batchId = await insertBatchDirect(academyId, branchId, courseId);
    await insertCertificateDirect(academyId, student.id, batchId, userId);

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) {
      expect(eligibility.eligibility.eligible).toBe(false);
      expect(eligibility.eligibility.certificateCount).toBe(1);
    }

    const deleted = await deleteStudent(context, student.id, "Certified Student");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error.code).toBe("ineligible");
  });

  it("rejects a wrong confirmation name, and nothing is deleted", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Type Me Exactly" });

    const result = await deleteStudent(context, student.id, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const stillThere = await getStudent(context, student.id);
    expect(stillThere.ok).toBe(true);
  });

  it.each<[AcademyRole, boolean]>([
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: delete allowed = %s (Admissions Officer's own-branch manage access does not extend to delete)", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(owner.academyId);
    const student = await insertStudentDirect(owner.academyId, branchId, owner.userId);

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    if (role === "trainer" || role === "admissions_officer") {
      await assignUserToBranches(owner.academyId, actingUserId, [branchId]);
    }
    const actingContext: AuthContext = { userId: actingUserId, branchIds: [], academyWide: false };

    const result = await deleteStudent(actingContext, student.id, student.fullName);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("never deletes another academy's student (tenant isolation)", async () => {
    const other = await setupAcademy("academy_owner");
    const otherBranch = await insertBranchDirect(other.academyId);
    const otherStudent = await insertStudentDirect(other.academyId, otherBranch, other.userId, {
      fullName: "Other Academy Student",
    });

    const { context } = await setupAcademy("academy_owner");
    const eligibility = await getStudentDeletionEligibility(context, otherStudent.id);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.error.code).toBe("not_found");

    const result = await deleteStudent(context, otherStudent.id, "Other Academy Student");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const stillThere = await getStudent(other.context, otherStudent.id);
    expect(stillThere.ok).toBe(true);
  });

  it("writes an audit row before deleting, and the audit row survives the deletion", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Audited Deletion" });

    const result = await deleteStudent(context, student.id, "Audited Deletion");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, student.id), eq(auditLogs.action, "deleteStudent")));
    expect(audit?.action).toBe("deleteStudent");
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.academyId).toBe(academyId);
  });

  it("race condition: a payment recorded after the eligibility check still blocks the delete transaction", async () => {
    const { academyId, userId, context } = await setupAcademy("academy_owner");
    const branchId = await insertBranchDirect(academyId);
    const student = await insertStudentDirect(academyId, branchId, userId, { fullName: "Race Condition Student" });

    const eligibility = await getStudentDeletionEligibility(context, student.id);
    expect(eligibility.ok).toBe(true);
    if (eligibility.ok) expect(eligibility.eligibility.eligible).toBe(true);

    // Simulates a concurrent payment landing between the UI's eligibility
    // preview and the actual delete call.
    await insertPaymentDirect(academyId, student.id, userId);

    const result = await deleteStudent(context, student.id, "Race Condition Student");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");

    const stillThere = await getStudent(context, student.id);
    expect(stillThere.ok).toBe(true);
  });
});
