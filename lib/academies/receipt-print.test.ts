import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batches,
  batchEnrollments,
  branches,
  courses,
  enrollmentFeeSchedules,
  feePeriods,
  notifications,
  paymentAllocations,
  programs,
  receipts,
  students,
  studentCharges,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createStudentCharge, issueReceipt, recordStudentPayment } from "./student-payments";
import { generateFeePeriodsForEnrollment, recordFeePeriodPayment, setEnrollmentFeeSchedule } from "./fee-periods";
import { reverseStudentPayment } from "./finance-reversals";
import { getReceiptPrintData } from "./receipt-print";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `receipt-print-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Receipt Print Test Plan ${randomUUID()}`,
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
      name: `Receipt Print Test Academy ${randomUUID()}`,
      slug: `receipt-print-test-${randomUUID()}`,
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

async function setupAcademy(role: AcademyRole): Promise<{
  academyId: string;
  branchId: string;
  studentId: string;
  creatorUserId: string;
  userId: string;
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
  const branchId = await insertBranchDirect(academyId);
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return { academyId, branchId, studentId, creatorUserId, userId, context: { userId, branchIds: [], academyWide: false } };
}

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  if (createdAcademyIds.length > 0) {
    await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    const paymentRows = await db.select({ id: studentPayments.id }).from(studentPayments).where(eq(studentPayments.academyId, academyId));
    for (const payment of paymentRows) {
      await db.delete(receipts).where(eq(receipts.studentPaymentId, payment.id));
    }
    await db.delete(paymentAllocations).where(eq(paymentAllocations.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
    await db.delete(feePeriods).where(eq(feePeriods.academyId, academyId));
    await db.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
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

describe("getReceiptPrintData — charge-linked payment", () => {
  it("returns academy/student/payment/description/recordedByLabel for an issued receipt", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const chargeResult = await createStudentCharge(context, {
      studentId,
      description: "ID card replacement",
      amountCents: 1_000,
    });
    expect(chargeResult.ok).toBe(true);
    if (!chargeResult.ok) return;

    const paymentResult = await recordStudentPayment(context, {
      studentId,
      chargeId: chargeResult.charge.id,
      amountCents: 1_000,
      method: "mobile_money",
      reference: "MM-84920",
      notes: "Paid in full",
      receivedAt: new Date().toISOString(),
    });
    expect(paymentResult.ok).toBe(true);
    if (!paymentResult.ok) return;

    const receiptResult = await issueReceipt(context, paymentResult.payment.id);
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) return;

    const result = await getReceiptPrintData(context, receiptResult.receipt.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.receipt.receiptNumber).toBe(receiptResult.receipt.receiptNumber);
    expect(result.data.student.studentNumber).toBeTruthy();
    expect(result.data.payment.amountCents).toBe(1_000);
    expect(result.data.payment.method).toBe("mobile_money");
    expect(result.data.payment.reference).toBe("MM-84920");
    expect(result.data.payment.notes).toBe("Paid in full");
    expect(result.data.payment.status).toBe("approved");
    expect(result.data.description).toBe("Charge: ID card replacement");
    expect(result.data.recordedByLabel).toBe("Manager");
  });

  it("reflects the CURRENT (reversed) payment state, never the state at issuance time", async () => {
    const recorder = await setupAcademy("manager");
    const chargeResult = await createStudentCharge(recorder.context, { studentId: recorder.studentId, description: "Late fee", amountCents: 500 });
    expect(chargeResult.ok).toBe(true);
    if (!chargeResult.ok) return;

    const paymentResult = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId: chargeResult.charge.id,
      amountCents: 500,
      method: "cash",
      receivedAt: new Date().toISOString(),
    });
    expect(paymentResult.ok).toBe(true);
    if (!paymentResult.ok) return;

    const receiptResult = await issueReceipt(recorder.context, paymentResult.payment.id);
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) return;

    const reverser = await addActingUser(recorder.academyId, "manager");
    const reversed = await reverseStudentPayment(reverser.context, paymentResult.payment.id, "Recorded in error.");
    expect(reversed.ok).toBe(true);

    const result = await getReceiptPrintData(recorder.context, receiptResult.receipt.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.payment.status).toBe("reversed");
  });

  it("cross-academy receipt id returns the identical generic 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const chargeResult = await createStudentCharge(other.context, { studentId: other.studentId, description: "Fee", amountCents: 500 });
    if (!chargeResult.ok) return;
    const paymentResult = await recordStudentPayment(other.context, {
      studentId: other.studentId,
      chargeId: chargeResult.charge.id,
      amountCents: 500,
      method: "cash",
      receivedAt: new Date().toISOString(),
    });
    if (!paymentResult.ok) return;
    const receiptResult = await issueReceipt(other.context, paymentResult.payment.id);
    if (!receiptResult.ok) return;

    const { context } = await setupAcademy("manager");
    const result = await getReceiptPrintData(context, receiptResult.receipt.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("a nonexistent receipt id returns 'not_found'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await getReceiptPrintData(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("Owner/Admin/Trainer (view-only on student_payments) CAN view the receipt", async () => {
    const recorder = await setupAcademy("manager");
    const chargeResult = await createStudentCharge(recorder.context, { studentId: recorder.studentId, description: "Fee", amountCents: 500 });
    if (!chargeResult.ok) return;
    const paymentResult = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId: chargeResult.charge.id,
      amountCents: 500,
      method: "cash",
      receivedAt: new Date().toISOString(),
    });
    if (!paymentResult.ok) return;
    const receiptResult = await issueReceipt(recorder.context, paymentResult.payment.id);
    if (!receiptResult.ok) return;

    for (const role of ["academy_owner", "academy_admin", "trainer"] as const) {
      const viewer = await addActingUser(recorder.academyId, role);
      const result = await getReceiptPrintData(viewer.context, receiptResult.receipt.id);
      expect(result.ok).toBe(true);
    }
  });

  it("Admissions Officer (no access on student_payments) is refused", async () => {
    const recorder = await setupAcademy("manager");
    const chargeResult = await createStudentCharge(recorder.context, { studentId: recorder.studentId, description: "Fee", amountCents: 500 });
    if (!chargeResult.ok) return;
    const paymentResult = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId: chargeResult.charge.id,
      amountCents: 500,
      method: "cash",
      receivedAt: new Date().toISOString(),
    });
    if (!paymentResult.ok) return;
    const receiptResult = await issueReceipt(recorder.context, paymentResult.payment.id);
    if (!receiptResult.ok) return;

    const admissions = await addActingUser(recorder.academyId, "admissions_officer");
    const result = await getReceiptPrintData(admissions.context, receiptResult.receipt.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("getReceiptPrintData — fee-period-linked payment", () => {
  it("describes the course/batch/period range instead of a charge", async () => {
    const { academyId, studentId, context } = await setupAcademy("manager");
    const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
    const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: "Web Development" }).returning({ id: courses.id });
    const branchId = await insertBranchDirect(academyId);
    const [batch] = await db
      .insert(batches)
      .values({ academyId, branchId, courseId: course.id, name: "Batch 03", code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id });
    const [enrollment] = await db
      .insert(batchEnrollments)
      .values({ academyId, batchId: batch.id, studentId })
      .returning({ id: batchEnrollments.id });

    const scheduleResult = await setEnrollmentFeeSchedule(context, {
      enrollmentId: enrollment.id,
      intervalMonths: 1,
      amountCents: 20_000,
      anchorDate: "2026-01-01",
    });
    expect(scheduleResult.ok).toBe(true);
    await generateFeePeriodsForEnrollment(db, enrollment.id, academyId, "2026-01-01");
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, enrollment.id));

    const recorded = await recordFeePeriodPayment(context, {
      studentId,
      enrollmentId: enrollment.id,
      allocations: [{ feePeriodId: period.id, amountCents: 20_000 }],
      method: "bank_transfer",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const receiptResult = await issueReceipt(context, recorded.payment.id);
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) return;

    const result = await getReceiptPrintData(context, receiptResult.receipt.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.description).toContain("Web Development");
    expect(result.data.description).toContain("Batch 03");
    expect(result.data.description).toContain(period.periodStart);
  });
});
