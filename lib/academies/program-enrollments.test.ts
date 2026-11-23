import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchCourses,
  batchEnrollments,
  batches,
  branches,
  courses,
  enrollmentFeeSchedules,
  feePeriods,
  notifications,
  paymentAllocations,
  programEnrollments,
  programs,
  receipts,
  staffProfiles,
  studentCourseRefundPayments,
  studentCourseRefunds,
  studentPayments,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { createBatch, listBatches, updateBatch } from "./batches";
import { enrollStudentInBatch, withdrawStudentFromBatch } from "./batch-assignments";
import { listEnrollmentsForStudent, listFeePeriodsForEnrollment, recordEnrollmentPayment, setEnrollmentFeeSchedule } from "./fee-periods";
import { changeFeePlan, getFeePlanPosition } from "./fee-plan-change";
import { registerStudent } from "./register-student";
import { getFinanceReports } from "./finance-reports";
import { getFeeCollectionSummary, getProgramFeeCollectionSummary, listFeePeriodOverview } from "./fee-period-overview";
import { issueReceipt } from "./student-payments";
import { getReceiptPrintData } from "./receipt-print";
import { reverseStudentPayment } from "./finance-reversals";
import {
  enrollStudentInProgram,
  listStudentProgramEnrollments,
  programPaymentStatus,
  recordProgramPayment,
  withdrawFromProgram,
} from "./program-enrollments";

/**
 * Complete program enrollment (migration 0049): one program fee per program
 * enrollment, billed in monthly installments through the shared billing
 * engine; the program's courses are academic only (no course fees).
 *
 * The remote test database is slow, so each describe builds ONE fixture in
 * beforeAll and its tests share it, each using its own student.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `program-enroll-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function addMember(academyId: string, role: AcademyRole): Promise<AuthContext> {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
  return { userId, branchIds: [], academyWide: false };
}

interface Fixture {
  academyId: string;
  branchId: string;
  owner: AuthContext;
  programId: string;
  programCourseIds: string[];
  archivedCourseId: string;
  programBatchId: string;
  courseBatchId: string;
  courseBatchCourseId: string;
}

async function setupFixture(): Promise<Fixture> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Program Test Academy ${randomUUID()}`, slug: `program-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/program-enrollments.test.ts)",
      name: `Program Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 20,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  await db.insert(academySubscriptions).values({
    academyId: academy.id,
    planId: plan.id,
    status: "active",
    endsAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: creator,
  });
  const owner = await addMember(academy.id, "academy_owner");
  const [branch] = await db
    .insert(branches)
    .values({ academyId: academy.id, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });

  const [program] = await db.insert(programs).values({ academyId: academy.id, name: "Full Stack Development" }).returning({ id: programs.id });
  const programCourseIds: string[] = [];
  for (const name of ["HTML", "CSS", "JavaScript"]) {
    const [course] = await db.insert(courses).values({ academyId: academy.id, programId: program.id, name }).returning({ id: courses.id });
    programCourseIds.push(course.id);
  }
  const [archived] = await db
    .insert(courses)
    .values({ academyId: academy.id, programId: program.id, name: "Old Course", status: "archived" })
    .returning({ id: courses.id });

  const programBatch = await createBatch(owner, {
    branchId: branch.id,
    courseIds: [programCourseIds[0]],
    programId: program.id,
    name: "Full Stack 2026",
    code: `FS-${randomUUID().slice(0, 6)}`,
  });
  if (!programBatch.ok) throw new Error(`program batch: ${programBatch.error.message}`);

  // A separate single-course program for the course-based batch.
  const [otherProgram] = await db.insert(programs).values({ academyId: academy.id, name: "Short Courses" }).returning({ id: programs.id });
  const [javaCourse] = await db.insert(courses).values({ academyId: academy.id, programId: otherProgram.id, name: "Java" }).returning({ id: courses.id });
  const courseBatch = await createBatch(owner, {
    branchId: branch.id,
    courseIds: [javaCourse.id],
    name: "1232",
    code: `CB-${randomUUID().slice(0, 6)}`,
  });
  if (!courseBatch.ok) throw new Error(`course batch: ${courseBatch.error.message}`);

  return {
    academyId: academy.id,
    branchId: branch.id,
    owner,
    programId: program.id,
    programCourseIds,
    archivedCourseId: archived.id,
    programBatchId: programBatch.batch.id,
    courseBatchId: courseBatch.batch.id,
    courseBatchCourseId: javaCourse.id,
  };
}

async function newStudent(f: Fixture): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId: f.academyId, branchId: f.branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Ahmed", createdBy: f.owner.userId })
    .returning({ id: students.id });
  return row.id;
}

/** $480 over 12 months by default (the brief's example). */
async function enroll(f: Fixture, studentId: string, overrides: Partial<Parameters<typeof enrollStudentInProgram>[1]> = {}) {
  return enrollStudentInProgram(f.owner, {
    studentId,
    batchId: f.programBatchId,
    programFeeCents: 48_000,
    discountCents: 0,
    installments: 12,
    anchorDate: "2026-10-09",
    ...overrides,
  });
}

async function billingOf(f: Fixture, studentId: string, actor: AuthContext = f.owner) {
  const listed = await listStudentProgramEnrollments(actor, studentId);
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.enrollments[0]?.billing ?? null;
}

const pay = (f: Fixture, programEnrollmentId: string, amountCents: number, extra: { idempotencyKey?: string; method?: "cash" | "mobile_money" | "bank_transfer" } = {}) =>
  recordProgramPayment(f.owner, {
    programEnrollmentId,
    amountCents,
    method: extra.method ?? "cash",
    receivedAt: new Date().toISOString(),
    idempotencyKey: extra.idempotencyKey,
  });

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  // Payments raise in-app notifications; they reference the academy.
  if (createdAcademyIds.length > 0) await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  for (const academyId of createdAcademyIds) {
    const refundIds = (await db.select({ id: studentCourseRefunds.id }).from(studentCourseRefunds).where(eq(studentCourseRefunds.academyId, academyId))).map((r) => r.id);
    if (refundIds.length) await db.delete(studentCourseRefundPayments).where(inArray(studentCourseRefundPayments.refundId, refundIds));
    await db.delete(studentCourseRefunds).where(eq(studentCourseRefunds.academyId, academyId));
    await db.delete(receipts).where(eq(receipts.academyId, academyId));
    await db.delete(paymentAllocations).where(eq(paymentAllocations.academyId, academyId));
    // Reversal rows point at their originals: delete them first.
    await db.delete(studentPayments).where(and(eq(studentPayments.academyId, academyId), isNotNull(studentPayments.reversedPaymentId)));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(feePeriods).where(eq(feePeriods.academyId, academyId));
    await db.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(programEnrollments).where(eq(programEnrollments.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(batchCourses).where(eq(batchCourses.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) await db.delete(academies).where(eq(academies.id, academyId));
  for (const planId of createdPlanIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of createdUserIds) await db.delete(users).where(eq(users.id, userId));
}, 300_000);

let f: Fixture;
let other: Fixture;
beforeAll(async () => {
  f = await setupFixture();
  other = await setupFixture();
}, 120_000);

describe("program-based batches", () => {
  it("takes the program's active courses (never archived ones, never the client's list) and keeps the program link", async () => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, f.programBatchId));
    expect(batch.programId).toBe(f.programId);
    const rows = await db.select({ courseId: batchCourses.courseId }).from(batchCourses).where(eq(batchCourses.batchId, f.programBatchId));
    expect(rows.map((row) => row.courseId).sort()).toEqual([...f.programCourseIds].sort());
    expect(rows.some((row) => row.courseId === f.archivedCourseId)).toBe(false);
  });

  it("refuses another academy's program", async () => {
    const result = await createBatch(f.owner, {
      branchId: f.branchId,
      courseIds: [f.programCourseIds[0]],
      programId: other.programId,
      name: "Stolen",
      code: `X-${randomUUID().slice(0, 6)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("a program batch can't be used for individual course enrollment", async () => {
    const studentId = await newStudent(f);
    const result = await enrollStudentInBatch(f.owner, {
      batchId: f.programBatchId,
      studentId,
      courseIds: [f.programCourseIds[0]],
      paymentPlan: { intervalMonths: 1, amountCents: 1000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("enrollStudentInProgram — one program fee, academic courses", () => {
  it("$480 over 12 months: 12 installments of $40, one schedule on the program, course enrollments with no fees", async () => {
    const studentId = await newStudent(f);
    const result = await enroll(f, studentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalFeeCents).toBe(48_000);
    expect(result.installmentCents).toEqual(new Array(12).fill(4_000));
    expect(result.courseEnrollmentIds).toHaveLength(3);

    const schedules = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.programEnrollmentId, result.enrollment.id));
    expect(schedules).toHaveLength(1);
    expect(schedules[0].enrollmentId).toBeNull();
    const periods = await db.select().from(feePeriods).where(eq(feePeriods.programEnrollmentId, result.enrollment.id));
    expect(periods).toHaveLength(12);
    expect(periods.reduce((sum, p) => sum + p.expectedAmountCents, 0)).toBe(48_000);
    expect(periods.map((p) => p.periodStart).sort()[0]).toBe("2026-10-09");

    // No duplicate course-level charges for program students.
    const courseRows = await db.select().from(batchEnrollments).where(eq(batchEnrollments.programEnrollmentId, result.enrollment.id));
    expect(courseRows.map((row) => row.courseId).sort()).toEqual([...f.programCourseIds].sort());
    const courseSchedules = await db
      .select()
      .from(enrollmentFeeSchedules)
      .where(inArray(enrollmentFeeSchedules.enrollmentId, courseRows.map((row) => row.id)));
    const coursePeriods = await db.select().from(feePeriods).where(inArray(feePeriods.enrollmentId, courseRows.map((row) => row.id)));
    expect(courseSchedules).toHaveLength(0);
    expect(coursePeriods).toHaveLength(0);

    const billing = await billingOf(f, studentId);
    expect(billing?.status).toBe("unpaid");
    expect(billing?.outstandingCents).toBe(48_000);
    expect(billing?.paidCents).toBe(0);
  });

  it("discount and rounding: installments sum exactly to fee − discount", async () => {
    const studentId = await newStudent(f);
    const result = await enroll(f, studentId, { programFeeCents: 50_000, discountCents: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalFeeCents).toBe(49_000);
    expect(result.installmentCents.slice(0, 11)).toEqual(new Array(11).fill(4_083));
    expect(result.installmentCents[11]).toBe(49_000 - 4_083 * 11);
    expect(result.installmentCents.reduce((a, b) => a + b, 0)).toBe(49_000);
    const billing = await billingOf(f, studentId);
    expect(billing?.programFeeCents).toBe(50_000);
    expect(billing?.discountCents).toBe(1_000);
    expect(billing?.finalFeeCents).toBe(49_000);
  });

  it("refuses a discount equal to or above the fee, and a duplicate active program enrollment", async () => {
    const studentId = await newStudent(f);
    const tooMuch = await enroll(f, studentId, { programFeeCents: 10_000, discountCents: 10_000 });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.error.code).toBe("validation");

    expect((await enroll(f, studentId)).ok).toBe(true);
    const again = await enroll(f, studentId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("conflict");
  });

  it("refuses a separate course fee plan on a course taken as part of the program", async () => {
    const studentId = await newStudent(f);
    const result = await enroll(f, studentId);
    if (!result.ok) throw new Error(result.error.message);
    const refused = await setEnrollmentFeeSchedule(f.owner, {
      enrollmentId: result.courseEnrollmentIds[0],
      intervalMonths: 1,
      amountCents: 1_000,
      anchorDate: "2026-10-09",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("validation");
  });

  it("individual course enrollment is unchanged: course fee schedule on the course enrollment", async () => {
    const studentId = await newStudent(f);
    const result = await enrollStudentInBatch(f.owner, {
      batchId: f.courseBatchId,
      studentId,
      courseIds: [f.courseBatchCourseId],
      paymentPlan: { intervalMonths: 2, amountCents: 10_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [schedule] = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.enrollmentId, result.enrollment.id));
    expect(schedule.amountCents).toBe(10_000);
    expect(schedule.programEnrollmentId).toBeNull();
    expect(result.enrollment.id).toBeTruthy();
  });
});

describe("program payments", () => {
  it("first, subsequent, partial and full payments; overpayment refused; status and balance follow", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const id = enrolled.enrollment.id;

    const first = await pay(f, id, 4_000, { method: "mobile_money" });
    expect(first.ok).toBe(true);
    let billing = await billingOf(f, studentId);
    expect(billing?.status).toBe("partially_paid");
    expect(billing?.paidCents).toBe(4_000);
    expect(billing?.outstandingCents).toBe(44_000);
    expect(billing?.periods[0].status).toBe("paid");
    expect(billing?.periods[1].paidCents).toBe(0);

    const partial = await pay(f, id, 1_500);
    expect(partial.ok).toBe(true);
    billing = await billingOf(f, studentId);
    expect(billing?.periods[1].paidCents).toBe(1_500);
    expect(billing?.outstandingCents).toBe(42_500);

    const over = await pay(f, id, 42_501);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("conflict");

    const rest = await pay(f, id, 42_500, { method: "bank_transfer" });
    expect(rest.ok).toBe(true);
    billing = await billingOf(f, studentId);
    expect(billing?.status).toBe("paid");
    expect(billing?.outstandingCents).toBe(0);
    expect(billing?.payments).toHaveLength(3);
    expect(new Set(billing?.payments.map((p) => p.method))).toEqual(new Set(["mobile_money", "cash", "bank_transfer"]));

    const nothingLeft = await pay(f, id, 100);
    expect(nothingLeft.ok).toBe(false);
    if (!nothingLeft.ok) expect(nothingLeft.error.code).toBe("validation");
  });

  it("a retried submission (same key) records one payment only", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const key = randomUUID();
    const a = await pay(f, enrolled.enrollment.id, 4_000, { idempotencyKey: key });
    const b = await pay(f, enrolled.enrollment.id, 4_000, { idempotencyKey: key });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.payment.id).toBe(a.payment.id);
      expect(b.duplicate).toBe(true);
    }
    const reused = await pay(f, enrolled.enrollment.id, 3_000, { idempotencyKey: key });
    expect(reused.ok).toBe(false);
    expect((await billingOf(f, studentId))?.paidCents).toBe(4_000);
  });

  it("an initial payment at registration is recorded against the program, never assumed", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId, {
      initialPayment: { amountCents: 8_000, method: "cash", receivedAt: new Date().toISOString() },
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    expect(enrolled.initialPaymentId).toBeTruthy();
    const billing = await billingOf(f, studentId);
    expect(billing?.paidCents).toBe(8_000);
    expect(billing?.periods.slice(0, 2).every((p) => p.status === "paid")).toBe(true);
  });

  it("receipts name the program; a reversal takes the money back off the balance", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const paid = await pay(f, enrolled.enrollment.id, 4_000);
    if (!paid.ok) throw new Error(paid.error.message);

    const receipt = await issueReceipt(f.owner, paid.payment.id);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      const printed = await getReceiptPrintData(f.owner, receipt.receipt.id);
      expect(printed.ok).toBe(true);
      if (printed.ok) expect(printed.data.description).toContain("Program: Full Stack Development");
    }

    const reversed = await reverseStudentPayment(f.owner, paid.payment.id, "Recorded in error.");
    expect(reversed.ok).toBe(true);
    const billing = await billingOf(f, studentId);
    expect(billing?.paidCents).toBe(0);
    expect(billing?.status).toBe("unpaid");
  });

  it("programPaymentStatus: unpaid / partially paid / paid", () => {
    expect(programPaymentStatus(48_000, 0)).toBe("unpaid");
    expect(programPaymentStatus(48_000, 4_000)).toBe("partially_paid");
    expect(programPaymentStatus(48_000, 48_000)).toBe("paid");
  });
});

describe("withdraw with refund", () => {
  it("refunds at most what was paid, records it on the program, and withdraws the program and its courses", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const id = enrolled.enrollment.id;
    await pay(f, id, 8_000);

    const tooMuch = await withdrawFromProgram(f.owner, {
      programEnrollmentId: id,
      reason: "Moving away",
      refund: { amountCents: 8_001, method: "cash", refundedAt: "2026-10-20", reason: "Refund", idempotencyKey: randomUUID() },
    });
    expect(tooMuch.ok).toBe(false);

    const done = await withdrawFromProgram(f.owner, {
      programEnrollmentId: id,
      reason: "Moving away",
      refund: { amountCents: 5_000, method: "cash", refundedAt: "2026-10-20", reason: "Refund", idempotencyKey: randomUUID() },
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const [refund] = await db.select().from(studentCourseRefunds).where(eq(studentCourseRefunds.id, done.refundId!));
    expect(refund.programEnrollmentId).toBe(id);
    expect(refund.enrollmentId).toBeNull();
    expect(refund.amountCents).toBe(5_000);

    const [program] = await db.select().from(programEnrollments).where(eq(programEnrollments.id, id));
    expect(program.status).toBe("withdrawn");
    const coursesLeft = await db
      .select()
      .from(batchEnrollments)
      .where(and(eq(batchEnrollments.programEnrollmentId, id), eq(batchEnrollments.status, "active")));
    expect(coursesLeft).toHaveLength(0);
    // Original payments are kept as they were.
    expect((await billingOf(f, studentId))?.paidCents).toBe(8_000);
  });
});

describe("authorization and tenant isolation", () => {
  it("a trainer can't enroll or record payments", async () => {
    const trainer = await addMember(f.academyId, "trainer");
    const studentId = await newStudent(f);
    const enrolled = await enrollStudentInProgram(trainer, { studentId, batchId: f.programBatchId, programFeeCents: 1_000, installments: 1 });
    expect(enrolled.ok).toBe(false);
    if (!enrolled.ok) expect(enrolled.error.code).toBe("forbidden");

    const real = await enroll(f, studentId);
    if (!real.ok) throw new Error(real.error.message);
    const paid = await recordProgramPayment(trainer, { programEnrollmentId: real.enrollment.id, amountCents: 100, method: "cash", receivedAt: new Date().toISOString() });
    expect(paid.ok).toBe(false);
    if (!paid.ok) expect(paid.error.code).toBe("forbidden");
  });

  it("another academy can't see, pay into, enroll into, or withdraw this academy's program enrollments", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);

    const paid = await recordProgramPayment(other.owner, { programEnrollmentId: enrolled.enrollment.id, amountCents: 4_000, method: "cash", receivedAt: new Date().toISOString() });
    expect(paid.ok).toBe(false);
    if (!paid.ok) expect(paid.error.code).toBe("not_found");

    const listed = await listStudentProgramEnrollments(other.owner, studentId);
    expect(listed.ok && listed.enrollments.length).toBe(0);

    const intoForeignBatch = await enrollStudentInProgram(other.owner, {
      studentId: await newStudent(other),
      batchId: f.programBatchId,
      programFeeCents: 1_000,
      installments: 1,
    });
    expect(intoForeignBatch.ok).toBe(false);
    if (!intoForeignBatch.ok) expect(intoForeignBatch.error.code).toBe("not_found");

    const foreignStudent = await enrollStudentInProgram(other.owner, {
      studentId,
      batchId: other.programBatchId,
      programFeeCents: 1_000,
      installments: 1,
    });
    expect(foreignStudent.ok).toBe(false);

    const withdrawn = await withdrawFromProgram(other.owner, { programEnrollmentId: enrolled.enrollment.id, reason: "x" });
    expect(withdrawn.ok).toBe(false);
    if (!withdrawn.ok) expect(withdrawn.error.code).toBe("not_found");
    expect((await billingOf(f, studentId))?.paidCents).toBe(0);
  });
});

describe("Stage 6 — finance reports keep program fees apart", () => {
  // Its own academy, so the report totals contain only what this test adds.
  let r: Fixture;
  beforeAll(async () => {
    r = await setupFixture();
  }, 120_000);

  it("splits payments by source exactly once, reports program balances apart from course fees, and stays tenant-scoped", async () => {
    // Complete program: $480 over 12 months, two installments paid.
    const programStudent = await newStudent(r);
    const enrolled = await enroll(r, programStudent);
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    expect((await pay(r, enrolled.enrollment.id, 4_000)).ok).toBe(true);
    expect((await pay(r, enrolled.enrollment.id, 4_000, { method: "mobile_money" })).ok).toBe(true);

    // Individual course: $30 a month, one $30 payment.
    const courseStudent = await newStudent(r);
    const course = await enrollStudentInBatch(r.owner, {
      batchId: r.courseBatchId,
      studentId: courseStudent,
      courseIds: [r.courseBatchCourseId],
      paymentPlan: { intervalMonths: 1, amountCents: 3_000 },
    });
    expect(course.ok).toBe(true);
    if (!course.ok) return;
    const coursePaid = await recordEnrollmentPayment(r.owner, {
      studentId: courseStudent,
      enrollmentId: course.enrollment.id,
      amountCents: 3_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(coursePaid.ok).toBe(true);

    const report = await getFinanceReports(r.owner);
    expect(report.ok).toBe(true);
    if (!report.ok || !report.report.studentPayments.visible) throw new Error("report not visible");
    const received = report.report.studentPayments.paymentsReceived;
    // Totals unchanged by the split: every approved payment, once.
    expect(received.totalsByCurrency).toEqual([{ currency: "USD", amountCents: 11_000, count: 3 }]);
    const bySource = Object.fromEntries(received.bySource.map((row) => [row.source, { amountCents: row.amountCents, count: row.count }]));
    expect(bySource).toEqual({ program: { amountCents: 8_000, count: 2 }, course: { amountCents: 3_000, count: 1 } });
    expect(received.bySource.reduce((sum, row) => sum + row.amountCents, 0)).toBe(11_000);

    // Program balance: the ONE program fee, with nothing from course fees in it.
    const program = await getProgramFeeCollectionSummary(r.owner);
    expect(program.ok).toBe(true);
    if (!program.ok) return;
    expect(program.totals).toHaveLength(1);
    const [totals] = program.totals;
    expect(totals.finalFeeCents).toBe(48_000);
    expect(totals.enrollments).toBe(1);
    expect(totals.collectedCents).toBe(8_000);
    expect(totals.collectedCents + totals.overdueCents + totals.notYetDueCents).toBe(48_000);
    expect(program.byProgram.map((row) => [row.programName, row.finalFeeCents, row.collectedCents])).toEqual([["Full Stack Development", 48_000, 8_000]]);

    // Course fee collection never sees a program installment (no double count).
    const courseFees = await getFeeCollectionSummary(r.owner);
    expect(courseFees.ok).toBe(true);
    if (!courseFees.ok) return;
    expect(courseFees.totals.reduce((sum, row) => sum + row.collectedCents, 0)).toBe(3_000);

    // Tenant isolation: another academy's owner sees none of it.
    const foreign = await getProgramFeeCollectionSummary(other.owner);
    expect(foreign.ok).toBe(true);
    if (foreign.ok) expect(foreign.byProgram.some((row) => row.programId === r.programId)).toBe(false);

    // A Trainer has no fee-period access at all.
    const trainer = await addMember(r.academyId, "trainer");
    const trainerView = await getProgramFeeCollectionSummary(trainer);
    expect(trainerView.ok).toBe(false);
  });
});

describe("batch status and program enrollment eligibility", () => {
  it("a program batch takes enrollments while Planned or Active, refuses them when Completed, and again once set back", async () => {
    const [batch] = await db.select().from(batches).where(eq(batches.id, f.programBatchId));
    const edit = (status: "planned" | "active" | "completed") =>
      updateBatch(f.owner, f.programBatchId, { branchId: batch.branchId, courseIds: [batch.courseId], name: batch.name, code: batch.code, status });

    expect(await edit("completed")).toMatchObject({ ok: true, batch: { status: "completed" } });
    const refused = await enroll(f, await newStudent(f));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/not open for enrollment/);

    expect(await edit("planned")).toMatchObject({ ok: true, batch: { status: "planned" } });
    expect((await enroll(f, await newStudent(f))).ok).toBe(true);
    expect(await edit("active")).toMatchObject({ ok: true, batch: { status: "active" } });
    expect((await enroll(f, await newStudent(f))).ok).toBe(true);
  });
});

describe("program courses leave only with their program", () => {
  it("refuses to withdraw one course of a program enrollment on its own; the course and the program stay active", async () => {
    const enrolled = await enroll(f, await newStudent(f));
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const [courseRow] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.programEnrollmentId, enrolled.enrollment.id));
    const refused = await withdrawStudentFromBatch(f.owner, courseRow.id, { reason: "Trying one course only" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/part of a complete program/);
    const [after] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, courseRow.id));
    expect(after.status).toBe("active");
  });

  it("the student's enrollment list carries the program link the page uses to hide Withdraw", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const listed = await listEnrollmentsForStudent(f.owner, studentId);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.enrollments.length).toBeGreaterThan(0);
    expect(listed.enrollments.every((e) => e.programEnrollmentId === enrolled.enrollment.id)).toBe(true);
  });

  it("a member without withdraw rights is still refused (permission checked before anything else)", async () => {
    const enrolled = await enroll(f, await newStudent(f));
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const [courseRow] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.programEnrollmentId, enrolled.enrollment.id));
    // A trainer with no branch in this academy (Admissions Officer is retired).
    const viewer = await addMember(f.academyId, "trainer");
    const refused = await withdrawStudentFromBatch(viewer, courseRow.id, { reason: "Not allowed" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(["forbidden", "not_found"]).toContain(refused.error.code);
    const [after] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, courseRow.id));
    expect(after.status).toBe("active");
  });

  it("an individually enrolled course can still be withdrawn on its own", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enrollStudentInBatch(f.owner, {
      batchId: f.courseBatchId,
      studentId,
      courseIds: [f.courseBatchCourseId],
      paymentPlan: { intervalMonths: 1, amountCents: 5_000 },
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect(enrolled.enrollment.programEnrollmentId).toBeNull();
    const withdrawn = await withdrawStudentFromBatch(f.owner, enrolled.enrollment.id, { reason: "Changed plans" });
    expect(withdrawn.ok).toBe(true);
    const [after] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, enrolled.enrollment.id));
    expect(after.status).toBe("withdrawn");
  });

  it("Withdraw from program still withdraws the program and all its courses together", async () => {
    const enrolled = await enroll(f, await newStudent(f));
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const done = await withdrawFromProgram(f.owner, { programEnrollmentId: enrolled.enrollment.id, reason: "Left the program" });
    expect(done.ok).toBe(true);
    const rows = await db.select().from(batchEnrollments).where(eq(batchEnrollments.programEnrollmentId, enrolled.enrollment.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "withdrawn")).toBe(true);
    const [program] = await db.select().from(programEnrollments).where(eq(programEnrollments.id, enrolled.enrollment.id));
    expect(program.status).toBe("withdrawn");
  });
});

describe("Fee periods page — a program student is ONE row with the program fee", () => {
  it("shows the program fee and its payments (Paid once fully paid); the program's courses get no row of their own", async () => {
    const studentId = await newStudent(f);
    const [{ studentNumber }] = await db.select({ studentNumber: students.studentNumber }).from(students).where(eq(students.id, studentId));
    // $45 in 3 monthly installments from 2026-10-09: two have started by now.
    const enrolled = await enroll(f, studentId, { programFeeCents: 4_500, installments: 3 });
    if (!enrolled.ok) throw new Error(enrolled.error.message);

    const before = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber });
    if (!before.ok) throw new Error(before.error.message);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({ kind: "program", enrollmentId: enrolled.enrollment.id, courseName: "Full Stack Development", paidCents: 0 });
    expect(before.rows[0].schedule).toMatchObject({ amountCents: 4_500, intervalMonths: 3 });
    expect(before.rows[0].status).not.toBe("paid");

    const paid = await pay(f, enrolled.enrollment.id, 4_500);
    expect(paid.ok).toBe(true);
    const after = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber });
    if (!after.ok) throw new Error(after.error.message);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].status).toBe("paid");
    expect(after.rows[0].paidCents).toBe(after.rows[0].dueCents);
    expect(after.rows[0].remainingCents).toBe(0);

    const paidFilter = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber, status: "paid" });
    const unpaidFilter = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber, status: "unpaid" });
    expect(paidFilter.ok && paidFilter.rows.length).toBe(1);
    expect(unpaidFilter.ok && unpaidFilter.rows.length).toBe(0);
  });

  it("an individual course enrollment still shows its own course row", async () => {
    const studentId = await newStudent(f);
    const [{ studentNumber }] = await db.select({ studentNumber: students.studentNumber }).from(students).where(eq(students.id, studentId));
    const enrolled = await enrollStudentInBatch(f.owner, {
      batchId: f.courseBatchId,
      studentId,
      courseIds: [f.courseBatchCourseId],
      paymentPlan: { intervalMonths: 1, amountCents: 2_000 },
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const listed = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.rows.map((row) => [row.kind, row.courseName])).toEqual([["course", "Java"]]);
  });
});

describe("Edit batch — type and program change only while no student is enrolled", () => {
  it("an empty batch can switch program -> course-based -> program; a batch with students can't", async () => {
    const created = await createBatch(f.owner, {
      branchId: f.branchId,
      courseIds: [f.programCourseIds[0]],
      programId: f.programId,
      name: "Empty program batch",
      code: `EP-${randomUUID().slice(0, 6)}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.batch.id;
    const base = { branchId: f.branchId, name: "Empty program batch", code: created.batch.code };
    const listedFlag = async (batchId: string) => {
      const listed = await listBatches(f.owner);
      if (!listed.ok) throw new Error(listed.error.message);
      return listed.batches.find((b) => b.id === batchId)?.hasEnrollments;
    };
    expect(await listedFlag(id)).toBe(false);

    const toCourse = await updateBatch(f.owner, id, { ...base, batchType: "course", courseIds: [f.courseBatchCourseId] });
    expect(toCourse.ok).toBe(true);
    let [row] = await db.select().from(batches).where(eq(batches.id, id));
    expect(row.programId).toBeNull();
    let courseRows = await db.select({ courseId: batchCourses.courseId }).from(batchCourses).where(eq(batchCourses.batchId, id));
    expect(courseRows.map((r) => r.courseId)).toEqual([f.courseBatchCourseId]);

    const toProgram = await updateBatch(f.owner, id, { ...base, batchType: "program", programId: f.programId, courseIds: [f.courseBatchCourseId] });
    expect(toProgram.ok).toBe(true);
    [row] = await db.select().from(batches).where(eq(batches.id, id));
    expect(row.programId).toBe(f.programId);
    courseRows = await db.select({ courseId: batchCourses.courseId }).from(batchCourses).where(eq(batchCourses.batchId, id));
    expect(courseRows.map((r) => r.courseId).sort()).toEqual([...f.programCourseIds].sort());

    // Without a batch type the batch keeps its type and program (older callers).
    const keep = await updateBatch(f.owner, id, { ...base, name: "Renamed", courseIds: [f.programCourseIds[0]] });
    expect(keep.ok).toBe(true);
    [row] = await db.select().from(batches).where(eq(batches.id, id));
    expect(row.programId).toBe(f.programId);

    // A batch with a program student keeps its type and program.
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId, { batchId: id });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect(await listedFlag(id)).toBe(true);
    const refused = await updateBatch(f.owner, id, { ...base, batchType: "course", courseIds: [f.courseBatchCourseId] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("conflict");
      expect(refused.error.message).toMatch(/type and program can't change/);
    }
    [row] = await db.select().from(batches).where(eq(batches.id, id));
    expect(row.programId).toBe(f.programId);
  });

  it("refuses switching to another academy's program", async () => {
    const created = await createBatch(f.owner, {
      branchId: f.branchId,
      courseIds: [f.courseBatchCourseId],
      name: "Empty course batch",
      code: `EC-${randomUUID().slice(0, 6)}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const result = await updateBatch(f.owner, created.batch.id, {
      branchId: f.branchId,
      name: "Empty course batch",
      code: created.batch.code,
      batchType: "program",
      programId: other.programId,
      courseIds: [f.courseBatchCourseId],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("scholarships, Change fee and the registration note (migration 0057)", () => {
  const periodsOf = (programEnrollmentId: string) =>
    db.select().from(feePeriods).where(eq(feePeriods.programEnrollmentId, programEnrollmentId)).orderBy(feePeriods.periodStart);

  it("a full-scholarship program is free: no schedule, no installments, settled on Fee periods", async () => {
    const studentId = await newStudent(f);
    const [{ studentNumber }] = await db.select({ studentNumber: students.studentNumber }).from(students).where(eq(students.id, studentId));
    const refused = await enroll(f, studentId, { scholarship: "full", initialPayment: { amountCents: 1_000, method: "cash", receivedAt: new Date().toISOString() } });
    expect(refused.ok).toBe(false);

    const enrolled = await enroll(f, studentId, { scholarship: "full", programFeeCents: 0 });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect(enrolled.enrollment.scholarship).toBe("full");
    expect(enrolled.finalFeeCents).toBe(0);
    expect(await periodsOf(enrolled.enrollment.id)).toHaveLength(0);
    const schedules = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.programEnrollmentId, enrolled.enrollment.id));
    expect(schedules).toHaveLength(0);

    const billing = await billingOf(f, studentId);
    expect(billing).toMatchObject({ finalFeeCents: 0, outstandingCents: 0, status: "paid" });
    const listed = await listFeePeriodOverview(f.owner, { searchTerm: studentNumber });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({ kind: "program", scholarship: "full", status: "paid", schedule: null });
  });

  it("a partial scholarship needs an amount off the fee and is recorded", async () => {
    const studentId = await newStudent(f);
    expect((await enroll(f, studentId, { scholarship: "partial", discountCents: 0 })).ok).toBe(false);
    const enrolled = await enroll(f, studentId, { scholarship: "partial", discountCents: 12_000 });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect(enrolled.enrollment.scholarship).toBe("partial");
    expect(enrolled.finalFeeCents).toBe(36_000);
  });

  it("a full-scholarship course enrollment has no fee plan", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enrollStudentInBatch(f.owner, { batchId: f.courseBatchId, studentId, courseIds: [f.courseBatchCourseId], scholarship: "full" });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect(enrolled.enrollment.scholarship).toBe("full");
    const schedules = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.enrollmentId, enrolled.enrollment.id));
    expect(schedules).toHaveLength(0);
    const listed = await listEnrollmentsForStudent(f.owner, studentId);
    expect(listed.ok && listed.enrollments[0].scholarship).toBe("full");
    // Without a scholarship the plan is still required.
    const other = await newStudent(f);
    expect((await enrollStudentInBatch(f.owner, { batchId: f.courseBatchId, studentId: other, courseIds: [f.courseBatchCourseId] })).ok).toBe(false);
  });

  it("Change fee on a program keeps what was paid and spreads the rest of the new fee", async () => {
    const studentId = await newStudent(f);
    // $480 in 12 x $40 from 2026-10-09; $50 paid = installment 1 + $10 of installment 2.
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    expect((await pay(f, enrolled.enrollment.id, 5_000)).ok).toBe(true);
    const target = { kind: "program" as const, programEnrollmentId: enrolled.enrollment.id };

    const position = await getFeePlanPosition(f.owner, target);
    expect(position.ok && position.position).toMatchObject({ feeCents: 48_000, discountCents: 0, installments: 12, paidCents: 5_000, scholarship: null });

    // More already paid than the new fee: refused, nothing changes.
    const tooLow = await changeFeePlan(f.owner, { target, scholarship: "none", feeCents: 4_000, installments: 1 });
    expect(tooLow.ok).toBe(false);
    expect(await periodsOf(enrolled.enrollment.id)).toHaveLength(12);

    const changed = await changeFeePlan(f.owner, { target, scholarship: "none", feeCents: 30_000, installments: 3 });
    if (!changed.ok) throw new Error(changed.error.message);
    expect(changed).toMatchObject({ finalFeeCents: 30_000, keptCents: 5_000, plannedCents: 25_000, installmentCents: [8_333, 8_333, 8_334] });

    const periods = await periodsOf(enrolled.enrollment.id);
    expect(periods.map((p) => [p.periodStart, p.expectedAmountCents])).toEqual([
      ["2026-10-09", 4_000],
      ["2026-11-09", 1_000],
      ["2026-12-09", 8_333],
      ["2027-01-09", 8_333],
      ["2027-02-09", 8_334],
    ]);
    const billing = await billingOf(f, studentId);
    expect(billing).toMatchObject({ finalFeeCents: 30_000, paidCents: 5_000, outstandingCents: 25_000, programFeeCents: 30_000 });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, enrolled.enrollment.id), eq(auditLogs.action, "changeEnrollmentFee")));
    expect(audit).toBeDefined();
  }, 90_000);

  it("Change fee to a full scholarship removes the unpaid plan", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId, { programFeeCents: 9_000, installments: 3 });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const changed = await changeFeePlan(f.owner, { target: { kind: "program", programEnrollmentId: enrolled.enrollment.id }, scholarship: "full", installments: 1 });
    if (!changed.ok) throw new Error(changed.error.message);
    expect(await periodsOf(enrolled.enrollment.id)).toHaveLength(0);
    const [row] = await db.select().from(programEnrollments).where(eq(programEnrollments.id, enrolled.enrollment.id));
    expect(row.scholarship).toBe("full");
    expect(await billingOf(f, studentId)).toMatchObject({ finalFeeCents: 0, status: "paid" });
  });

  it("Change fee on a course replans its periods, and later period generation adds nothing", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enrollStudentInBatch(f.owner, {
      batchId: f.courseBatchId,
      studentId,
      courseIds: [f.courseBatchCourseId],
      paymentPlan: { intervalMonths: 1, amountCents: 12_000, anchorDate: "2026-10-01" },
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const target = { kind: "course" as const, enrollmentId: enrolled.enrollment.id };
    const changed = await changeFeePlan(f.owner, { target, scholarship: "partial", feeCents: 12_000, discountCents: 3_000, installments: 3 });
    if (!changed.ok) throw new Error(changed.error.message);

    const listed = await listFeePeriodsForEnrollment(f.owner, enrolled.enrollment.id);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.periods.map((p) => [p.periodStart, p.expectedAmountCents])).toEqual([
      ["2026-10-01", 3_000],
      ["2026-11-01", 3_000],
      ["2026-12-01", 3_000],
    ]);
    const [schedule] = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.enrollmentId, enrolled.enrollment.id));
    expect(schedule).toMatchObject({ amountCents: 9_000, discountCents: 3_000, intervalMonths: 3, anchorDate: "2026-10-01" });
    const [row] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, enrolled.enrollment.id));
    expect(row.scholarship).toBe("partial");
  });

  it("Change fee refuses a program's own course (the fee is on the program)", async () => {
    const studentId = await newStudent(f);
    const enrolled = await enroll(f, studentId);
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const result = await changeFeePlan(f.owner, {
      target: { kind: "course", enrollmentId: enrolled.courseEnrollmentIds[0] },
      scholarship: "none",
      feeCents: 10_000,
      installments: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("registering without an enrollment keeps the note on the student", async () => {
    const registered = await registerStudent(f.owner, { branchId: f.branchId, fullName: "Axmed", enrollmentNote: "  Waiting for the March program  " });
    if (!registered.ok) throw new Error(registered.error.message);
    const [row] = await db.select({ note: students.enrollmentNote }).from(students).where(eq(students.id, registered.student.id));
    expect(row.note).toBe("Waiting for the March program");
  });
});
