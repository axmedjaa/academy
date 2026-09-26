import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

// Real Cloudflare R2 is never called from the test suite — mocking this
// shared boundary lets these tests verify the logo-cleanup integration
// (lib/academies/academy-logo.ts's own object key) without any real
// network call, same convention as lib/academies/academy-logo.test.ts.
vi.mock("@/lib/storage/client", () => ({ deleteObject: vi.fn() }));
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  branches,
  certificates,
  courses,
  examResults,
  exams,
  expenseRecords,
  gradeConfigurations,
  incomeRecords,
  programs,
  staffProfiles,
  studentCharges,
  studentPayments,
  students,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import { deleteObject } from "@/lib/storage/client";
import { deleteAcademy, getAcademyDeletionEligibility } from "./delete-academy";

const deleteObjectMock = vi.mocked(deleteObject);

beforeEach(() => {
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue({ ok: true });
});

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

function ownerContext(userId: string): AuthContext {
  return { userId, platformRole: "platform_owner", branchIds: [], academyWide: false };
}

function nonPlatformContext(userId: string): AuthContext {
  return { userId, branchIds: [], academyWide: false };
}

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `delete-academy-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Delete Academy Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
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

/** A bare academy with no dependents at all — the "never approved, nothing
 * in it" case (approved_at stays null). */
async function createBareAcademy(creatorUserId: string, name = `Delete Test Academy ${randomUUID()}`): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({ name, slug: `delete-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function closeAcademyDirect(academyId: string): Promise<void> {
  await db.update(academies).set({ closedAt: new Date() }).where(eq(academies.id, academyId));
}

/** A full set of disposable data — branch, program, course, batch, staff,
 * student, membership, subscription — with zero protected records, so the
 * whole tree should be removable. */
async function attachDisposableData(
  academyId: string,
  creatorUserId: string,
): Promise<void> {
  const [branch] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db
    .insert(courses)
    .values({ academyId, programId: program.id, name: `Course ${randomUUID()}` })
    .returning({ id: courses.id });
  await db.insert(batches).values({
    academyId,
    branchId: branch.id,
    courseId: course.id,
    name: `Batch ${randomUUID()}`,
    code: `B-${randomUUID().slice(0, 8)}`,
    startDate: "2026-01-01",
  });
  const staffUserId = await createUser();
  await db.insert(staffProfiles).values({ academyId, userId: staffUserId, fullName: "Test Staff", phone: "+1-555-0000" });
  await db.insert(academyMemberships).values({ userId: staffUserId, academyId, role: "trainer", status: "active" });
  await db.insert(students).values({
    academyId,
    branchId: branch.id,
    studentNumber: `STD-${randomUUID().slice(0, 8)}`,
    fullName: "Test Student",
    createdBy: creatorUserId,
  });

  const planId = await createPlan();
  await db.insert(academySubscriptions).values({ academyId, planId, status: "trial", createdBy: creatorUserId });
}

afterAll(async () => {
  await db.delete(auditLogs).where(
    // Belt-and-suspenders: some rows may already have academyId nulled by
    // the deletion itself, so also clean up by actorUserId.
    eq(auditLogs.actorUserId, createdUserIds[0] ?? "00000000-0000-0000-0000-000000000000"),
  );
  for (const userId of createdUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, userId));
  }
  // Any academy this suite failed to delete (a blocked-deletion test) still
  // needs its dependents cleaned up in FK order — deepest children first.
  for (const academyId of createdAcademyIds) {
    await db.delete(certificates).where(eq(certificates.academyId, academyId));
    await db.delete(examResults).where(eq(examResults.academyId, academyId));
    await db.delete(exams).where(eq(exams.academyId, academyId));
    await db.delete(gradeConfigurations).where(eq(gradeConfigurations.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));
    await db.delete(subscriptionPayments).where(eq(subscriptionPayments.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId)).catch(() => undefined);
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
  }
});

describe("deleteAcademy — authorization", () => {
  it("refuses an unauthenticated-shaped context (no platform role at all)", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const result = await deleteAcademy(nonPlatformContext(creatorId), academyId, "whatever");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it.each(["academy_owner", "academy_admin", "manager", "trainer"] as const)(
    "refuses a %s academy-level context — only platformRole grants this action",
    async (role) => {
      const creatorId = await createUser();
      const academyId = await createBareAcademy(creatorId);
      const staffUserId = await createUser();
      await db.insert(academyMemberships).values({ userId: staffUserId, academyId, role, status: "active" });

      // This context has an academy role but NO platformRole — exactly what
      // hasPermission() checks for this ungrantable capability.
      const result = await deleteAcademy(nonPlatformContext(staffUserId), academyId, "whatever");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");

      const [stillThere] = await db.select({ id: academies.id }).from(academies).where(eq(academies.id, academyId));
      expect(stillThere).toBeDefined();
    },
  );

  it("a platform_admin context (no platform_owner) is also refused — deleteAcademy is ungrantable", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const adminContext: AuthContext = { userId: creatorId, platformRole: "platform_admin", branchIds: [], academyWide: false };
    const result = await deleteAcademy(adminContext, academyId, "whatever");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("deleteAcademy — eligibility blockers", () => {
  it("refuses deletion when student charges exist", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const [branch] = await db.insert(branches).values({ academyId, name: "B", code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
    const [student] = await db
      .insert(students)
      .values({ academyId, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "S", createdBy: creatorId })
      .returning({ id: students.id });
    await db.insert(studentCharges).values({ academyId, studentId: student.id, description: "Fee", amountCents: 1000, currency: "USD", createdBy: creatorId });

    const result = await deleteAcademy(ownerContext(creatorId), academyId, (await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId)))[0].name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("refuses deletion when income records exist", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    await db.insert(incomeRecords).values({ academyId, category: "Registration Fees", description: "x", amountCents: 500, currency: "USD", recordedBy: creatorId });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("refuses deletion when expense records exist", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    await db.insert(expenseRecords).values({ academyId, category: "Salaries", description: "x", amountCents: 500, currency: "USD", submittedBy: creatorId });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("refuses deletion when subscription payments have been recorded", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const planId = await createPlan();
    const [subscription] = await db
      .insert(academySubscriptions)
      .values({ academyId, planId, status: "trial", createdBy: creatorId })
      .returning({ id: academySubscriptions.id });
    await db.insert(subscriptionPayments).values({
      academyId,
      subscriptionId: subscription.id,
      amountCents: 1000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      receivedAt: new Date(),
      recordedBy: creatorId,
    });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");

    // Untouched — the subscription itself must survive a refused deletion.
    const [stillThere] = await db.select({ id: academySubscriptions.id }).from(academySubscriptions).where(eq(academySubscriptions.id, subscription.id));
    expect(stillThere).toBeDefined();
  });

  it("refuses deletion when certificates have been issued", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const [branch] = await db.insert(branches).values({ academyId, name: "B", code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
    const [program] = await db.insert(programs).values({ academyId, name: "P" }).returning({ id: programs.id });
    const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: "C" }).returning({ id: courses.id });
    const [batch] = await db
      .insert(batches)
      .values({ academyId, branchId: branch.id, courseId: course.id, name: "B1", code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id });
    const [student] = await db
      .insert(students)
      .values({ academyId, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "S", createdBy: creatorId })
      .returning({ id: students.id });
    await db.insert(certificates).values({
      academyId,
      studentId: student.id,
      batchId: batch.id,
      certificateCode: `CERT-${randomUUID().slice(0, 10)}`,
      issuedBy: creatorId,
    });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });

  it("refuses deletion when exam results exist", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const [branch] = await db.insert(branches).values({ academyId, name: "B", code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
    const [program] = await db.insert(programs).values({ academyId, name: "P" }).returning({ id: programs.id });
    const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: "C" }).returning({ id: courses.id });
    const [batch] = await db
      .insert(batches)
      .values({ academyId, branchId: branch.id, courseId: course.id, name: "B1", code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id });
    const [student] = await db
      .insert(students)
      .values({ academyId, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "S", createdBy: creatorId })
      .returning({ id: students.id });
    const [exam] = await db
      .insert(exams)
      .values({ academyId, batchId: batch.id, name: "Final", maxMarks: "100" })
      .returning({ id: exams.id });
    const [gradeConfig] = await db
      .insert(gradeConfigurations)
      .values({ academyId, name: "Standard", createdBy: creatorId })
      .returning({ id: gradeConfigurations.id });
    await db.insert(examResults).values({
      academyId,
      examId: exam.id,
      studentId: student.id,
      batchId: batch.id,
      marksObtained: "80",
      gradeConfigurationId: gradeConfig.id,
      status: "draft",
      enteredBy: creatorId,
    });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ineligible");
  });
});

describe("deleteAcademy — safety", () => {
  it("returns not_found for a nonexistent academy id", async () => {
    const creatorId = await createUser();
    const result = await deleteAcademy(ownerContext(creatorId), randomUUID(), "whatever");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("refuses when the confirmed name doesn't match exactly, and leaves the academy untouched", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId, "Exact Name Academy");

    const result = await deleteAcademy(ownerContext(creatorId), academyId, "Wrong Name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const [stillThere] = await db.select({ id: academies.id }).from(academies).where(eq(academies.id, academyId));
    expect(stillThere).toBeDefined();
  });

  it("does not affect another academy's data (tenant isolation)", async () => {
    const creatorId = await createUser();
    const targetAcademyId = await createBareAcademy(creatorId);
    const otherAcademyId = await createBareAcademy(creatorId);
    await attachDisposableData(otherAcademyId, creatorId);

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, targetAcademyId));
    const result = await deleteAcademy(ownerContext(creatorId), targetAcademyId, name);
    expect(result.ok).toBe(true);

    const [otherStillThere] = await db.select({ id: academies.id }).from(academies).where(eq(academies.id, otherAcademyId));
    expect(otherStillThere).toBeDefined();
    const otherBranches = await db.select().from(branches).where(eq(branches.academyId, otherAcademyId));
    expect(otherBranches.length).toBeGreaterThan(0);
  });
});

describe("deleteAcademy — successful deletion", () => {
  it("deletes a never-approved (pending) academy with zero protected history, and all its disposable data", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    await attachDisposableData(academyId, creatorId);

    const eligibilityBefore = await getAcademyDeletionEligibility(ownerContext(creatorId), academyId);
    expect(eligibilityBefore.ok).toBe(true);
    if (eligibilityBefore.ok) expect(eligibilityBefore.eligibility.eligible).toBe(true);

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(true);

    const [academyRow] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(academyRow).toBeUndefined();

    const remainingBranches = await db.select().from(branches).where(eq(branches.academyId, academyId));
    const remainingCourses = await db.select().from(courses).where(eq(courses.academyId, academyId));
    const remainingPrograms = await db.select().from(programs).where(eq(programs.academyId, academyId));
    const remainingBatches = await db.select().from(batches).where(eq(batches.academyId, academyId));
    const remainingStaff = await db.select().from(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    const remainingStudents = await db.select().from(students).where(eq(students.academyId, academyId));
    const remainingMemberships = await db.select().from(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    const remainingSubscriptions = await db.select().from(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));

    expect(remainingBranches).toHaveLength(0);
    expect(remainingCourses).toHaveLength(0);
    expect(remainingPrograms).toHaveLength(0);
    expect(remainingBatches).toHaveLength(0);
    expect(remainingStaff).toHaveLength(0);
    expect(remainingStudents).toHaveLength(0);
    expect(remainingMemberships).toHaveLength(0);
    expect(remainingSubscriptions).toHaveLength(0);

    // The academy is gone from the tracked-for-cleanup list's perspective —
    // remove it so afterAll doesn't try to re-delete it.
    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);
  });

  it("deletes the academy's R2 logo object (if it had one) after the transaction commits", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    const logoKey = "academies/pre-existing/logos/x.png";
    await db.update(academies).set({ logoRef: logoKey }).where(eq(academies.id, academyId));

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(true);
    expect(deleteObjectMock).toHaveBeenCalledWith(logoKey);

    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);
  });

  it("never calls storage cleanup for an academy that never had a logo", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();

    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);
  });

  it("still completes the (already-committed, irreversible) deletion even if R2 cleanup fails", async () => {
    deleteObjectMock.mockResolvedValue({ ok: false, error: "boom" });
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    await db.update(academies).set({ logoRef: "academies/pre-existing/logos/x.png" }).where(eq(academies.id, academyId));

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(true);

    const [academyRow] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(academyRow).toBeUndefined();

    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);
  });

  it("deletes an already-closed academy with zero protected history", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);
    await closeAcademyDirect(academyId);

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const result = await deleteAcademy(ownerContext(creatorId), academyId, name);
    expect(result.ok).toBe(true);

    const [academyRow] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(academyRow).toBeUndefined();
    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);
  });

  it("preserves audit history: the deleteAcademy row (and any prior rows) survive with academy_id set to null", async () => {
    const creatorId = await createUser();
    const academyId = await createBareAcademy(creatorId);

    // A pre-existing audit row for this academy, from some earlier action.
    await db.insert(auditLogs).values({
      actorUserId: creatorId,
      academyId,
      action: "someEarlierAction",
      entityType: "academy",
      entityId: academyId,
    });

    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const ownerCtx = ownerContext(creatorId);
    const result = await deleteAcademy(ownerCtx, academyId, name);
    expect(result.ok).toBe(true);
    createdAcademyIds.splice(createdAcademyIds.indexOf(academyId), 1);

    const survivingRows = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, creatorId));
    const actions = survivingRows.map((r) => r.action);
    expect(actions).toContain("someEarlierAction");
    expect(actions).toContain("deleteAcademy");
    for (const row of survivingRows) {
      expect(row.academyId).toBeNull();
    }
  });
});
