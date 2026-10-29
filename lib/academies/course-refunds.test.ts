import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  approvalRequests,
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
  programs,
  receipts,
  studentCourseRefundPayments,
  studentCourseRefunds,
  studentPayments,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { courseOfBatch } from "@/lib/academies/test-batch-course";
import {
  generateFeePeriodsForEnrollment,
  getOverdueFeeSummary,
  recordEnrollmentPayment,
  setEnrollmentFeeSchedule,
  todayDateOnlyInAcademyTimezone,
} from "./fee-periods";
import { adjustStudentPayment, reverseStudentPayment } from "./finance-reversals";
import { issueReceipt } from "./student-payments";
import { getFinanceReports } from "./finance-reports";
import {
  getCourseRefundPosition,
  getRefundedAmountsForPayments,
  listStudentRefunds,
  withdrawStudentWithRefund,
  type WithdrawWithRefundInput,
} from "./course-refunds";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `course-refunds-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/course-refunds.test.ts)",
      name: `Course Refunds Test Plan ${randomUUID()}`,
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

async function addActingUser(academyId: string, role: AcademyRole): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
  return { userId, context: { userId, branchIds: [], academyWide: false } };
}

async function newEnrollment(academyId: string, branchId: string, studentId: string): Promise<string> {
  const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: `Course ${randomUUID()}` }).returning({ id: courses.id });
  const [batch] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId: course.id, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  const [row] = await db
    .insert(batchEnrollments)
    .values({ academyId, batchId: batch.id, courseId: await courseOfBatch(batch.id), studentId })
    .returning({ id: batchEnrollments.id });
  return row.id;
}

interface Fixture {
  academyId: string;
  branchId: string;
  studentId: string;
  enrollmentId: string;
  manager: { userId: string; context: AuthContext };
}

/** Academy, branch, student, one enrollment with a 3 x $10 schedule starting today, and a Manager. */
async function setup(): Promise<Fixture> {
  const [creatorUserId, planId] = await Promise.all([createUser(), createPlan()]);
  const [academy] = await db
    .insert(academies)
    .values({ name: `Course Refunds Test ${randomUUID()}`, slug: `course-refunds-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId, status: "active", endsAt: new Date(Date.now() + 30 * 864e5), createdBy: creatorUserId });
  const [branch] = await db
    .insert(branches)
    .values({ academyId: academy.id, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  const [student] = await db
    .insert(students)
    .values({ academyId: academy.id, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Refund Student", createdBy: creatorUserId })
    .returning({ id: students.id });
  const enrollmentId = await newEnrollment(academy.id, branch.id, student.id);
  const manager = await addActingUser(academy.id, "manager");
  await schedule(manager.context, academy.id, enrollmentId, 3_000);
  return { academyId: academy.id, branchId: branch.id, studentId: student.id, enrollmentId, manager };
}

async function schedule(context: AuthContext, academyId: string, enrollmentId: string, amountCents: number) {
  const result = await setEnrollmentFeeSchedule(context, { enrollmentId, intervalMonths: 3, amountCents, anchorDate: todayDateOnlyInAcademyTimezone() });
  expect(result.ok).toBe(true);
  await generateFeePeriodsForEnrollment(db, enrollmentId, academyId);
}

async function pay(f: Fixture, amountCents: number, enrollmentId = f.enrollmentId) {
  const before = await db.select({ id: studentPayments.id }).from(studentPayments).where(eq(studentPayments.studentId, f.studentId));
  const result = await recordEnrollmentPayment(f.manager.context, { studentId: f.studentId, enrollmentId, amountCents, method: "cash", receivedAt: new Date() });
  expect(result.ok).toBe(true);
  const after = await db.select().from(studentPayments).where(eq(studentPayments.studentId, f.studentId));
  return after.find((p) => !before.some((b) => b.id === p.id))!;
}

function refundInput(enrollmentId: string, amountCents: number, overrides: Partial<WithdrawWithRefundInput["refund"]> = {}): WithdrawWithRefundInput {
  return {
    enrollmentId,
    withdrawReason: "Moved to another city",
    refund: {
      amountCents,
      method: "mobile_money",
      refundedAt: todayDateOnlyInAcademyTimezone(),
      reference: "MM-REF-1",
      reason: "Withdrew in week one",
      idempotencyKey: randomUUID(),
      ...overrides,
    },
  };
}

async function snapshot(f: Fixture) {
  const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, f.enrollmentId)).orderBy(feePeriods.periodStart);
  const payments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, f.studentId)).orderBy(studentPayments.id);
  const allocations = periods.length
    ? await db.select().from(paymentAllocations).where(inArray(paymentAllocations.feePeriodId, periods.map((p) => p.id))).orderBy(paymentAllocations.id)
    : [];
  return { periods, payments, allocations };
}

async function refundsOf(enrollmentId: string) {
  return db.select().from(studentCourseRefunds).where(eq(studentCourseRefunds.enrollmentId, enrollmentId));
}

async function statusOf(enrollmentId: string) {
  const [row] = await db.select({ status: batchEnrollments.status }).from(batchEnrollments).where(eq(batchEnrollments.id, enrollmentId));
  return row.status;
}

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    const refundRows = await db.select({ id: studentCourseRefunds.id }).from(studentCourseRefunds).where(eq(studentCourseRefunds.academyId, academyId));
    if (refundRows.length) await db.delete(studentCourseRefundPayments).where(inArray(studentCourseRefundPayments.refundId, refundRows.map((r) => r.id)));
    await db.delete(studentCourseRefunds).where(eq(studentCourseRefunds.academyId, academyId));
  }
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  if (createdAcademyIds.length > 0) {
    await db.delete(approvalRequests).where(or(...createdAcademyIds.map((id) => eq(approvalRequests.academyId, id))));
    await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    const paymentRows = await db.select({ id: studentPayments.id }).from(studentPayments).where(eq(studentPayments.academyId, academyId));
    if (paymentRows.length) await db.delete(receipts).where(inArray(receipts.studentPaymentId, paymentRows.map((p) => p.id)));
    await db.delete(paymentAllocations).where(eq(paymentAllocations.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(feePeriods).where(eq(feePeriods.academyId, academyId));
    await db.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.academyId, academyId));
    await db.delete(batchEnrollments).where(eq(batchEnrollments.academyId, academyId));
    await db.delete(batchCourses).where(eq(batchCourses.academyId, academyId));
    await db.delete(batches).where(eq(batches.academyId, academyId));
    await db.delete(courses).where(eq(courses.academyId, academyId));
    await db.delete(programs).where(eq(programs.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of createdUserIds) await db.delete(users).where(eq(users.id, userId));
});

describe("withdraw and record a refund — the approved policy", () => {
  it("FULL refund: one refund row linked to the enrollment and the payment; originals untouched; enrollment withdrawn; audited", async () => {
    const f = await setup();
    const payment = await pay(f, 2_500);
    const receipt = await issueReceipt(f.manager.context, payment.id);
    expect(receipt.ok).toBe(true);
    const receiptsBefore = await db.select().from(receipts).where(eq(receipts.studentPaymentId, payment.id));
    const before = await snapshot(f);

    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 2_500));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyRecorded).toBe(false);
    expect(result.refund).toMatchObject({ enrollmentId: f.enrollmentId, studentId: f.studentId, amountCents: 2_500, currency: "USD", method: "mobile_money", reference: "MM-REF-1" });
    expect(result.refund.payments).toEqual([{ studentPaymentId: payment.id, amountCents: 2_500 }]);

    // Originals: payments (none added — a refund is not a payment), allocations, fee periods, receipts.
    expect(await snapshot(f)).toEqual(before);
    expect(await db.select().from(receipts).where(eq(receipts.studentPaymentId, payment.id))).toEqual(receiptsBefore);
    expect(await statusOf(f.enrollmentId)).toBe("withdrawn");

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.academyId, f.academyId));
    const withdrawAudit = audits.find((a) => a.action === "withdrawStudentFromBatch" && a.entityId === f.enrollmentId);
    const refundAudit = audits.find((a) => a.action === "recordCourseRefund");
    expect(withdrawAudit?.context).toMatchObject({ reason: "Moved to another city" });
    expect(refundAudit).toMatchObject({ entityId: result.refund.id, actorUserId: f.manager.userId, reason: "Withdrew in week one" });
    expect(refundAudit?.after).toMatchObject({ enrollmentId: f.enrollmentId, amountCents: 2_500, method: "mobile_money", reference: "MM-REF-1" });

    // Withdrawn course no longer counts as owed or overdue.
    const overdue = await getOverdueFeeSummary(f.academyId, null, [f.studentId]);
    expect(overdue.studentCount).toBe(0);
  });

  it("PARTIAL refund across two payments links newest first, never more than each payment's share", async () => {
    const f = await setup();
    const older = await pay(f, 1_000);
    const newer = await pay(f, 1_500);
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 2_000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refund.payments).toEqual([
      { studentPaymentId: newer.id, amountCents: 1_500 },
      { studentPaymentId: older.id, amountCents: 500 },
    ]);
    const links = await db.select().from(studentCourseRefundPayments).where(eq(studentCourseRefundPayments.refundId, result.refund.id));
    expect(links.reduce((s, l) => s + l.amountCents, 0)).toBe(2_000);
  });

  it("rejects more than the cap (by one cent), zero, negative and fractional cents — and then nothing changes", async () => {
    const f = await setup();
    await pay(f, 2_500);
    const before = await snapshot(f);
    for (const amount of [2_501, 0, -100, 12.5]) {
      const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, amount));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("validation");
    }
    expect(await refundsOf(f.enrollmentId)).toEqual([]);
    expect(await statusOf(f.enrollmentId)).toBe("active");
    expect(await snapshot(f)).toEqual(before);
  });

  it("rejects a future refund date, an empty refund reason and an empty withdrawal reason", async () => {
    const f = await setup();
    await pay(f, 1_000);
    const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const cases: WithdrawWithRefundInput[] = [
      refundInput(f.enrollmentId, 500, { refundedAt: future }),
      refundInput(f.enrollmentId, 500, { reason: "  " }),
      { ...refundInput(f.enrollmentId, 500), withdrawReason: "" },
    ];
    for (const input of cases) {
      const result = await withdrawStudentWithRefund(f.manager.context, input);
      expect(result.ok).toBe(false);
    }
    expect(await statusOf(f.enrollmentId)).toBe("active");
  });

  it("a repeated submission (same key) records once and returns the same refund", async () => {
    const f = await setup();
    await pay(f, 1_000);
    const input = refundInput(f.enrollmentId, 1_000);
    const first = await withdrawStudentWithRefund(f.manager.context, input);
    const second = await withdrawStudentWithRefund(f.manager.context, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.alreadyRecorded).toBe(true);
    expect(second.refund.id).toBe(first.refund.id);
    expect(await refundsOf(f.enrollmentId)).toHaveLength(1);
  });

  it("concurrent requests can't both refund: exactly one succeeds, the other finds the enrollment already withdrawn", async () => {
    const f = await setup();
    await pay(f, 2_500);
    const results = await Promise.all([
      withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 2_500)),
      withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 2_500)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok && failed.error.code).toBe("invalid_transition");
    expect(await refundsOf(f.enrollmentId)).toHaveLength(1);
  });

  it("previously recorded refunds reduce the cap", async () => {
    const f = await setup();
    const payment = await pay(f, 2_500);
    // An earlier refund for this enrollment (as a future follow-up workflow
    // could record): inserted directly as test data.
    const [earlier] = await db
      .insert(studentCourseRefunds)
      .values({
        academyId: f.academyId,
        branchId: f.branchId,
        enrollmentId: f.enrollmentId,
        studentId: f.studentId,
        amountCents: 1_000,
        currency: "USD",
        method: "cash",
        refundedAt: new Date(),
        reason: "Earlier refund",
        recordedBy: f.manager.userId,
        idempotencyKey: randomUUID(),
      })
      .returning();
    await db.insert(studentCourseRefundPayments).values({ refundId: earlier.id, studentPaymentId: payment.id, amountCents: 1_000 });

    const position = await getCourseRefundPosition(f.manager.context, f.enrollmentId);
    expect(position.ok && position.position).toMatchObject({ paidCents: 2_500, refundedCents: 1_000, refundableCents: 1_500 });

    const tooMuch = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_501));
    expect(tooMuch.ok).toBe(false);
    const exact = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_500));
    expect(exact.ok).toBe(true);
  });

  it("reversed and adjusted payments are not refundable; the cap is what remains approved", async () => {
    const f = await setup();
    const reverser = await addActingUser(f.academyId, "manager");
    await pay(f, 1_000);
    const wrong = await pay(f, 500);
    const toAdjust = await pay(f, 700);
    expect((await reverseStudentPayment(reverser.context, wrong.id, "Duplicate")).ok).toBe(true);
    expect((await adjustStudentPayment(reverser.context, toAdjust.id, "Was 600", 600)).ok).toBe(true);

    const position = await getCourseRefundPosition(f.manager.context, f.enrollmentId);
    expect(position.ok && position.position.refundableCents).toBe(1_000);
    const over = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_001));
    expect(over.ok).toBe(false);
  });

  it("payments for the student's OTHER course are never refundable through this one", async () => {
    const f = await setup();
    const otherEnrollment = await newEnrollment(f.academyId, f.branchId, f.studentId);
    await schedule(f.manager.context, f.academyId, otherEnrollment, 9_000);
    await pay(f, 1_000);
    await pay(f, 6_000, otherEnrollment);

    const position = await getCourseRefundPosition(f.manager.context, f.enrollmentId);
    expect(position.ok && position.position).toMatchObject({ paidCents: 1_000, refundableCents: 1_000 });
    expect((await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_001))).ok).toBe(false);
    expect((await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_000))).ok).toBe(true);
    expect(await statusOf(otherEnrollment)).toBe("active");
    expect(await refundsOf(otherEnrollment)).toEqual([]);
  });

  it("refuses when nothing was paid for the course", async () => {
    const f = await setup();
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 100));
    expect(result.ok).toBe(false);
    expect(await statusOf(f.enrollmentId)).toBe("active");
  });
});

describe("refund permissions and isolation", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["manager", true],
    ["academy_admin", false],
    ["finance_officer", false],
    ["trainer", false],
    ["admissions_officer", false],
  ])("role %s may record a refund: %s", async (role, allowed) => {
    const f = await setup();
    await pay(f, 1_000);
    const actor = await addActingUser(f.academyId, role);
    const result = await withdrawStudentWithRefund(actor.context, refundInput(f.enrollmentId, 1_000));
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    expect(await refundsOf(f.enrollmentId)).toHaveLength(allowed ? 1 : 0);
  });

  it("another academy's Manager can't refund (or even see) this enrollment", async () => {
    const f = await setup();
    await pay(f, 1_000);
    const other = await setup();
    const result = await withdrawStudentWithRefund(other.manager.context, refundInput(f.enrollmentId, 1_000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    const position = await getCourseRefundPosition(other.manager.context, f.enrollmentId);
    expect(position.ok).toBe(false);
    expect(await statusOf(f.enrollmentId)).toBe("active");
    const listed = await listStudentRefunds(other.manager.context, f.studentId);
    expect(listed.ok && listed.refunds).toEqual([]);
  });

  it("an idempotency key already used for another enrollment is refused", async () => {
    const f = await setup();
    await pay(f, 1_000);
    const second = await newEnrollment(f.academyId, f.branchId, f.studentId);
    await schedule(f.manager.context, f.academyId, second, 3_000);
    await pay(f, 1_000, second);
    const input = refundInput(f.enrollmentId, 1_000);
    expect((await withdrawStudentWithRefund(f.manager.context, input)).ok).toBe(true);
    const reused = await withdrawStudentWithRefund(f.manager.context, { ...input, enrollmentId: second });
    expect(reused.ok).toBe(false);
    expect(await statusOf(second)).toBe("active");
  });
});

describe("after a refund", () => {
  it("the refunded payment can no longer be reversed or adjusted; an unrefunded one still can", async () => {
    const f = await setup();
    const refunded = await pay(f, 1_000);
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_000));
    expect(result.ok).toBe(true);

    const reverser = await addActingUser(f.academyId, "manager");
    const reverse = await reverseStudentPayment(reverser.context, refunded.id, "Trying");
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error.code).toBe("invalid_state");
    const adjust = await adjustStudentPayment(reverser.context, refunded.id, "Trying", 10);
    expect(adjust.ok).toBe(false);
    const [still] = await db.select().from(studentPayments).where(eq(studentPayments.id, refunded.id));
    expect(still.status).toBe("approved");

    const other = await newEnrollment(f.academyId, f.branchId, f.studentId);
    await schedule(f.manager.context, f.academyId, other, 3_000);
    const unrefunded = await pay(f, 500, other);
    expect((await reverseStudentPayment(reverser.context, unrefunded.id, "Fine")).ok).toBe(true);
  });

  it("payment lists see how much was refunded out of each payment, scoped to the academy", async () => {
    const f = await setup();
    const older = await pay(f, 1_000);
    const newer = await pay(f, 1_500);
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 2_000));
    expect(result.ok).toBe(true);
    const amounts = await getRefundedAmountsForPayments(f.academyId, [older.id, newer.id]);
    expect(Object.fromEntries(amounts)).toEqual({ [newer.id]: 1_500, [older.id]: 500 });
    const other = await setup();
    expect((await getRefundedAmountsForPayments(other.academyId, [older.id, newer.id])).size).toBe(0);
  });

  it("the finance report shows refunds on their own; payments received is unchanged", async () => {
    const f = await setup();
    await pay(f, 2_000);
    const before = await getFinanceReports(f.manager.context);
    expect(before.ok).toBe(true);
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 800));
    expect(result.ok).toBe(true);
    const after = await getFinanceReports(f.manager.context);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok || !before.report.studentPayments.visible || !after.report.studentPayments.visible) return;
    expect(after.report.studentPayments.paymentsReceived).toEqual(before.report.studentPayments.paymentsReceived);
    expect(after.report.studentPayments.refundsRecorded).toEqual({ count: 1, totalsByCurrency: [{ currency: "USD", amountCents: 800, count: 1 }] });
  });

  it("the student's refund list shows it with its course, and the position reflects it", async () => {
    const f = await setup();
    await pay(f, 2_000);
    const result = await withdrawStudentWithRefund(f.manager.context, refundInput(f.enrollmentId, 1_200));
    expect(result.ok).toBe(true);
    const listed = await listStudentRefunds(f.manager.context, f.studentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.refunds).toHaveLength(1);
    expect(listed.refunds[0]).toMatchObject({ amountCents: 1_200, enrollmentId: f.enrollmentId, courseName: expect.stringContaining("Course") });
    const position = await getCourseRefundPosition(f.manager.context, f.enrollmentId);
    expect(position.ok && position.position).toMatchObject({ paidCents: 2_000, refundedCents: 1_200, refundableCents: 800 });
    // Refunds never appear as payments.
    const payments = await db.select().from(studentPayments).where(and(eq(studentPayments.studentId, f.studentId)));
    expect(payments).toHaveLength(1);
  });
});
