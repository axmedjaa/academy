import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
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
  batches,
  branches,
  courses,
  enrollmentFeeSchedules,
  feePeriods,
  notifications,
  paymentAllocations,
  programs,
  receipts,
  students,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { dollarsToCents } from "@/lib/ui/money";
import { adjustStudentPayment, reverseStudentPayment } from "./finance-reversals";
import { issueReceipt } from "./student-payments";
import { withdrawStudentFromBatch } from "./batch-assignments";
import {
  computeFeePeriodStatus,
  generateFeePeriodsForEnrollment,
  getEnrollmentPaymentSummary,
  getOverdueFeeSummary,
  getStudentPaymentSummaries,
  listEnrollmentsForStudent,
  listFeePeriodPaymentHistory,
  listFeePeriodsForEnrollment,
  recordEnrollmentPayment,
  recordFeePeriodPayment,
  setEnrollmentFeeSchedule,
  todayDateOnlyInAcademyTimezone,
} from "./fee-periods";
import { courseOfBatch } from "@/lib/academies/test-batch-course";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

/** Today as "YYYY-MM-DD" — anchors a schedule so its first period has
 * already started "as of now," for tests specifically about current/
 * relevant-period behavior (as opposed to the far-future/far-past anchors
 * used elsewhere in this file purely to avoid overdue-status noise). */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `fee-periods-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
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
      description: "Automated test fixture (lib/academies/fee-periods.test.ts)",
      name: `Fee Periods Test Plan ${randomUUID()}`,
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
    .values({ name: `Fee Periods Test Academy ${randomUUID()}`, slug: `fee-periods-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  return row.id;
}

async function insertProgramAndCourse(academyId: string): Promise<string> {
  const [program] = await db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id });
  const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: `Course ${randomUUID()}` }).returning({ id: courses.id });
  return course.id;
}

async function insertBatchDirect(academyId: string, branchId: string, courseId: string): Promise<string> {
  const [row] = await db
    .insert(batches)
    .values({ academyId, branchId, courseId, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
    .returning({ id: batches.id });
  return row.id;
}

async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Test Student", createdBy: creatorUserId })
    .returning({ id: students.id });
  return row.id;
}

async function insertEnrollmentDirect(academyId: string, batchId: string, studentId: string): Promise<string> {
  const [row] = await db.insert(batchEnrollments).values({ academyId, batchId, courseId: await courseOfBatch(batchId), studentId }).returning({ id: batchEnrollments.id });
  return row.id;
}

interface Fixture {
  academyId: string;
  branchId: string;
  courseId: string;
  batchId: string;
  studentId: string;
  enrollmentId: string;
  creatorUserId: string;
}

/**
 * Perf investigation (Afoogy slow-dashboard task, Neon round-trip step):
 * none of these inserts run inside a shared `db.transaction()` (unlike
 * the production code in lib/academies/fee-periods.ts), so independent
 * top-level `db.insert(...)` calls each check out their own connection
 * from the pool and genuinely run concurrently against Neon — real
 * wall-clock parallelism, not just batched awaits. Phased strictly by
 * FK dependency (never by convenience):
 *  1. createUser/createPlan — provably independent of each other.
 *  2. createAcademy — needs creatorUserId only.
 *  3. academySubscriptions insert (needs academyId+planId),
 *     insertBranchDirect (needs academyId), insertProgramAndCourse
 *     (needs academyId) — none of these three depends on either of the
 *     other two's result.
 *  4. insertStudentDirect (needs academyId+branchId+creatorUserId) and
 *     insertBatchDirect (needs academyId+branchId+courseId) — neither
 *     needs the other's result (student doesn't need courseId/batchId;
 *     batch doesn't need studentId).
 *  5. insertEnrollmentDirect — needs both batchId and studentId, so it
 *     alone must wait for all of phase 4.
 * Every dependency edge in the original sequential version is preserved
 * exactly; only provably-independent steps moved into the same phase.
 */
async function setupFixture(): Promise<Fixture> {
  const [creatorUserId, planId] = await Promise.all([createUser(), createPlan()]);
  const academyId = await createAcademy(creatorUserId);
  const [, branchId, courseId] = await Promise.all([
    db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "active",
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: creatorUserId,
    }),
    insertBranchDirect(academyId),
    insertProgramAndCourse(academyId),
  ]);
  const [studentId, batchId] = await Promise.all([
    insertStudentDirect(academyId, branchId, creatorUserId),
    insertBatchDirect(academyId, branchId, courseId),
  ]);
  const enrollmentId = await insertEnrollmentDirect(academyId, batchId, studentId);
  return { academyId, branchId, courseId, batchId, studentId, enrollmentId, creatorUserId };
}

async function addActingUser(academyId: string, role: AcademyRole): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  if (createdAcademyIds.length > 0) {
    await db.delete(approvalRequests).where(or(...createdAcademyIds.map((id) => eq(approvalRequests.academyId, id))));
    await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    const paymentRows = await db.select({ id: studentPayments.id }).from(studentPayments).where(eq(studentPayments.academyId, academyId));
    for (const payment of paymentRows) {
      await db.delete(receipts).where(eq(receipts.studentPaymentId, payment.id));
    }
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

describe("computeFeePeriodStatus", () => {
  it("returns paid when paid >= expected", () => {
    expect(computeFeePeriodStatus(5000, 5000, "2026-09-01", "2026-09-15")).toBe("paid");
    expect(computeFeePeriodStatus(5000, 6000, "2026-09-01", "2026-09-15")).toBe("paid");
  });
  it("returns unpaid when nothing paid and not yet due", () => {
    expect(computeFeePeriodStatus(5000, 0, "2026-10-01", "2026-09-15")).toBe("unpaid");
  });
  it("returns partially_paid when some paid, not yet due", () => {
    expect(computeFeePeriodStatus(5000, 2000, "2026-10-01", "2026-09-15")).toBe("partially_paid");
  });
  it("returns overdue when remaining > 0 and past due, regardless of partial payment", () => {
    expect(computeFeePeriodStatus(5000, 0, "2026-09-01", "2026-09-15")).toBe("overdue");
    expect(computeFeePeriodStatus(5000, 2000, "2026-09-01", "2026-09-15")).toBe("overdue");
  });
});

describe("setEnrollmentFeeSchedule permission matrix", () => {
  it("Manager can set a schedule", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 5000,
      anchorDate: "2026-09-01",
    });
    expect(result.ok).toBe(true);
  });

  it("Finance Officer can set a schedule", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "finance_officer");
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 5000,
      anchorDate: "2026-09-01",
    });
    expect(result.ok).toBe(true);
  });

  it("Academy Administrator can set a schedule (raised to manage-level per the manual student-payment verification report)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "academy_admin");
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 5000,
      anchorDate: "2026-09-01",
    });
    expect(result.ok).toBe(true);
  });

  it("Owner/Trainer (view-only) cannot set a schedule", async () => {
    const fixture = await setupFixture();
    for (const role of ["academy_owner", "trainer"] as const) {
      const { context } = await addActingUser(fixture.academyId, role);
      const result = await setEnrollmentFeeSchedule(context, {
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        amountCents: 5000,
        anchorDate: "2026-09-01",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    }
  });

  it("Admissions Officer has no access at all", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "admissions_officer");
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 5000,
      anchorDate: "2026-09-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("rejects an enrollment belonging to a different academy", async () => {
    const fixture = await setupFixture();
    const other = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: other.enrollmentId,
      intervalMonths: 1,
      amountCents: 5000,
      anchorDate: "2026-09-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("fee period generation", () => {
  it("generates monthly periods with correct expected amount and contiguous, non-overlapping boundaries", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2026-01-01" });

    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods.length).toBeGreaterThan(0);
    const first = result.periods[0];
    expect(first.periodStart).toBe("2026-01-01");
    expect(first.periodEnd).toBe("2026-01-31");
    expect(first.dueDate).toBe("2026-01-01");
    expect(first.expectedAmountCents).toBe(5000);
    if (result.periods.length > 1) {
      expect(result.periods[1].periodStart).toBe("2026-02-01");
    }
  });

  it("a 3-month SCHEDULE (3 monthly installments) generates THREE separate one-calendar-month periods, never one 3-month-long period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 15000, anchorDate: "2026-01-01" });

    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(3);

    expect(result.periods[0]).toMatchObject({ periodStart: "2026-01-01", periodEnd: "2026-01-31", dueDate: "2026-01-01", expectedAmountCents: 5000 });
    expect(result.periods[1]).toMatchObject({ periodStart: "2026-02-01", periodEnd: "2026-02-28", dueDate: "2026-02-01", expectedAmountCents: 5000 });
    expect(result.periods[2]).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-31", dueDate: "2026-03-01", expectedAmountCents: 5000 });

    // $150.00 total, split 3 ways = exactly $50.00/month, no remainder.
    const total = result.periods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
    expect(total).toBe(15000);
  });

  it("a 12-month SCHEDULE (12 monthly installments) generates TWELVE separate one-calendar-month periods, never one 12-month-long period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 12, amountCents: 60000, anchorDate: "2026-01-01" });

    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(12);

    expect(result.periods[0]).toMatchObject({ periodStart: "2026-01-01", periodEnd: "2026-01-31", expectedAmountCents: 5000 });
    expect(result.periods[11]).toMatchObject({ periodStart: "2026-12-01", periodEnd: "2026-12-31", expectedAmountCents: 5000 });

    // $600.00 total, split 12 ways = exactly $50.00/month, no remainder.
    const total = result.periods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
    expect(total).toBe(60000);
  });

  it("the final acceptance example: $36 total over 6 months generates exactly the 6 monthly installments of $6 the task spec requires", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const scheduleResult = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 6,
      amountCents: 3600,
      anchorDate: "2026-10-06",
    });
    expect(scheduleResult.ok).toBe(true);
    // The schedule's own derived "monthly installment" figure — what the
    // Fee Schedule UI shows as "$6.00/month", distinct from the $36.00
    // total (see fee-periods.ts's own module comment, "Payment schedule
    // model" — these must never be the same displayed number).
    if (scheduleResult.ok) {
      expect(scheduleResult.schedule.amountCents).toBe(3600);
      expect(scheduleResult.schedule.monthlyInstallmentCents).toBe(600);
    }

    // The Students-list page's own batched summary derives the identical
    // monthly figure, independent of the single-enrollment read above.
    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summaries.get(fixture.studentId);
    expect(row?.scheduleAmountCents).toBe(3600);
    expect(row?.monthlyInstallmentCents).toBe(600);

    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(6);

    const expected = [
      { periodStart: "2026-10-06", periodEnd: "2026-11-05" },
      { periodStart: "2026-11-06", periodEnd: "2026-12-05" },
      { periodStart: "2026-12-06", periodEnd: "2027-01-05" },
      { periodStart: "2027-01-06", periodEnd: "2027-02-05" },
      { periodStart: "2027-02-06", periodEnd: "2027-03-05" },
      { periodStart: "2027-03-06", periodEnd: "2027-04-05" },
    ];
    for (let i = 0; i < expected.length; i += 1) {
      expect(result.periods[i]).toMatchObject({ ...expected[i], dueDate: expected[i].periodStart, expectedAmountCents: 600 });
    }
    expect(result.periods.reduce((sum, period) => sum + period.expectedAmountCents, 0)).toBe(3600);
  });

  it("an amount that does not divide evenly puts the remainder on the LAST installment only, so the total always matches exactly ($100 over 4 months -> $25 x4; $100 over 3 months -> $33.33, $33.33, $33.34)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 4, amountCents: 10000, anchorDate: "2026-01-01" });
    const evenResult = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(evenResult.ok).toBe(true);
    if (evenResult.ok) {
      expect(evenResult.periods.map((p) => p.expectedAmountCents)).toEqual([2500, 2500, 2500, 2500]);
    }

    const fixture2 = await setupFixture();
    const { context: context2 } = await addActingUser(fixture2.academyId, "manager");
    await setEnrollmentFeeSchedule(context2, { enrollmentId: fixture2.enrollmentId, intervalMonths: 3, amountCents: 10000, anchorDate: "2026-01-01" });
    const unevenResult = await listFeePeriodsForEnrollment(context2, fixture2.enrollmentId);
    expect(unevenResult.ok).toBe(true);
    if (unevenResult.ok) {
      expect(unevenResult.periods.map((p) => p.expectedAmountCents)).toEqual([3333, 3333, 3334]);
      expect(unevenResult.periods.reduce((sum, p) => sum + p.expectedAmountCents, 0)).toBe(10000);
    }
  });

  it("never creates duplicate periods when generation runs twice", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2026-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const rows = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const keys = rows.map((row) => `${row.periodStart}:${row.periodEnd}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not rewrite an already-generated period's expected amount when the schedule is later changed", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2026-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 9000, anchorDate: "2026-01-01" });

    const [januaryPeriod] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(januaryPeriod.expectedAmountCents).toBe(5000);
  });

  it("regression: changing the interval WITHOUT moving anchorDate never generates a period overlapping an already-paid one (full coverage of this now lives in the 'effective-date rule' describe block below — this keeps the original real-world reported scenario as its own focused check)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    // A 2-month-installment schedule anchored 2026-09-28 — both
    // installments have already started by any real "today" this suite
    // runs on, matching the real reported case's shape (two already-
    // generated monthly periods existing before the change).
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 2,
      amountCents: 200,
      anchorDate: "2026-09-28",
    });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const beforeChange = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(beforeChange).toHaveLength(2); // Sep and Oct monthly installments
    const septemberPeriod = beforeChange.find((row) => row.periodStart === "2026-09-28")!;
    const octoberPeriod = beforeChange.find((row) => row.periodStart === "2026-10-28")!;

    // Pay both in full — these are the "already-paid historical periods"
    // that must remain completely untouched by everything below.
    const septemberPaid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: septemberPeriod.id, amountCents: 100 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(septemberPaid.ok).toBe(true);
    const octoberPaid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: octoberPeriod.id, amountCents: 100 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(octoberPaid.ok).toBe(true);

    // The schedule is changed to Every 6 Months — WITHOUT the caller
    // moving anchorDate forward (the exact "form pre-fills the old anchor
    // date" real-world scenario) — `setEnrollmentFeeSchedule` itself is
    // responsible for moving it past the two paid installments.
    // Both installments are kept (paid), so nothing of the plan is left to
    // reschedule: the change is refused (it used to charge the submitted
    // 999_999 as a fresh fee on top of the paid course). The guarantees
    // below — paid periods untouched, nothing overlapping — still hold.
    const changed = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 6,
      amountCents: 999_999,
      anchorDate: "2026-09-28",
    });
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.error.code).toBe("validation");

    const afterChange = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    // The two paid periods are byte-for-byte untouched.
    const septemberAfter = afterChange.find((row) => row.id === septemberPeriod.id)!;
    const octoberAfter = afterChange.find((row) => row.id === octoberPeriod.id)!;
    expect(septemberAfter).toEqual(septemberPeriod);
    expect(octoberAfter).toEqual(octoberPeriod);

    // No period overlaps either paid period's date range.
    for (const row of afterChange) {
      if (row.id === septemberPeriod.id || row.id === octoberPeriod.id) continue;
      const overlapsSeptember = row.periodStart <= septemberPeriod.periodEnd && row.periodEnd >= septemberPeriod.periodStart;
      const overlapsOctober = row.periodStart <= octoberPeriod.periodEnd && row.periodEnd >= octoberPeriod.periodStart;
      expect(overlapsSeptember).toBe(false);
      expect(overlapsOctober).toBe(false);
    }

    // Any newly-generated period starts strictly after the latest existing
    // (October) period ends — 2026-11-27 — i.e. 2026-11-28 onward.
    const newPeriods = afterChange.filter((row) => row.id !== septemberPeriod.id && row.id !== octoberPeriod.id);
    for (const row of newPeriods) {
      expect(row.periodStart > octoberPeriod.periodEnd).toBe(true);
    }

    // The two original student_payments rows and their allocations are
    // completely intact.
    const allocationsForSeptember = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, septemberPeriod.id));
    const allocationsForOctober = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, octoberPeriod.id));
    expect(allocationsForSeptember).toHaveLength(1);
    expect(allocationsForOctober).toHaveLength(1);
  });
});

describe("recordFeePeriodPayment", () => {
  // Anchored far in the future so no generated period is ever "overdue" —
  // these tests are about paid/remaining/allocation math, not overdue
  // derivation (covered separately by the computeFeePeriodStatus suite).
  async function withMonthlySchedule(totalAmountCents = 5000, intervalMonths = 1) {
    const fixture = await setupFixture();
    const { context: managerContext } = await addActingUser(fixture.academyId, "manager");
    // A second manager is required for reversal tests — the recorder can
    // never reverse their own payment (self-reversal is blocked).
    const { context: approverContext } = await addActingUser(fixture.academyId, "manager");
    // Anchored far in the future so no generated period is ever overdue,
    // regardless of the real wall-clock date the suite runs on. All
    // `intervalMonths` monthly installments are generated eagerly,
    // up-front, by the schedule call itself (see this file's own module
    // comment on the bounded, non-recurring model) — most callers only
    // ever need `periods[0]`, so `intervalMonths` defaults to 1; a caller
    // that genuinely needs several periods to exist passes a higher value.
    await setEnrollmentFeeSchedule(managerContext, { enrollmentId: fixture.enrollmentId, intervalMonths, amountCents: totalAmountCents, anchorDate: "2030-01-01" });
    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    if (!listed.ok) throw new Error("failed to list periods");
    return { fixture, managerContext, approverContext, periods: listed.periods };
  }

  it("records a single-period payment and it counts toward paid immediately, with no approval step", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const january = periods[0];

    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: january.id, amountCents: 5000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.payment.status).toBe("approved");

    const afterRecording = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(afterRecording.ok && afterRecording.periods[0].status).toBe("paid");
    expect(afterRecording.ok && afterRecording.periods[0].paidCents).toBe(5000);
  });

  it("persists an optional notes field, distinct from reference", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 2000 }],
      method: "mobile_money",
      reference: "MM-84920",
      notes: "Second installment",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const [row] = await db.select().from(studentPayments).where(eq(studentPayments.id, recorded.payment.id));
    expect(row.reference).toBe("MM-84920");
    expect(row.notes).toBe("Second installment");
  });

  it("supports partial payment against one period", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 2000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    if (!recorded.ok) throw new Error("expected ok");

    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("partially_paid");
    expect(listed.ok && listed.periods[0].remainingCents).toBe(3000);
  });

  it("supports multiple separate payments against the same period summing to paid", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const first = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 2000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    const second = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 3000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    if (!first.ok || !second.ok) throw new Error("expected ok");

    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("paid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(5000);
  });

  it("supports one payment covering multiple periods via allocations, without creating fake separate payments", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule(15000, 3);
    const threePeriods = periods.slice(0, 3);
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: threePeriods.map((period) => ({ feePeriodId: period.id, amountCents: 5000 })),
      method: "cash",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.payment.amountCents).toBe(15000);

    const paymentsForStudent = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
    expect(paymentsForStudent.length).toBe(1);

    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const period of threePeriods) {
      const match = listed.periods.find((row) => row.id === period.id);
      expect(match?.status).toBe("paid");
    }
  });

  it("rejects an allocation that exceeds the period's outstanding balance (no overpayment)", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const result = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 999_999 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("a rejected payment (historical row — reject is no longer a reachable action) never counts toward paid", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 5000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    if (!recorded.ok) throw new Error("expected ok");

    // There is no reject action for student payments anymore, but historical
    // "rejected" rows can still exist in the database — simulate one
    // directly to confirm the paid computation still excludes it.
    await db.update(studentPayments).set({ status: "rejected" }).where(eq(studentPayments.id, recorded.payment.id));

    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("unpaid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(0);
  });

  it("a reversed payment stops counting toward paid", async () => {
    const { fixture, managerContext, approverContext, periods } = await withMonthlySchedule();
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 5000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    if (!recorded.ok) throw new Error("expected ok");

    // Reversal must be by someone other than the recorder (self-reversal is
    // blocked) — the approver here also didn't record it, so they qualify.
    const reversed = await reverseStudentPayment(approverContext, recorded.payment.id, "Bounced cheque");
    expect(reversed.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("unpaid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(0);
  });

  it("rejects a fee period that does not belong to the given enrollment", async () => {
    const { fixture, managerContext } = await withMonthlySchedule();
    const other = await setupFixture();
    const { context: otherManagerContext } = await addActingUser(other.academyId, "manager");
    await setEnrollmentFeeSchedule(otherManagerContext, { enrollmentId: other.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2026-01-01" });
    const otherPeriods = await listFeePeriodsForEnrollment(otherManagerContext, other.enrollmentId);
    if (!otherPeriods.ok) throw new Error("expected ok");

    const result = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: otherPeriods.periods[0].id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects cross-academy access to another academy's enrollment", async () => {
    const { managerContext } = await withMonthlySchedule();
    const other = await setupFixture();
    const result = await recordFeePeriodPayment(managerContext, {
      studentId: other.studentId,
      enrollmentId: other.enrollmentId,
      allocations: [{ feePeriodId: randomUUID(), amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects an enrollment that does not belong to the given student", async () => {
    const { fixture, managerContext, periods } = await withMonthlySchedule();
    const otherStudentId = await insertStudentDirect(fixture.academyId, fixture.branchId, fixture.creatorUserId);
    const result = await recordFeePeriodPayment(managerContext, {
      studentId: otherStudentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("Admissions Officer cannot record a fee-period payment", async () => {
    const { fixture, periods } = await withMonthlySchedule();
    const { context } = await addActingUser(fixture.academyId, "admissions_officer");
    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  describe("recordEnrollmentPayment — the manual student-payment verification report's simple 'enter one amount' flow", () => {
    it("a payment matching exactly one period's remaining allocates to that one period", async () => {
      const { fixture, managerContext, periods } = await withMonthlySchedule(5000);
      const result = await recordEnrollmentPayment(managerContext, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: 5000,
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.payment.allocations).toEqual([{ feePeriodId: periods[0].id, amountCents: 5000 }]);

      const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
      expect(listed.ok && listed.periods[0].status).toBe("paid");
    });

    it("a larger payment auto-allocates across multiple outstanding periods, oldest first — no checkbox selection needed", async () => {
      const { fixture, managerContext, periods } = await withMonthlySchedule(15000, 3);
      const result = await recordEnrollmentPayment(managerContext, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: 12000, // covers periods[0] (5000) + periods[1] (5000) + 2000 into periods[2]
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.payment.allocations).toEqual([
        { feePeriodId: periods[0].id, amountCents: 5000 },
        { feePeriodId: periods[1].id, amountCents: 5000 },
        { feePeriodId: periods[2].id, amountCents: 2000 },
      ]);

      const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
      expect(listed.ok && listed.periods[0].status).toBe("paid");
      expect(listed.ok && listed.periods[1].status).toBe("paid");
      expect(listed.ok && listed.periods[2].status).toBe("partially_paid");
      expect(listed.ok && listed.periods[2].remainingCents).toBe(3000);
    });

    it("persists reference and notes as separate fields", async () => {
      const { fixture, managerContext } = await withMonthlySchedule(5000);
      const result = await recordEnrollmentPayment(managerContext, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: 5000,
        method: "mobile_money",
        reference: "MM-84920",
        notes: "Second installment",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [row] = await db.select().from(studentPayments).where(eq(studentPayments.id, result.payment.id));
      expect(row.reference).toBe("MM-84920");
      expect(row.notes).toBe("Second installment");
      expect(row.status).toBe("approved");
    });

    it("rejects an amount exceeding the total outstanding balance across every existing period, with no partial application", async () => {
      const { fixture, managerContext, periods } = await withMonthlySchedule(5000);
      // 6 periods generated by withMonthlySchedule's window x 5000 = 30000 total outstanding.
      const totalOutstanding = periods.length * 5000;
      const result = await recordEnrollmentPayment(managerContext, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: totalOutstanding + 1,
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("conflict");

      // No partial application — every period is untouched.
      const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
      expect(listed.ok && listed.periods.every((period) => period.paidCents === 0)).toBe(true);
    });

    it("Finance Officer's payment is immediately effective, no separate approval step", async () => {
      const { fixture } = await withMonthlySchedule(5000);
      const { context } = await addActingUser(fixture.academyId, "finance_officer");
      const result = await recordEnrollmentPayment(context, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: 5000,
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.payment.status).toBe("approved");
    });

    it("rejects a cross-academy enrollment id with the identical generic 'not_found'", async () => {
      const other = await withMonthlySchedule(5000);
      const fixture = await setupFixture();
      const { context } = await addActingUser(fixture.academyId, "manager");
      const result = await recordEnrollmentPayment(context, {
        studentId: other.fixture.studentId,
        enrollmentId: other.fixture.enrollmentId,
        amountCents: 1000,
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    });
  });
});

describe("listEnrollmentsForStudent", () => {
  it("lists only this student's own enrollments, tenant-scoped", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const result = await listEnrollmentsForStudent(context, fixture.studentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollments.map((row) => row.id)).toContain(fixture.enrollmentId);
  });

  it("rejects a student from a different academy", async () => {
    const fixture = await setupFixture();
    const other = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const result = await listEnrollmentsForStudent(context, other.studentId);
    expect(result.ok).toBe(false);
  });
});

describe("fee period generation — 2/4/6-month SCHEDULES (not just 1/3/12) — each generates that many separate monthly installments", () => {
  it("a 2-month schedule generates 2 separate one-month periods, each totalCents/2", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10000, anchorDate: "2026-01-01" });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0]).toMatchObject({ periodStart: "2026-01-01", periodEnd: "2026-01-31", expectedAmountCents: 5000 });
    expect(result.periods[1]).toMatchObject({ periodStart: "2026-02-01", periodEnd: "2026-02-28", expectedAmountCents: 5000 });
  });

  it("a 4-month schedule generates 4 separate one-month periods, each totalCents/4", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 4, amountCents: 20000, anchorDate: "2026-01-01" });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(4);
    expect(result.periods[0]).toMatchObject({ periodStart: "2026-01-01", periodEnd: "2026-01-31", expectedAmountCents: 5000 });
    expect(result.periods[3]).toMatchObject({ periodStart: "2026-04-01", periodEnd: "2026-04-30", expectedAmountCents: 5000 });
  });

  it("a 6-month schedule generates 6 separate one-month periods, each totalCents/6", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 6, amountCents: 30000, anchorDate: "2026-01-01" });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.periods).toHaveLength(6);
    expect(result.periods[0]).toMatchObject({ periodStart: "2026-01-01", periodEnd: "2026-01-31", expectedAmountCents: 5000 });
    expect(result.periods[5]).toMatchObject({ periodStart: "2026-06-01", periodEnd: "2026-06-30", expectedAmountCents: 5000 });
  });

  it("correctly handles the January 31 -> February boundary for a leap year (2028) and a non-leap year (2026)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2026-01-31" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const rows = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const january = rows.find((row) => row.periodStart === "2026-01-31");
    // Non-leap 2026: Jan 31 + 1 month clamps to Feb 28 (Feb's last day),
    // so the period ends the day before, Feb 27.
    expect(january?.periodEnd).toBe("2026-02-27");

    const fixture2 = await setupFixture();
    const { context: context2 } = await addActingUser(fixture2.academyId, "manager");
    await setEnrollmentFeeSchedule(context2, { enrollmentId: fixture2.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2028-01-31" });
    await generateFeePeriodsForEnrollment(db, fixture2.enrollmentId, fixture2.academyId);
    const rows2 = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture2.enrollmentId));
    const january2028 = rows2.find((row) => row.periodStart === "2028-01-31");
    // Leap year 2028: Jan 31 + 1 month clamps to Feb 29 (Feb's last day,
    // 29 in a leap year), so the period ends the day before, Feb 28.
    expect(january2028?.periodEnd).toBe("2028-02-28");
  });
});

describe("getEnrollmentPaymentSummary", () => {
  it("reads UNPAID immediately after enrollment, even when the first period is anchored in the future", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2030-01-01" });

    const summary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.summary.expectedCents).toBe(5000);
    expect(summary.summary.paidCents).toBe(0);
    expect(summary.summary.remainingCents).toBe(5000);
    expect(summary.summary.status).toBe("unpaid");
  });

  it("reads PARTIALLY_PAID once some but not all of the relevant periods are paid", async () => {
    const fixture = await setupFixture();
    const { context: managerContext } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(managerContext, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 2000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    if (!recorded.ok) throw new Error("expected ok");

    const summary = await getEnrollmentPaymentSummary(managerContext, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.summary.paidCents).toBe(2000);
    expect(summary.summary.remainingCents).toBe(3000);
    expect(summary.summary.status).toBe("partially_paid");
  });

  it("reads PAID once the relevant period(s) are fully covered by approved payments", async () => {
    const fixture = await setupFixture();
    const { context: managerContext } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(managerContext, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const recorded = await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 5000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(recorded.ok).toBe(true);

    const summary = await getEnrollmentPaymentSummary(managerContext, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.summary.status).toBe("paid");
    expect(summary.summary.remainingCents).toBe(0);
  });

  it("reads OVERDUE when a relevant period is past its due date with money still owed", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored well in the past relative to the real system clock, so the
    // first period's due date has definitely already passed.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2020-01-01" });

    const summary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.summary.status).toBe("overdue");
  });

  it("never reaches PAID merely because the enrollment/schedule was created — requires real approved payments", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5000, anchorDate: "2030-01-01" });

    const summary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.summary.status).not.toBe("paid");
    expect(summary.summary.paidCents).toBe(0);
  });
});

describe("regression: changing the schedule back DOWN (6-month -> monthly) without the caller moving anchorDate never overlaps", () => {
  it("6-month -> monthly, same submitted anchor: no overlap, the paid first installment stays untouched, the remaining balance carries into the new single monthly installment", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 6,
      amountCents: 600, // $1.00/month x 6
      anchorDate: todayDateOnlyInAcademyTimezone(),
    });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const beforeChange = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(beforeChange).toHaveLength(6); // all 6 monthly installments generated upfront
    const firstInstallment = beforeChange[0];
    expect(firstInstallment.periodStart).toBe(todayDateOnlyInAcademyTimezone());
    expect(firstInstallment.expectedAmountCents).toBe(100);

    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: firstInstallment.id, amountCents: 100 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    // Switch down to monthly — anchorDate left exactly as submitted (the
    // same "form pre-fills the old anchor date" real-world flow);
    // `setEnrollmentFeeSchedule` itself moves it past the paid first
    // installment, and auto-carries the $5.00 remaining balance.
    const changed = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 999_999, // irrelevant — overridden by auto-carry
      anchorDate: todayDateOnlyInAcademyTimezone(),
    });
    expect(changed.ok).toBe(true);
    expect(changed.ok && changed.schedule.amountCents).toBe(500);

    const afterChange = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const firstAfter = afterChange.find((row) => row.id === firstInstallment.id)!;
    expect(firstAfter).toEqual(firstInstallment); // byte-for-byte untouched, payment preserved

    // The 5 remaining unpaid old-schedule installments are gone — replaced
    // by exactly ONE new monthly installment of the carried-over $5.00.
    expect(afterChange).toHaveLength(2);
    const newInstallment = afterChange.find((row) => row.id !== firstInstallment.id)!;
    expect(newInstallment.periodStart > firstInstallment.periodStart).toBe(true);
    expect(newInstallment.expectedAmountCents).toBe(500);
    expect(newInstallment.periodStart > firstInstallment.periodEnd).toBe(true);

    const allocationsForFirst = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, firstInstallment.id));
    expect(allocationsForFirst).toHaveLength(1);
  });
});

describe("step 5 — multiple payments in the same calendar month (no 'one payment per month' rule)", () => {
  it("two separate payments in the same month: first partially pays, second finishes it, third rolls onto the next period — never touching an unrelated period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    // Anchored well in the future so no generated period is ever "overdue"
    // — this test is about same-month payment sequencing, not status
    // derivation (same convention as withMonthlySchedule's own comment
    // above). "September"/"October" below just names the two periods.
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 2,
      amountCents: 20_000, // $100/month x 2
      anchorDate: "2030-09-01",
    });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [september, october] = periods;

    // 1. Student has an unpaid period (September, $100 expected, $0 paid).
    const initial = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(initial.ok && initial.periods[0].status).toBe("unpaid");

    // 2. Record payment #1 — $60, same calendar month as #2 below.
    const payment1 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: september.id, amountCents: 6_000 }],
      method: "cash",
      receivedAt: new Date("2030-09-05T10:00:00Z"),
    });
    expect(payment1.ok).toBe(true);

    let listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("partially_paid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(6_000);
    expect(listed.ok && listed.periods[0].remainingCents).toBe(4_000);
    // October must be completely untouched by payment #1.
    expect(listed.ok && listed.periods[1].paidCents).toBe(0);

    // 3. Later in the SAME calendar month, record payment #2 — the
    // remaining $40 for September. Both payments must be accepted as
    // separate, distinct student_payments rows.
    const payment2 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: september.id, amountCents: 4_000 }],
      method: "cash",
      receivedAt: new Date("2030-09-25T10:00:00Z"),
    });
    expect(payment2.ok).toBe(true);
    if (!payment1.ok || !payment2.ok) return;
    expect(payment2.payment.id).not.toBe(payment1.payment.id);

    const paymentRows = await db
      .select()
      .from(studentPayments)
      .where(and(eq(studentPayments.studentId, fixture.studentId), eq(studentPayments.status, "approved")));
    expect(paymentRows).toHaveLength(2); // two distinct, separately-recorded transactions

    // 4/5. September is now fully paid; October remains completely unpaid —
    // no payment may make an unrelated period appear paid.
    listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("paid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(10_000);
    expect(listed.ok && listed.periods[1].status).toBe("unpaid");
    expect(listed.ok && listed.periods[1].paidCents).toBe(0);

    // 6. A later payment (October) allocates to the next valid outstanding
    // period once September is fully paid.
    const payment3 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: october.id, amountCents: 10_000 }],
      method: "cash",
      receivedAt: new Date("2030-10-03T10:00:00Z"),
    });
    expect(payment3.ok).toBe(true);

    listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("paid"); // September still paid, untouched
    expect(listed.ok && listed.periods[0].paidCents).toBe(10_000); // never inflated by payment #3
    expect(listed.ok && listed.periods[1].status).toBe("paid"); // October now paid by its own, separate payment
    expect(listed.ok && listed.periods[1].paidCents).toBe(10_000);
  });

  it("recordEnrollmentPayment's auto-allocator also accepts two separate same-month payments without a 'one payment per month' restriction", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const first = await recordEnrollmentPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      amountCents: 2_000,
      method: "cash",
      receivedAt: new Date("2030-01-05T00:00:00Z"),
    });
    expect(first.ok).toBe(true);

    // Nothing blocks a SECOND payment the same "month" — no such rule
    // exists anywhere in recordFeePeriodPayment/recordEnrollmentPayment.
    const second = await recordEnrollmentPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      amountCents: 3_000,
      method: "cash",
      receivedAt: new Date("2030-01-20T00:00:00Z"),
    });
    expect(second.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok && listed.periods[0].status).toBe("paid");
    expect(listed.ok && listed.periods[0].paidCents).toBe(5_000);
  });
});

describe("one payment allocation cannot affect another period (explicit, literal check)", () => {
  it("allocating a payment to period A leaves period B's paid/remaining/status completely unchanged", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    const [periodA, periodB] = periods;

    const before = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const periodBBefore = before.ok ? before.periods.find((p) => p.id === periodB.id) : undefined;
    expect(periodBBefore?.paidCents).toBe(0);

    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periodA.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    const after = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const periodAAfter = after.ok ? after.periods.find((p) => p.id === periodA.id) : undefined;
    const periodBAfter = after.ok ? after.periods.find((p) => p.id === periodB.id) : undefined;
    expect(periodAAfter?.status).toBe("paid");
    expect(periodBAfter?.status).toBe("unpaid"); // completely unaffected
    expect(periodBAfter?.paidCents).toBe(0);
    expect(periodBAfter?.remainingCents).toBe(5_000);
  });
});

describe("Students-list summary matches the single-enrollment summary (same derivation, batched vs. not)", () => {
  it("getStudentPaymentSummaries and getEnrollmentPaymentSummary agree exactly for the same enrollment", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2020-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: periods[0].id, amountCents: 2_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const enrollmentSummary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(enrollmentSummary.ok).toBe(true);
    if (!enrollmentSummary.ok) return;

    const batched = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const listSummary = batched.get(fixture.studentId);
    expect(listSummary).toBeDefined();
    if (!listSummary) return;

    expect(listSummary.expectedCents).toBe(enrollmentSummary.summary.expectedCents);
    expect(listSummary.paidCents).toBe(enrollmentSummary.summary.paidCents);
    expect(listSummary.remainingCents).toBe(enrollmentSummary.summary.remainingCents);
    expect(listSummary.status).toBe(enrollmentSummary.summary.status);
  });
});

describe("legacy corrupted-data detection and safety (does NOT touch/fix anything — read-only)", () => {
  /** Same self-join overlap-detection query as scripts/audit-fee-periods.ts
   * — kept in sync deliberately: this is the exact SQL the read-only audit
   * script uses to find affected enrollments, now under test so a future
   * change can't silently break the one tool this task relies on for safe
   * detection of corrupted data. */
  async function findOverlappingPairs(enrollmentId: string, executor: Pick<typeof db, "execute"> = db) {
    const result = await executor.execute(sql`
      SELECT a.id AS a_id, b.id AS b_id
      FROM fee_periods a
      JOIN fee_periods b
        ON a.enrollment_id = b.enrollment_id
       AND a.id < b.id
       AND a.period_start <= b.period_end
       AND a.period_end >= b.period_start
      WHERE a.enrollment_id = ${enrollmentId}
    `);
    return result.rows as Array<{ a_id: string; b_id: string }>;
  }

  /** Whether migration 0028's fee_periods_no_overlap constraint is present
   * here. Where it is, legacy overlapping rows cannot exist (the database
   * correctly refuses them), so these tests can't plant them in the real
   * table — see each test for how it handles that. */
  async function overlapConstraintPresent(): Promise<boolean> {
    const check = await db.execute(sql`SELECT 1 FROM pg_constraint WHERE conname = 'fee_periods_no_overlap'`);
    return check.rows.length > 0;
  }

  it("detects two directly-seeded overlapping fee_periods rows for the same enrollment (simulating pre-fix legacy data)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 100, anchorDate: "2026-09-28" });

    if (await overlapConstraintPresent()) {
      // The constraint (correctly) refuses overlapping rows in the real
      // table, so the audit query is exercised against a constraint-free
      // TEMPORARY copy instead: inside one transaction, an unqualified
      // `fee_periods` resolves to the temp table (pg_temp is searched
      // first), which is dropped at commit. The real table and its
      // constraint are never touched.
      await db.transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE fee_periods (LIKE public.fee_periods INCLUDING DEFAULTS) ON COMMIT DROP`);
        const planted = await tx.execute(sql`
          INSERT INTO fee_periods (academy_id, enrollment_id, interval_months, period_start, period_end, due_date, expected_amount_cents, currency)
          VALUES
            (${fixture.academyId}, ${fixture.enrollmentId}, 1, '2026-09-28', '2026-10-27', '2026-09-28', 100, 'USD'),
            (${fixture.academyId}, ${fixture.enrollmentId}, 6, '2026-09-28', '2027-03-27', '2026-09-28', 100, 'USD')
          RETURNING id
        `);
        const plantedIds = new Set((planted.rows as { id: string }[]).map((row) => row.id));
        const pairs = await findOverlappingPairs(fixture.enrollmentId, tx);
        expect(pairs).toHaveLength(1);
        expect(new Set([pairs[0].a_id, pairs[0].b_id])).toEqual(plantedIds);
      });
      // Nothing was written to the real table.
      expect(await findOverlappingPairs(fixture.enrollmentId)).toEqual([]);
      return;
    }

    // Deliberately bypass generateFeePeriodsForEnrollment to plant an
    // overlapping pair directly — reproducing what the OLD (pre-fix)
    // generator used to produce, without depending on that old code path
    // (which no longer exists) still being reachable.
    const [monthly] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        periodStart: "2026-09-28",
        periodEnd: "2026-10-27",
        dueDate: "2026-09-28",
        expectedAmountCents: 100,
        currency: "USD",
      })
      .returning();
    const [sixMonth] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 6,
        periodStart: "2026-09-28",
        periodEnd: "2027-03-27",
        dueDate: "2026-09-28",
        expectedAmountCents: 100,
        currency: "USD",
      })
      .returning();

    const pairs = await findOverlappingPairs(fixture.enrollmentId);
    expect(pairs).toHaveLength(1);
    expect(new Set([pairs[0].a_id, pairs[0].b_id])).toEqual(new Set([monthly.id, sixMonth.id]));
  });

  it("even with legacy overlapping periods present, a payment allocated to ONE of them never appears as paid on the other (allocation-based aggregation is corruption-proof)", async (ctx) => {
    if (await overlapConstraintPresent()) {
      // Overlapping rows can't exist where the constraint is present (the
      // "database-level protection" block below asserts the rejection), so
      // there is no legacy data for this guarantee to protect here. Still
      // runs, unchanged, on any database without migration 0028.
      ctx.skip("fee_periods_no_overlap is present here: legacy overlapping periods cannot exist in this database.");
      return;
    }
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored in the future so the unpaid overlapping period reads
    // "unpaid," not "overdue" — this test is about allocation isolation,
    // not status derivation.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 100, anchorDate: "2030-09-28" });

    const [monthly] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        periodStart: "2030-09-28",
        periodEnd: "2030-10-27",
        dueDate: "2030-09-28",
        expectedAmountCents: 100,
        currency: "USD",
      })
      .returning();
    const [sixMonth] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 6,
        periodStart: "2030-09-28",
        periodEnd: "2031-03-27",
        dueDate: "2030-09-28",
        expectedAmountCents: 100,
        currency: "USD",
      })
      .returning();

    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: monthly.id, amountCents: 100 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const monthlyAfter = listed.periods.find((p) => p.id === monthly.id);
    const sixMonthAfter = listed.periods.find((p) => p.id === sixMonth.id);
    expect(monthlyAfter?.status).toBe("paid");
    // The overlapping 6-month period must NOT be marked paid by the same
    // payment — it received no allocation of its own.
    expect(sixMonthAfter?.status).toBe("unpaid");
    expect(sixMonthAfter?.paidCents).toBe(0);
  });
});

describe("database-level protection: fee_periods_no_overlap exclusion constraint", () => {
  /**
   * Migration drizzle/0028_fee_periods_no_overlap.sql adds a Postgres
   * EXCLUDE USING gist constraint so overlap is impossible even outside
   * generateFeePeriodsForEnrollment's own application-level guard. It is
   * NOT auto-applied to every environment this suite might run against
   * (see scripts/audit-fee-periods.ts and the task's own audit report):
   * on at least one real dataset, pre-existing legacy overlapping
   * fee_periods rows (created before generateFeePeriodsForEnrollment's
   * resume-after-latest-period fix existed) block the migration from ever
   * being applied until that data is deliberately remediated — the
   * migration deliberately does NOT force itself through by altering that
   * data. This test therefore checks whether the constraint is actually
   * present before asserting anything about it, and skips (rather than
   * failing the whole suite on an environment where the migration
   * legitimately hasn't been applied yet) when it isn't — once remediation
   * unblocks the migration and it's applied, this test starts actually
   * exercising the constraint with no code change required.
   */
  it("rejects an INSERT that would overlap an existing fee_periods row for the same enrollment, when the constraint is present", async (ctx) => {
    const constraintCheck = await db.execute(
      sql`SELECT 1 FROM pg_constraint WHERE conname = 'fee_periods_no_overlap'`,
    );
    if (constraintCheck.rows.length === 0) {
      ctx.skip(
        "fee_periods_no_overlap constraint is not present in this database (migration 0028 has not been " +
          "applied here — see the task's audit report for why) — nothing to verify yet.",
      );
      return;
    }

    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 100, anchorDate: "2026-09-28" });
    await db.insert(feePeriods).values({
      academyId: fixture.academyId,
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      periodStart: "2026-09-28",
      periodEnd: "2026-10-27",
      dueDate: "2026-09-28",
      expectedAmountCents: 100,
      currency: "USD",
    });

    await expect(
      db.insert(feePeriods).values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 6,
        periodStart: "2026-09-28", // overlaps the row above
        periodEnd: "2027-03-27",
        dueDate: "2026-09-28",
        expectedAmountCents: 100,
        currency: "USD",
      }),
    ).rejects.toThrow();

    // A non-overlapping insert for the SAME enrollment must still succeed —
    // the constraint must never block legitimate, non-overlapping periods.
    await expect(
      db.insert(feePeriods).values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        periodStart: "2026-10-28",
        periodEnd: "2026-11-27",
        dueDate: "2026-10-28",
        expectedAmountCents: 100,
        currency: "USD",
      }),
    ).resolves.toBeDefined();
  });
});

describe("explicit spec scenarios — per-period Record Payment behavior", () => {
  /** Test 1 — a monthly schedule's later, not-yet-started period must never
   * inflate what's "currently due." getEnrollmentPaymentSummary already
   * only rolls up periods whose periodStart has arrived (selectRelevantPeriods)
   * — this pins that behavior down explicitly, under the exact "sequential
   * monthly periods" shape §7 describes. */
  it("Test 1 — a monthly schedule's future (not-yet-started) period is never treated as currently due", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored so the FIRST period has already started (relative to real
    // wall-clock "today") but a second monthly period exists and has not.
    const anchor = new Date();
    anchor.setUTCDate(anchor.getUTCDate() - 5); // started 5 days ago
    const anchorDate = anchor.toISOString().slice(0, 10);
    // A 2-month schedule: both monthly installments are generated
    // up-front by the schedule call itself, so the second (future) one
    // already exists without any extra generation call.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10_000, anchorDate });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);

    const summary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // Only the already-started period counts toward "currently due" — the
    // future period's $50 is NOT added on top.
    expect(summary.summary.expectedCents).toBe(5_000);
    expect(summary.summary.periodsConsidered).toBe(1);
  });

  /** Test 2 — a genuinely UNPAID period: status, and that a targeted
   * per-period payment lands on exactly that period. */
  it("Test 2 — UNPAID period: status is unpaid, and a per-period payment targets exactly that period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart);
    const target = periods[0];

    const before = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(before.ok && before.periods.find((p) => p.id === target.id)?.status).toBe("unpaid");

    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: target.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.allocations).toEqual([{ feePeriodId: target.id, amountCents: 5_000 }]);

    const after = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const targetAfter = after.ok ? after.periods.find((p) => p.id === target.id) : undefined;
    expect(targetAfter?.status).toBe("paid");
    // No other period was touched.
    const others = after.ok ? after.periods.filter((p) => p.id !== target.id) : [];
    expect(others.every((p) => p.paidCents === 0)).toBe(true);
  });

  /** Tests 3 & 4 — the ticket's own worked example: Expected $5.55, pay
   * $2.00 (PARTIALLY_PAID), then pay the remaining $3.55 (PAID). */
  it("Tests 3 & 4 — $5.55 expected: $2.00 pays partially, the remaining $3.55 completes it", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 555, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(period.expectedAmountCents).toBe(555);

    // Test 3 — pay $2.00.
    const payment1 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 200 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(payment1.ok).toBe(true);

    let listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    let row = listed.ok ? listed.periods.find((p) => p.id === period.id) : undefined;
    expect(row?.paidCents).toBe(200);
    expect(row?.remainingCents).toBe(355);
    expect(row?.status).toBe("partially_paid");
    expect(row && row.remainingCents > 0).toBe(true); // Record Payment remains available

    // Test 4 — pay the remaining $3.55.
    const payment2 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 355 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(payment2.ok).toBe(true);

    listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    row = listed.ok ? listed.periods.find((p) => p.id === period.id) : undefined;
    expect(row?.paidCents).toBe(555);
    expect(row?.remainingCents).toBe(0);
    expect(row?.status).toBe("paid");
    // The normal per-period Record Payment action is no longer available —
    // the UI keys this off remainingCents > 0, which is now false.
    expect(row?.remainingCents).toBe(0);
  });

  /** Test 5 — an OVERDUE period: still shows its remaining balance, and a
   * targeted payment lands on exactly that period. */
  it("Test 5 — OVERDUE period: shows remaining balance, and Record Payment targets that exact period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored well in the past so the period's due date has definitely
    // already passed with money still owed.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2020-01-01" });

    // listFeePeriodsForEnrollment lazily generates periods through today —
    // must run before querying feePeriods directly, or no rows exist yet.
    const before = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeRow = before.periods[0];
    expect(beforeRow?.status).toBe("overdue");
    expect(beforeRow?.remainingCents).toBe(5_000);

    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    const after = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const afterRow = after.ok ? after.periods.find((p) => p.id === period.id) : undefined;
    expect(afterRow?.status).toBe("paid");
    expect(afterRow?.remainingCents).toBe(0);
  });

  /** Test 6 — the ticket's exact same-fee-period, same-month scenario:
   * $2 then $3.55, both represented as separate payment records, period
   * ends up fully paid. */
  it("Test 6 — two payments in the same month against the same period ($2 then $3.55) are both recorded separately and the period becomes fully paid", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 555, anchorDate: "2030-09-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    const payment1 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 200 }],
      method: "cash",
      receivedAt: new Date("2030-09-05T09:00:00Z"),
    });
    const payment2 = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 355 }],
      method: "cash",
      receivedAt: new Date("2030-09-20T09:00:00Z"),
    });
    expect(payment1.ok).toBe(true);
    expect(payment2.ok).toBe(true);
    if (!payment1.ok || !payment2.ok) return;
    expect(payment1.payment.id).not.toBe(payment2.payment.id);

    const paymentRows = await db
      .select()
      .from(studentPayments)
      .where(and(eq(studentPayments.studentId, fixture.studentId), eq(studentPayments.status, "approved")));
    expect(paymentRows).toHaveLength(2);

    // No duplicate fee-period obligation was created by having two payments
    // in the same month — still exactly one period row.
    const periodRows = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(periodRows.filter((p) => p.periodStart === period.periodStart)).toHaveLength(1);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const row = listed.ok ? listed.periods.find((p) => p.id === period.id) : undefined;
    expect(row?.status).toBe("paid");
    expect(row?.paidCents).toBe(555);
  });

  /** Test 7 — once a period is fully paid, a further normal per-period
   * payment attempt against it must be rejected outright, never silently
   * allocated. */
  it("Test 7 — a normal payment attempt against an already-fully-paid period is rejected, not silently allocated", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    // Simulates "the form was open with a stale remaining balance and the
    // period became fully paid before submit" (§9) — the backend must
    // reject this regardless of what the client believed the balance was.
    const secondAttempt = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 1 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(secondAttempt.ok).toBe(false);
    if (!secondAttempt.ok) expect(secondAttempt.error.code).toBe("conflict");

    // The period's paid figure is completely unaffected by the rejected attempt.
    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    const row = listed.ok ? listed.periods.find((p) => p.id === period.id) : undefined;
    expect(row?.paidCents).toBe(5_000);
    expect(row?.status).toBe("paid");
  });

  /** Test 8 — once the current period is paid, the next chronologically
   * outstanding period becomes the next payment target — the exact
   * client-side ordering NextOutstandingBanner uses (oldest unpaid
   * periodStart first), verified against the real server-computed periods. */
  it("Test 8 — after the current period is paid, the next outstanding period (oldest-first) becomes the next target", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    const [first, second] = periods;

    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: first.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Same computation NextOutstandingBanner performs client-side: oldest
    // periodStart among remainingCents > 0.
    const nextOutstanding = [...listed.periods]
      .filter((p) => p.remainingCents > 0)
      .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))[0];
    expect(nextOutstanding?.id).toBe(second.id);
  });

  /** Test 11 — tenant isolation for the new per-period payment action:
   * an attacker who legitimately belongs to their OWN academy must never be
   * able to allocate a payment against a DIFFERENT academy's fee period, even
   * when supplying their own valid studentId/enrollmentId alongside the
   * victim's real feePeriodId (the classic IDOR shape). */
  it("Test 11 — a fee period belonging to a different academy cannot be paid, even via the attacker's own valid enrollment", async () => {
    const victim = await setupFixture();
    const { context: victimContext } = await addActingUser(victim.academyId, "manager");
    await setEnrollmentFeeSchedule(victimContext, { enrollmentId: victim.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2030-01-01" });
    await generateFeePeriodsForEnrollment(db, victim.enrollmentId, victim.academyId);
    const [victimPeriod] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, victim.enrollmentId));

    const attacker = await setupFixture();
    const { context: attackerContext } = await addActingUser(attacker.academyId, "manager");
    await setEnrollmentFeeSchedule(attackerContext, { enrollmentId: attacker.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2030-01-01" });

    // Attacker supplies THEIR OWN valid studentId/enrollmentId (so the
    // student/enrollment tenant checks alone wouldn't catch this) but the
    // VICTIM's real fee_periods id.
    const result = await recordFeePeriodPayment(attackerContext, {
      studentId: attacker.studentId,
      enrollmentId: attacker.enrollmentId,
      allocations: [{ feePeriodId: victimPeriod.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    // The victim's period is completely untouched.
    const victimListed = await listFeePeriodsForEnrollment(victimContext, victim.enrollmentId);
    const victimRow = victimListed.ok ? victimListed.periods.find((p) => p.id === victimPeriod.id) : undefined;
    expect(victimRow?.paidCents).toBe(0);
    expect(victimRow?.status).toBe("unpaid");
  });
});

describe("Students list — Record Payment targeting (getStudentPaymentSummaries.nextOutstandingPeriod)", () => {
  /** Test A — a genuinely unpaid current period surfaces as
   * nextOutstandingPeriod, matching the row a Students-list payment must
   * target. */
  it("Test A — unpaid student: nextOutstandingPeriod is the current unpaid period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.status).toBe("unpaid");
    expect(summary?.nextOutstandingPeriod?.id).toBe(period.id);
    expect(summary?.nextOutstandingPeriod?.remainingCents).toBe(5_000);
  });

  /** Test B — an overdue period: status overdue, nextOutstandingPeriod
   * present and pointing at that overdue period. */
  it("Test B — overdue student: status is overdue, nextOutstandingPeriod targets the overdue period", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: "2020-01-01" });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart);

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.status).toBe("overdue");
    expect(summary?.nextOutstandingPeriod?.id).toBe(period.id);
    expect(summary?.nextOutstandingPeriod?.status).toBe("overdue");
  });

  /** Test C — a partially paid period: remaining is correct, and
   * nextOutstandingPeriod's own remainingCents matches (single-period
   * enrollment, so the aggregate and the targeted period agree exactly) —
   * this is what the Students-list dialog defaults its amount field to. */
  it("Test C — partially paid student: remaining is correct, nextOutstandingPeriod defaults to the exact remaining balance", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 555, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 200 }],
      method: "cash",
      receivedAt: new Date(),
    });

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.status).toBe("partially_paid");
    expect(summary?.remainingCents).toBe(355);
    expect(summary?.nextOutstandingPeriod?.id).toBe(period.id);
    expect(summary?.nextOutstandingPeriod?.remainingCents).toBe(355);
  });

  /** Test D — fully paid: remaining 0, status paid, nextOutstandingPeriod
   * null — the Students-list Actions dropdown must never render "Record
   * Payment" for this row (see students-list.tsx's own gating on this
   * exact field being non-null). */
  it("Test D — fully paid student: remaining is 0, status is paid, nextOutstandingPeriod is null", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));

    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.status).toBe("paid");
    expect(summary?.remainingCents).toBe(0);
    expect(summary?.nextOutstandingPeriod).toBeNull();
  });

  /** Test E — every already-started period is paid; only a FUTURE period
   * (not yet started) remains unpaid. The Students list must not show a
   * current payment obligation, and nextOutstandingPeriod must be null even
   * though a raw fee_periods row with remainingCents > 0 genuinely exists
   * in the database — it's simply not "relevant" yet. */
  it("Test E — future-only student: a real, generated future period must NOT surface as a current obligation", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // A 2-month schedule: both monthly installments are generated
    // up-front, so a genuinely future, not-yet-started one exists
    // alongside today's current one without any extra generation call.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10_000, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [currentPeriod, futurePeriod] = periods;

    // Pay off the one already-started period in full.
    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: currentPeriod.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    // Confirm, directly, that the future period genuinely exists, unpaid,
    // in the database — this is not a hypothetical.
    const rawFutureRow = await db.select().from(feePeriods).where(eq(feePeriods.id, futurePeriod.id));
    expect(rawFutureRow).toHaveLength(1);

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.status).toBe("paid");
    expect(summary?.remainingCents).toBe(0);
    expect(summary?.nextOutstandingPeriod).toBeNull(); // never the future period
  });

  /** Test F — two already-started outstanding periods: the Students list
   * must target the OLDEST one, never the later one. */
  it("Test F — multiple outstanding periods: nextOutstandingPeriod is the oldest, never a later/future one", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored 2 months back so both the first and second monthly periods
    // have already started as of "today."
    const anchor = new Date();
    anchor.setUTCMonth(anchor.getUTCMonth() - 2);
    const anchorDate = anchor.toISOString().slice(0, 10);
    // A 3-month schedule anchored 2 months back: the first two monthly
    // installments have already started as of "today."
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 15_000, anchorDate });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods.length).toBeGreaterThanOrEqual(2);
    const [oldest] = periods;

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summary = summaries.get(fixture.studentId);
    expect(summary?.nextOutstandingPeriod?.id).toBe(oldest.id);
  });

  /** Test G — recording a payment "from the Students list" (i.e. targeting
   * `nextOutstandingPeriod.id` exactly as students-list.tsx's
   * RecordPaymentDialog does) goes through the SAME recordFeePeriodPayment
   * function and produces the SAME student_payments/payment_allocations
   * shape as the Fee Periods/Student Detail pages — never a parallel
   * implementation. */
  it("Test G — a payment targeting nextOutstandingPeriod uses the same recordFeePeriodPayment mechanism and updates the summary", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const before = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const target = before.get(fixture.studentId)?.nextOutstandingPeriod;
    expect(target).toBeTruthy();
    if (!target) return;

    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: target.enrollmentId,
      allocations: [{ feePeriodId: target.id, amountCents: target.remainingCents }],
      method: "cash",
      reference: "STUDENTS-LIST-TEST",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Same shape recordFeePeriodPayment always produces — a real
    // student_payments row plus a payment_allocations row, both queryable
    // through the standard schema exactly like any other recorded payment.
    const [paymentRow] = await db.select().from(studentPayments).where(eq(studentPayments.id, result.payment.id));
    expect(paymentRow.status).toBe("approved");
    expect(paymentRow.reference).toBe("STUDENTS-LIST-TEST");
    const allocationRows = await db.select().from(paymentAllocations).where(eq(paymentAllocations.studentPaymentId, result.payment.id));
    expect(allocationRows).toHaveLength(1);
    expect(allocationRows[0].feePeriodId).toBe(target.id);

    const after = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const summaryAfter = after.get(fixture.studentId);
    expect(summaryAfter?.status).toBe("paid");
    expect(summaryAfter?.remainingCents).toBe(0);
    expect(summaryAfter?.nextOutstandingPeriod).toBeNull();
  });

  /** Test H — cross-academy protection for the Students-list flow
   * specifically: getStudentPaymentSummaries, given a foreign studentId
   * alongside the caller's own academyId, must never surface that foreign
   * student's period at all (so the client never even HAS a foreign
   * feePeriodId to submit) — and even if it somehow did, recordFeePeriodPayment
   * itself independently refuses it (already covered by Test 11 above; this
   * test closes the loop at the summary-batching layer the Students list
   * actually reads from). */
  it("Test H — getStudentPaymentSummaries never returns another academy's fee period, even when queried with a foreign studentId", async () => {
    const victim = await setupFixture();
    const { context: victimContext } = await addActingUser(victim.academyId, "manager");
    await setEnrollmentFeeSchedule(victimContext, { enrollmentId: victim.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: todayIsoDate() });
    await generateFeePeriodsForEnrollment(db, victim.enrollmentId, victim.academyId);

    const attacker = await setupFixture();

    // Query under the ATTACKER's academyId, but including the VICTIM's real
    // studentId in the id list (simulating a manipulated/guessed client
    // request) — the victim's summary must be completely absent, never a
    // cross-academy leak of their fee period.
    const summaries = await getStudentPaymentSummaries(attacker.academyId, [attacker.studentId, victim.studentId]);
    expect(summaries.has(victim.studentId)).toBe(false);

    // And recording a payment against the (never-exposed) victim period id
    // is still independently refused, matching Test 11's finding.
    const [victimPeriod] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, victim.enrollmentId));
    const { context: attackerContext } = await addActingUser(attacker.academyId, "manager");
    await setEnrollmentFeeSchedule(attackerContext, { enrollmentId: attacker.enrollmentId, intervalMonths: 1, amountCents: 5_000, anchorDate: todayIsoDate() });
    const attempt = await recordFeePeriodPayment(attackerContext, {
      studentId: attacker.studentId,
      enrollmentId: attacker.enrollmentId,
      allocations: [{ feePeriodId: victimPeriod.id, amountCents: 5_000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe("not_found");
  });

  /** The exact worked example from the "make the Student List the main
   * place for recording payments" request: September $5.55 remaining,
   * October $5.55 remaining — a $5.55 payment fully pays September, and the
   * NEXT payment (from the Students list, with no manual period choice)
   * must automatically target October, never re-target September or land
   * on a later/future period. */
  it("sequential Students-list payments: paying the oldest outstanding period in full automatically advances the target to the next one", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const anchor = new Date();
    anchor.setUTCMonth(anchor.getUTCMonth() - 1); // last month's period has already started
    const anchorDate = anchor.toISOString().slice(0, 10);
    // A 2-month schedule: both monthly installments are generated
    // up-front by the schedule call itself.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 1_110, anchorDate });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [september, october] = periods;

    // Students list opens Record Payment — it must target September first.
    const before = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    expect(before.get(fixture.studentId)?.nextOutstandingPeriod?.id).toBe(september.id);

    // Pay September in full, exactly as the dialog's default amount would.
    const septemberTarget = before.get(fixture.studentId)!.nextOutstandingPeriod!;
    const firstPayment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: septemberTarget.enrollmentId,
      allocations: [{ feePeriodId: septemberTarget.id, amountCents: septemberTarget.remainingCents }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(firstPayment.ok).toBe(true);

    // Without the staff choosing anything, the Students list's next Record
    // Payment click must now target October — never September again, never
    // a later/future period.
    const after = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const nextTarget = after.get(fixture.studentId)?.nextOutstandingPeriod;
    expect(nextTarget?.id).toBe(october.id);
    expect(nextTarget?.remainingCents).toBe(555);

    // Pay October too, exactly the same way.
    const secondPayment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: nextTarget!.enrollmentId,
      allocations: [{ feePeriodId: nextTarget!.id, amountCents: nextTarget!.remainingCents }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(secondPayment.ok).toBe(true);

    // September's own allocation is completely unaffected by paying October.
    const septemberAllocations = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, september.id));
    expect(septemberAllocations).toHaveLength(1);
    expect(septemberAllocations[0].amountCents).toBe(555);
  });

  /** "Do not accidentally select a future period when an older overdue/
   * unpaid period still has a balance" — an enrollment with both an
   * old, already-overdue period AND a genuinely future (not-yet-started)
   * period must always target the old one first, never the future one,
   * regardless of how far apart they are or how the periods were
   * generated. */
  it("never targets a future period while an older overdue period is still unpaid", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // A 12-month (maximum) schedule anchored 10 months back: the first
    // installment is genuinely overdue, while the schedule's own LAST
    // installment (anchor + 11 months) is still genuinely in the future —
    // both exist simultaneously within this one bounded schedule.
    const anchor = new Date();
    anchor.setUTCMonth(anchor.getUTCMonth() - 10);
    const anchorDate = anchor.toISOString().slice(0, 10);
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 12, amountCents: 60_000, anchorDate });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(12);
    const overduePeriod = periods[0];
    const futurePeriod = periods[periods.length - 1];
    expect(futurePeriod.periodStart > todayIsoDate()).toBe(true); // genuinely future

    const summaries = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const target = summaries.get(fixture.studentId)?.nextOutstandingPeriod;
    expect(target?.id).toBe(overduePeriod.id);
    expect(target?.id).not.toBe(futurePeriod.id);
    expect(target?.status).toBe("overdue");
  });
});

/**
 * Reported bug: "period 2 keeps showing UNPAID + UPCOMING (and the student
 * summary keeps reading fully paid/$0 remaining) even once period 2's own
 * due date has passed." Investigated via a self-cleaning diagnostic probe
 * (scripts/probe-period-status-bug.ts, anchored relative to the REAL server
 * clock — not a hard-coded future date) before writing any test or touching
 * any code. Findings, checked against every layer the ticket asked about:
 *
 *  - `selectRelevantPeriods` (period_start vs. today, string-compare,
 *    matching the server's own UTC-based `todayDateOnly()` on both sides —
 *    no second date system, no local-vs-UTC mismatch in the comparison
 *    itself): once a period's `periodStart <= today`, it IS included in the
 *    relevant window — confirmed empirically via the probe, not assumed.
 *  - `aggregateEnrollmentPeriods`: sums ALL relevant periods (never just the
 *    most recent one), so a paid period-1 + an overdue period-2 correctly
 *    yields remainingCents > 0 and status "overdue" at the aggregate level.
 *  - `getStudentPaymentSummaries`'s `nextOutstandingPeriod`: derived from
 *    that SAME relevant-periods list, so it picks up period 2 the instant
 *    the aggregate does — never lags behind it.
 *  - The client-side "Upcoming" badge (`isFuturePeriod` in
 *    fee-periods-manager.tsx/student-detail.tsx) is gated behind the
 *    server-computed `period.status === "unpaid"` first — an "overdue"
 *    status (server-authoritative) can never be relabeled "upcoming" by a
 *    client-side clock, regardless of any browser/server clock drift.
 *
 * Root cause: NONE FOUND. The probe reproduced the ticket's exact two-period
 * shape (one paid, one later unpaid) with dates anchored relative to the
 * real clock and confirmed every layer — per-period status, the aggregate
 * summary, and nextOutstandingPeriod — already transitions correctly the
 * moment the second period's own start date arrives. No date-logic code
 * was changed. These five tests (matching the ticket's Case 1-5 exactly)
 * exist to lock this behavior in permanently across all three layers, using
 * the same real-clock-relative anchoring the probe used — never a
 * hard-coded date, which would silently stop testing the real transition
 * once wall-clock time moved past it.
 */
describe("bug investigation — period-2 status/summary transition as its own due date arrives", () => {
  function isoMonthsAgo(months: number): string {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  }

  /** Same as isoMonthsAgo, minus one extra day — used wherever a test needs
   * the "current" monthly period's own due date to fall STRICTLY before
   * today (genuinely overdue), not exactly ON today ("due today," still
   * "unpaid" per computeFeePeriodStatus's strict `<` check). Anchoring
   * exactly N months back would otherwise align the Nth period's start with
   * today's own calendar date, landing on that boundary by coincidence. */
  function isoMonthsAgoPastDue(months: number): string {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /** Pays every already-started period FULLY except the most recent one,
   * and returns that most recent started period — i.e. "September" (fully
   * settled) and "October" (the one under test), regardless of exactly how
   * many periods `generateFeePeriodsForEnrollment`'s own "one extra period
   * ahead" behavior happened to produce for a given anchor. This is what
   * makes Cases 3/5 robust to that implementation detail instead of
   * assuming exactly two periods exist. */
  async function payAllStartedExceptLast(
    context: AuthContext,
    studentId: string,
    enrollmentId: string,
    amountCentsPerPeriod: number,
  ) {
    const today = todayIsoDate();
    const allPeriods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, enrollmentId)).orderBy(feePeriods.periodStart);
    const started = allPeriods.filter((p) => p.periodStart <= today);
    expect(started.length).toBeGreaterThanOrEqual(2);
    for (const period of started.slice(0, -1)) {
      const result = await recordFeePeriodPayment(context, {
        studentId,
        enrollmentId,
        allocations: [{ feePeriodId: period.id, amountCents: amountCentsPerPeriod }],
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
    }
    return started[started.length - 1];
  }

  /** Case 1 — period 2 has not started yet: PAID / UPCOMING, never counted
   * as currently due, never overdue. */
  it("Case 1 — previous period paid, next period still future: UPCOMING, not due, not overdue", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored on today: period 1 = today..+1mo-1d (already started), period
    // 2 = next month (still future) — mirrors the ticket's Period1/Period2
    // shape with "today" sitting inside period 1, before period 2 starts.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 1_110, anchorDate: isoMonthsAgo(0) });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [september, october] = periods;

    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: september.id, amountCents: 555 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const septemberRow = listed.periods.find((p) => p.id === september.id);
    const octoberRow = listed.periods.find((p) => p.id === october.id);
    expect(septemberRow?.status).toBe("paid");
    expect(octoberRow?.status).toBe("unpaid"); // never "overdue" — its due date hasn't arrived
    expect(octoberRow && octoberRow.periodStart > todayIsoDate()).toBe(true); // genuinely future

    // The student is NOT incorrectly marked overdue — October, not yet
    // started, is excluded from "currently due."
    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.status).toBe("paid");
    expect(row?.remainingCents).toBe(0);
    expect(row?.nextOutstandingPeriod).toBeNull();
  });

  /** Case 2 — period 2's own start/due date is exactly "today": it must
   * already count as outstanding/due, never upcoming, and become the
   * payment target. */
  it("Case 2 — previous period paid, next period's due date is today: outstanding, not upcoming, becomes nextOutstandingPeriod", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Period 1 anchored a month ago, so period 2 (the following month)
    // starts exactly today.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 1_110, anchorDate: isoMonthsAgo(1) });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [september, october] = periods;
    expect(october.periodStart).toBe(todayIsoDate());

    const paid = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: september.id, amountCents: 555 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const octoberRow = listed.periods.find((p) => p.id === october.id);
    expect(octoberRow?.status).not.toBe("paid");
    // "Due today" is not yet "overdue" (compareDateOnly uses strict <),
    // but it must never read as a future/upcoming obligation either.
    expect(["unpaid", "overdue"]).toContain(octoberRow?.status);

    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.remainingCents).toBe(555);
    expect(row?.status).not.toBe("paid");
    expect(row?.nextOutstandingPeriod?.id).toBe(october.id); // Record Payment targets October
  });

  /** Case 3 — period 2's due date is clearly in the past: OVERDUE,
   * nextOutstandingPeriod, Record Payment target, student summary reflects
   * the real remaining balance (never falsely "fully paid"). */
  it("Case 3 — next period is overdue: OVERDUE status, nextOutstandingPeriod, remaining $5.55, student not falsely PAID", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    // Anchored so the most recent monthly period's own due date fell
    // yesterday — genuinely overdue, not merely "due today" — using the
    // SAME default (real-today-relative) lazy generation every other test
    // and the real app itself uses; payAllStartedExceptLast below settles
    // every earlier started period first regardless of how many exist.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 1_665, anchorDate: isoMonthsAgoPastDue(2) });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    // Every already-started period EXCEPT the most recent one is fully
    // settled ("September"); the most recent started period ("October") is
    // left unpaid, under test.
    const october = await payAllStartedExceptLast(context, fixture.studentId, fixture.enrollmentId, 555);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const octoberRow = listed.periods.find((p) => p.id === october.id);
    expect(octoberRow?.status).toBe("overdue");
    expect(octoberRow?.remainingCents).toBe(555);

    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.status).not.toBe("paid");
    expect(row?.status).toBe("overdue");
    expect(row?.remainingCents).toBe(555); // exactly October's own remaining — not inflated by any other period
    expect(row?.nextOutstandingPeriod?.id).toBe(october.id);
  });

  /** Case 4 — both periods paid: PAID, remaining $0, no Record Payment
   * target for either period. */
  it("Case 4 — next period also paid: student is fully PAID, remaining $0, no outstanding target", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 1_665, anchorDate: isoMonthsAgoPastDue(2) });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    // Pay off every started period except the last one, then pay that last
    // one ("October") too — every currently-relevant period ends up paid.
    const october = await payAllStartedExceptLast(context, fixture.studentId, fixture.enrollmentId, 555);
    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: october.id, amountCents: 555 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.periods.find((p) => p.id === october.id)?.status).toBe("paid");

    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.status).toBe("paid");
    expect(row?.remainingCents).toBe(0);
    expect(row?.nextOutstandingPeriod).toBeNull(); // no Record Payment action for either period
  });

  /** Case 5 — next period partially paid, past due: OVERDUE/outstanding,
   * remaining reflects the partial balance, still the payment target. */
  it("Case 5 — next period partially paid and overdue: remaining $3.55, still nextOutstandingPeriod", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 1_665, anchorDate: isoMonthsAgoPastDue(2) });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const october = await payAllStartedExceptLast(context, fixture.studentId, fixture.enrollmentId, 555);
    // Partial payment toward October: $2.00 of $5.55.
    const partial = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: october.id, amountCents: 200 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(partial.ok).toBe(true);

    const listed = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const octoberRow = listed.periods.find((p) => p.id === october.id);
    expect(octoberRow?.status).toBe("overdue"); // past due + money still owed, regardless of partial payment
    expect(octoberRow?.remainingCents).toBe(355);

    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.remainingCents).toBe(355); // exactly October's own remaining
    expect(row?.nextOutstandingPeriod?.id).toBe(october.id); // Record Payment remains available, still targets October
    expect(row?.nextOutstandingPeriod?.remainingCents).toBe(355);
  });
});

/**
 * Money-input-system fix — the exact Student Payment flow from the task's
 * own worked example, using `dollarsToCents` (lib/ui/money.ts) at every
 * step the way the Record Payment dialogs (students-list.tsx,
 * fee-periods-manager.tsx, student-detail.tsx) now actually do it, instead
 * of a hand-computed cents literal. This is what proves the fix, not just
 * the isolated dollarsToCents unit tests: a user typing "2" against a
 * $5.55 balance must record a $2.00 payment (200 cents), never 2 cents.
 */
describe("money-input-system fix — Student Payment flow entered in dollars", () => {
  it('Remaining $5.55 -> user enters "2" -> $2.00 recorded, remaining $3.55 -> user enters "3.55" -> $3.55 recorded, remaining $0, PAID', async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    // Fee schedule itself set up via dollarsToCents too — "5.55" must mean
    // $5.55/period (555 cents), never 555 dollars or 5 cents.
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: dollarsToCents("5.55")!,
      anchorDate: todayIsoDate(),
    });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(period.expectedAmountCents).toBe(555);

    const initial = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(initial.ok && initial.periods[0].remainingCents).toBe(555);

    // Staff types "2" into "Amount Paid Now" — exactly what
    // RecordPaymentDialog/PeriodPaymentForm's handleSubmit does: convert via
    // dollarsToCents, never `Number("2") * 100` and never the raw digits as
    // cents.
    const firstEntered = dollarsToCents("2");
    expect(firstEntered).toBe(200); // $2.00, not 2 cents
    const firstPayment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: firstEntered! }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(firstPayment.ok).toBe(true);
    if (!firstPayment.ok) return;
    expect(firstPayment.payment.amountCents).toBe(200);

    const afterFirst = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(afterFirst.ok && afterFirst.periods[0].paidCents).toBe(200);
    expect(afterFirst.ok && afterFirst.periods[0].remainingCents).toBe(355); // $3.55
    expect(afterFirst.ok && afterFirst.periods[0].status).toBe("partially_paid");

    // Staff types "3.55" for the second, completing payment.
    const secondEntered = dollarsToCents("3.55");
    expect(secondEntered).toBe(355);
    const secondPayment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents: secondEntered! }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(secondPayment.ok).toBe(true);
    if (!secondPayment.ok) return;
    expect(secondPayment.payment.amountCents).toBe(355);

    const afterSecond = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(afterSecond.ok && afterSecond.periods[0].paidCents).toBe(555);
    expect(afterSecond.ok && afterSecond.periods[0].remainingCents).toBe(0);
    expect(afterSecond.ok && afterSecond.periods[0].status).toBe("paid");

    // The Students-list summary agrees exactly.
    const summary = await getStudentPaymentSummaries(fixture.academyId, [fixture.studentId]);
    const row = summary.get(fixture.studentId);
    expect(row?.paidCents).toBe(555);
    expect(row?.remainingCents).toBe(0);
    expect(row?.status).toBe("paid");
    expect(row?.nextOutstandingPeriod).toBeNull();
  });

  it('a fee schedule amount entered as "10" means $10.00/period (1000 cents), not $0.10', async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    const entered = dollarsToCents("10");
    expect(entered).toBe(1000);
    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: entered!,
      anchorDate: todayIsoDate(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.amountCents).toBe(1000);

    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [period] = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(period.expectedAmountCents).toBe(1000); // $10.00, never 10 cents
  });
});

// ===========================================================================
// Task: "Fix Fee Period Display and Safely Handle Payment-Plan Changes" —
// (1) the normal fee-period view hides a period until its own periodStart
// arrives (never an "Upcoming period" banner), and (2) a payment-plan
// change takes effect from the start of the next NOT-YET-STARTED period,
// never touching a period that has already started (paid or not) nor one
// that has any payment allocated to it, however far in the future.
// ===========================================================================

describe("setEnrollmentFeeSchedule — effective-date rule for a schedule change", () => {
  /** Plain date-only arithmetic, independent of production's own addDays —
   * deliberately NOT importing it, so a bug in that helper can't hide
   * itself from these assertions (same reasoning as other test files' own
   * independent date-math helpers, e.g. batch-assignments.test.ts's
   * expectedPeriodEnd). */
  function addOneDayIso(dateIso: string): string {
    const [y, m, d] = dateIso.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  const INTERVAL_CHANGE_CASES: { from: number; to: number }[] = [
    { from: 1, to: 6 },
    { from: 6, to: 1 },
    { from: 6, to: 12 },
    { from: 12, to: 6 },
    { from: 1, to: 12 },
    { from: 12, to: 1 },
  ];

  for (const { from, to } of INTERVAL_CHANGE_CASES) {
    it(`${from} month(s) -> ${to} month(s): the paid current period is untouched, its payment is untouched, no duplicate payment is created, the remaining balance auto-carries into the new plan, and the next period starts right after it`, async () => {
      const fixture = await setupFixture();
      const { context } = await addActingUser(fixture.academyId, "manager");
      const today = todayDateOnlyInAcademyTimezone();
      const TOTAL_OLD = 1200; // divides evenly by every supported interval (1/2/3/4/6/12)

      // Anchored exactly on "today": the FIRST of the `from` installments
      // has started (periodStart === today); every later one is still in
      // the future — all `from` installments are generated up-front by
      // this one call (see this file's module comment on the bounded,
      // non-recurring model).
      const first = await setEnrollmentFeeSchedule(context, {
        enrollmentId: fixture.enrollmentId,
        intervalMonths: from,
        amountCents: TOTAL_OLD,
        anchorDate: today,
      });
      expect(first.ok).toBe(true);
      await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

      const periodsBefore = await db
        .select()
        .from(feePeriods)
        .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
        .orderBy(feePeriods.periodStart);
      expect(periodsBefore).toHaveLength(from);
      const [currentPeriod, ...oldFuturePeriods] = periodsBefore;
      expect(currentPeriod.periodStart).toBe(today);
      for (const period of oldFuturePeriods) {
        expect(period.periodStart > today).toBe(true);
      }
      const firstInstallmentCents = currentPeriod.expectedAmountCents;

      // Pay the current period in full — the "historical/paid" period the
      // task's own worked examples protect.
      const payment = await recordFeePeriodPayment(context, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        allocations: [{ feePeriodId: currentPeriod.id, amountCents: firstInstallmentCents }],
        method: "cash",
        receivedAt: new Date(),
      });
      expect(payment.ok).toBe(true);
      const allocationsBefore = await db
        .select()
        .from(paymentAllocations)
        .where(eq(paymentAllocations.feePeriodId, currentPeriod.id));
      expect(allocationsBefore).toHaveLength(1);

      // The administrator changes the plan (anchor left exactly as the
      // existing schedule's own — the "Edit fee schedule" form's own
      // pre-fill behavior — and amount submitted as an arbitrary, IRRELEVANT
      // value: both are server-overridden by the auto-carry/auto-resume
      // rule below once any installment has started).
      const changed = await setEnrollmentFeeSchedule(context, {
        enrollmentId: fixture.enrollmentId,
        intervalMonths: to,
        amountCents: 999_999,
        anchorDate: today,
      });

      // What carries is the old total minus the kept period's EXPECTED
      // amount. A 1-installment old plan is wholly kept, so nothing is left
      // to reschedule: the change is refused (it used to treat the
      // submitted amount as a fresh fee, charging beyond the course fee)
      // and nothing changes.
      const remainingOld = TOTAL_OLD - firstInstallmentCents;
      if (remainingOld <= 0) {
        expect(changed.ok).toBe(false);
        expect(!changed.ok && changed.error.code).toBe("validation");
        const untouched = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
        expect(untouched).toEqual([currentPeriod]);
        return;
      }
      expect(changed.ok).toBe(true);
      const expectedNewTotal = remainingOld;
      expect(changed.ok && changed.schedule.amountCents).toBe(expectedNewTotal);

      // The paid current period: byte-for-byte untouched.
      const [stillCurrent] = await db.select().from(feePeriods).where(eq(feePeriods.id, currentPeriod.id));
      expect(stillCurrent).toEqual(currentPeriod);

      // Its payment allocation: untouched.
      const allocationsAfter = await db
        .select()
        .from(paymentAllocations)
        .where(eq(paymentAllocations.feePeriodId, currentPeriod.id));
      expect(allocationsAfter).toEqual(allocationsBefore);

      // No duplicate payment was ever created for it.
      const allPayments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
      expect(allPayments).toHaveLength(1);

      // Every OLD not-yet-started period (generated under the OLD plan,
      // never paid) is gone — replaced, not left dangling.
      for (const period of oldFuturePeriods) {
        const [stillThere] = await db.select().from(feePeriods).where(eq(feePeriods.id, period.id));
        expect(stillThere).toBeUndefined();
      }

      // The new schedule's own `to` installments exist, starting the day
      // right after the protected current period ends — "the new plan
      // begins at the start of the next not-yet-started period" — and use
      // the carried-over remaining balance, split per the new count.
      const periodsAfter = await db
        .select()
        .from(feePeriods)
        .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
        .orderBy(feePeriods.periodStart);
      expect(periodsAfter).toHaveLength(1 + to);
      const newPeriods = periodsAfter.filter((period) => period.id !== currentPeriod.id);
      expect(newPeriods).toHaveLength(to);
      expect(newPeriods[0].periodStart).toBe(addOneDayIso(currentPeriod.periodEnd));
      for (const period of newPeriods) {
        expect(period.intervalMonths).toBe(to);
      }
      const newTotal = newPeriods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
      expect(newTotal).toBe(expectedNewTotal); // the installments sum to EXACTLY the carried-over total, no drift
    });
  }

  it("protects the CURRENT period even while it is still UNPAID — a schedule change never silently overwrites money already owed", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [currentPeriod] = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart)
      .limit(1);
    expect(currentPeriod.periodStart).toBe(today);

    // Left entirely unpaid on purpose — this is the exact "current unpaid
    // period" scenario the task's own spec calls out as something a
    // schedule change must never silently overwrite.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 6, amountCents: 6000, anchorDate: today });

    const [stillCurrent] = await db.select().from(feePeriods).where(eq(feePeriods.id, currentPeriod.id));
    expect(stillCurrent).toEqual(currentPeriod);
    expect(stillCurrent.intervalMonths).toBe(1);
    expect(stillCurrent.expectedAmountCents).toBe(1000);
  });

  it("a not-yet-started period that already has a payment allocated to it (an advance payment) is never deleted, even though it hasn't started yet", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 2000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [, futurePeriod] = periods;
    expect(futurePeriod.periodStart > today).toBe(true);

    // Nothing today stops staff from recording an advance payment against a
    // not-yet-due period via its own per-row Record Payment action.
    const advancePayment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: futurePeriod.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(advancePayment.ok).toBe(true);

    // Both installments are now kept (one started, one paid ahead), so
    // the whole plan is already represented and the change is refused.
    const refused = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 6, amountCents: 6000, anchorDate: today });
    expect(refused.ok).toBe(false);

    // The advance-paid future period survives, completely unmodified —
    // protecting the payment outranks the effective-date rule.
    const [stillFuture] = await db.select().from(feePeriods).where(eq(feePeriods.id, futurePeriod.id));
    expect(stillFuture).toEqual(futurePeriod);
    const futureAllocations = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, futurePeriod.id));
    expect(futureAllocations).toHaveLength(1);

    const periodsAfter = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    expect(periodsAfter).toEqual(periods);
  });

  it("regression (caaxi cali / STD-000008): advance-paying a 1-installment schedule's only period BEFORE anything has started, then correcting the schedule's anchor, never leaves the payment silently orphaned/unreflected — the summary must never read 'unpaid' once the course has actually been paid for", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    // Reproduces the exact reported shape: a 1-month (single-installment)
    // $10 schedule is first set up anchored on a WRONG, future date (the
    // real incident's "2026-10-30" instead of the enrollment's own actual
    // date) — mirroring the pre-anchor-date-fix bug from an earlier task.
    const wrongFutureAnchor = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      date.setUTCDate(date.getUTCDate() + 24);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    })();
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 1000,
      anchorDate: wrongFutureAnchor,
    });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [wrongPeriod] = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(wrongPeriod.periodStart).toBe(wrongFutureAnchor);

    // The $10 is paid in full against that (not-yet-started) period —
    // exactly the real incident's receipt RCT-000007, recorded same-day as
    // the enrollment itself.
    const payment = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: wrongPeriod.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(payment.ok).toBe(true);

    // The admin then corrects the schedule — re-anchoring to the real,
    // intended date (today). Before the fix, nothing had "started" yet
    // (the only period's periodStart was still in the future), so the old
    // startedPeriods-only check saw zero protected periods and let this
    // create a brand-new, disconnected period at `today` — orphaning the
    // $10 payment on the old one while the new one read UNPAID.
    const corrected = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 1000,
      anchorDate: today,
    });
    // The plan's only installment is paid and kept, so there is nothing
    // left to reschedule: the correction is refused instead of adding a
    // second $10 charge after the paid period.
    expect(corrected.ok).toBe(false);

    // The original payment and its allocation are completely untouched —
    // never deleted, never duplicated.
    const allPayments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
    expect(allPayments).toHaveLength(1);
    expect(allPayments[0].id).toBe(payment.ok ? payment.payment.id : "");
    const allocationsForWrongPeriod = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.feePeriodId, wrongPeriod.id));
    expect(allocationsForWrongPeriod).toHaveLength(1);

    // The core financial-correctness invariant the real incident violated:
    // the enrollment's own payment summary (what the Fee Schedule card and
    // Students-list both read) must NEVER report "unpaid, $10 remaining"
    // once $10 has genuinely already been paid toward this schedule's one
    // and only installment — regardless of which fee_periods row ends up
    // "current."
    const summary = await getEnrollmentPaymentSummary(context, fixture.enrollmentId);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.paidCents).toBe(1000);
      expect(summary.summary.remainingCents).toBe(0);
      expect(summary.summary.status).toBe("paid");
    }

    // Payment History still references the SAME period the allocation was
    // always on — the real incident's other symptom (Payment History
    // pointing at an "obsolete" period) never happens here because the
    // allocation itself is never silently repointed or left dangling.
    const history = await listFeePeriodPaymentHistory(context, { enrollmentId: fixture.enrollmentId });
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0].periods).toEqual([
        {
          feePeriodId: wrongPeriod.id,
          enrollmentId: fixture.enrollmentId,
          periodStart: wrongPeriod.periodStart,
          periodEnd: wrongPeriod.periodEnd,
          amountCents: 1000,
          courseName: expect.any(String),
          batchName: expect.any(String),
        },
      ]);
    }

    // No new period was ever created that OVERLAPS or PRECEDES the
    // protected, paid period — the one structural guarantee
    // generateFeePeriodsForEnrollment has always made, preserved here too.
    const periodsAfter = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart);
    for (const period of periodsAfter) {
      if (period.id === wrongPeriod.id) continue;
      expect(period.periodStart > wrongPeriod.periodEnd).toBe(true);
    }
  });

  it("setting a fee schedule for the FIRST time (no periods exist yet) stays exactly as lazy as before — periods are not eagerly generated by the schedule call itself", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    const result = await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 1,
      amountCents: 1000,
      anchorDate: todayDateOnlyInAcademyTimezone(),
    });
    expect(result.ok).toBe(true);

    const periods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId));
    expect(periods).toHaveLength(0);
  });

  it("month-end boundary: changing the plan after a period ending Feb 27 (Jan 31 + 1 month, non-leap year) resumes the new plan on Feb 28 with correct clamping", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    // Set up the schedule, then directly seed exactly the one historical
    // period that would have been generated for it (bypassing the eager
    // "walk all the way to real today" generation, which would otherwise
    // produce many more periods between this fixed 2026 date and whenever
    // this test actually runs — see this describe block's other tests for
    // why "anchor = today" is used everywhere a real eager walk matters).
    // A 2-installment plan whose paid first installment is the only period
    // so far: $10.00 of it is left to carry into the new plan.
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 2,
      amountCents: 2000,
      anchorDate: "2026-01-31",
    });
    const [seeded] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        periodStart: "2026-01-31",
        periodEnd: "2026-02-27", // Jan 31 + 1 month -> Feb 28 (2026, non-leap) -> end = Feb 27
        dueDate: "2026-01-31",
        expectedAmountCents: 1000,
        currency: "USD",
      })
      .returning();
    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: seeded.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 6,
      amountCents: 6000,
      anchorDate: "2026-01-31",
    });

    const [stillSeeded] = await db.select().from(feePeriods).where(eq(feePeriods.id, seeded.id));
    expect(stillSeeded).toEqual(seeded);

    const [nextPeriod] = await db
      .select()
      .from(feePeriods)
      .where(and(eq(feePeriods.enrollmentId, fixture.enrollmentId), eq(feePeriods.periodStart, "2026-02-28")));
    expect(nextPeriod).toBeDefined();
    expect(nextPeriod.intervalMonths).toBe(6); // the schedule's own installment count, not this period's length
    // The $10.00 left of the old plan is carried (the submitted $60.00 is
    // ignored) and split into 6 monthly installments (166 x 5 + 170) —
    // and every generated period is exactly ONE calendar month, never 6.
    expect(nextPeriod.expectedAmountCents).toBe(166);
    expect(nextPeriod.periodEnd).toBe("2026-03-27"); // Feb 28 + 1 month -> Mar 28 -> end = Mar 27
  });

  it("leap-year boundary: changing the plan after a period ending Feb 28 (Jan 31 + 1 month, leap year 2028) resumes the new plan on Feb 29", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");

    // A 2-installment plan whose paid first installment is the only period
    // so far: $10.00 of it is left to carry into the new plan.
    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 2,
      amountCents: 2000,
      anchorDate: "2028-01-31",
    });
    const [seeded] = await db
      .insert(feePeriods)
      .values({
        academyId: fixture.academyId,
        enrollmentId: fixture.enrollmentId,
        intervalMonths: 1,
        periodStart: "2028-01-31",
        periodEnd: "2028-02-28", // Jan 31 + 1 month -> Feb 29 (2028, leap) -> end = Feb 28
        dueDate: "2028-01-31",
        expectedAmountCents: 1000,
        currency: "USD",
      })
      .returning();
    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: seeded.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    await setEnrollmentFeeSchedule(context, {
      enrollmentId: fixture.enrollmentId,
      intervalMonths: 6,
      amountCents: 6000,
      anchorDate: "2028-01-31",
    });

    const [nextPeriod] = await db
      .select()
      .from(feePeriods)
      .where(and(eq(feePeriods.enrollmentId, fixture.enrollmentId), eq(feePeriods.periodStart, "2028-02-29")));
    expect(nextPeriod).toBeDefined();
    expect(nextPeriod.intervalMonths).toBe(6); // the schedule's own installment count, not this period's length
    expect(nextPeriod.expectedAmountCents).toBe(166); // the $10.00 carried / 6 monthly installments
    expect(nextPeriod.periodEnd).toBe("2028-03-28"); // Feb 29 + 1 month -> Mar 29 -> end = Mar 28
  });
});

describe("fee-period visibility for the normal display view (student-detail.tsx / fee-periods-manager.tsx)", () => {
  /**
   * Both display components filter the already-fetched `periods` array to
   * `period.periodStart <= today` before rendering, and no longer render
   * an "Upcoming period (not yet due)" banner at all (removed entirely,
   * not merely relabeled) — see those files' own inline comments at the
   * filter site. This project has no component-rendering test setup (no
   * jsdom/React Testing Library; vitest.config.ts only ever collects
   * `*.test.ts`), so these tests pin down the DATA that one-line filter
   * operates on instead of rendering the component — a wrong answer here
   * would mean the UI's trivial filter has nothing correct to read from,
   * which is the only way this behavior could actually break.
   */
  function isVisibleForDisplay(periodStart: string, today: string): boolean {
    return periodStart <= today; // mirrors the UI's own filter, exactly
  }

  it("a brand-new enrollment's current period has periodStart === today (visible), and its schedule's later not-yet-started installment has periodStart > today (hidden)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 2000, anchorDate: today });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.periods).toHaveLength(2);
    const visible = result.periods.filter((period) => isVisibleForDisplay(period.periodStart, today));
    const hidden = result.periods.filter((period) => !isVisibleForDisplay(period.periodStart, today));
    expect(visible).toHaveLength(1);
    expect(visible[0].periodStart).toBe(today);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].periodStart > today).toBe(true);
  });

  it("a paid current period is still visible (paid-ness never hides a started period)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const [currentPeriod] = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, fixture.enrollmentId))
      .orderBy(feePeriods.periodStart)
      .limit(1);
    await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: currentPeriod.id, amountCents: 1000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paidPeriod = result.periods.find((period) => period.id === currentPeriod.id);
    expect(paidPeriod).toBeDefined();
    expect(paidPeriod?.status).toBe("paid");
    expect(isVisibleForDisplay(paidPeriod!.periodStart, today)).toBe(true);
  });

  it("a current unpaid/overdue period is still visible — only FUTURE periods are hidden, never a merely-unpaid one", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    // Anchored a month ago so the current period is overdue, not merely due.
    const anchor = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      date.setUTCMonth(date.getUTCMonth() - 1);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    })();
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: anchor });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const overduePeriod = result.periods.find((period) => period.periodStart === anchor);
    expect(overduePeriod).toBeDefined();
    expect(overduePeriod?.status).toBe("overdue");
    expect(isVisibleForDisplay(overduePeriod!.periodStart, today)).toBe(true);
  });

  it("multiple future periods (several lazy reads after the anchor was pushed forward) are all hidden", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();
    const farFuture = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      date.setUTCMonth(date.getUTCMonth() + 3);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    })();

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: farFuture });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Nothing has started yet — every generated period is hidden.
    expect(result.periods.length).toBeGreaterThan(0);
    for (const period of result.periods) {
      expect(isVisibleForDisplay(period.periodStart, today)).toBe(false);
    }
  });

  it("a period's visibility depends only on its OWN periodStart, never on the batch's start date or the original enrollment/anchor date", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();

    // The batch's own start_date (set by insertBatchDirect) is fixed at
    // "2026-01-01" — deliberately different from both the schedule's
    // anchor and the resulting period's own periodStart below, so a
    // visibility check that accidentally used batch.startDate instead of
    // the period's own periodStart would read differently here.
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: today });
    const result = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const currentPeriod = result.periods.find((period) => period.periodStart === today);
    expect(currentPeriod).toBeDefined();
    expect(isVisibleForDisplay(currentPeriod!.periodStart, today)).toBe(true);
  });
});

describe("getOverdueFeeSummary (dashboard Requires attention)", () => {
  it("sums only the unpaid remainder of past-due periods, per currency, scoped to one academy and optionally one branch", async () => {
    const fixture = await setupFixture();
    const other = await setupFixture();
    const { context: managerContext } = await addActingUser(fixture.academyId, "manager");
    const { context: otherManager } = await addActingUser(other.academyId, "manager");

    // Anchored in the past: both $50 installments are already overdue.
    await setEnrollmentFeeSchedule(managerContext, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 10000, anchorDate: "2020-01-01" });
    await setEnrollmentFeeSchedule(otherManager, { enrollmentId: other.enrollmentId, intervalMonths: 1, amountCents: 7000, anchorDate: "2020-01-01" });
    const listed = await listFeePeriodsForEnrollment(managerContext, fixture.enrollmentId);
    if (!listed.ok) throw new Error("failed to list periods");
    expect(listed.periods.every((period) => period.status === "overdue")).toBe(true);

    await recordFeePeriodPayment(managerContext, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId: listed.periods[0].id, amountCents: 2000 }],
      method: "cash",
      receivedAt: new Date(),
    });

    const summary = await getOverdueFeeSummary(fixture.academyId);
    expect(summary.studentCount).toBe(1);
    expect(summary.periodCount).toBe(2);
    expect(summary.totalsByCurrency).toHaveLength(1);
    expect(summary.totalsByCurrency[0].amountCents).toBe(10000 - 2000);

    const sameBranch = await getOverdueFeeSummary(fixture.academyId, fixture.branchId);
    expect(sameBranch.totalsByCurrency[0]?.amountCents).toBe(8000);
    // Another academy's branch id never reaches this academy's rows.
    const foreignBranch = await getOverdueFeeSummary(fixture.academyId, other.branchId);
    expect(foreignBranch).toEqual({ studentCount: 0, periodCount: 0, totalsByCurrency: [], byStudent: {} });
    // Per-student breakdown and an explicit student restriction.
    expect(summary.byStudent[fixture.studentId]).toEqual([{ currency: summary.totalsByCurrency[0].currency, amountCents: 8000 }]);
    const restricted = await getOverdueFeeSummary(fixture.academyId, null, [other.studentId]);
    expect(restricted.studentCount).toBe(0);
  });
});

describe("setEnrollmentFeeSchedule — carry-over never charges a kept period twice", () => {
  function shiftIso(dateIso: string, { months = 0, days = 0 }: { months?: number; days?: number }): string {
    const [y, m, d] = dateIso.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1 + months, Math.min(d, 28) + days));
    return date.toISOString().slice(0, 10);
  }
  function nextDayIso(dateIso: string): string {
    const [y, m, d] = dateIso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }

  async function periodsOf(enrollmentId: string) {
    return db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, enrollmentId)).orderBy(feePeriods.periodStart);
  }
  const totalExpected = (rows: { expectedAmountCents: number }[]) => rows.reduce((sum, row) => sum + row.expectedAmountCents, 0);

  async function scheduled(intervalMonths: number, amountCents: number, anchorDate?: string) {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const anchor = anchorDate ?? todayDateOnlyInAcademyTimezone();
    const set = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths, amountCents, anchorDate: anchor });
    expect(set.ok).toBe(true);
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    return { fixture, context, periods: await periodsOf(fixture.enrollmentId) };
  }

  async function pay(context: AuthContext, fixture: Fixture, feePeriodId: string, amountCents: number) {
    const result = await recordFeePeriodPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      allocations: [{ feePeriodId, amountCents }],
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);
  }

  it("started UNPAID period: carries only the unscheduled part, the total owed stays the course fee", async () => {
    const { fixture, context, periods } = await scheduled(3, 3000);
    const [current] = periods;
    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 999_999, anchorDate: "2020-01-01" });
    expect(changed.ok && changed.schedule.amountCents).toBe(2000);
    const after = await periodsOf(fixture.enrollmentId);
    expect(after[0]).toEqual(current);
    expect(after.slice(1).map((p) => p.expectedAmountCents)).toEqual([1000, 1000]);
    expect(after[1].periodStart).toBe(nextDayIso(current.periodEnd));
    expect(totalExpected(after)).toBe(3000);
  });

  it("PARTIALLY paid period: kept with its own amount and allocation; its unpaid part is not carried again", async () => {
    const { fixture, context, periods } = await scheduled(3, 3000);
    const [current] = periods;
    await pay(context, fixture, current.id, 400);
    const allocationsBefore = await db.select().from(paymentAllocations).where(eq(paymentAllocations.feePeriodId, current.id));
    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 4, amountCents: 1, anchorDate: "2020-01-01" });
    expect(changed.ok && changed.schedule.amountCents).toBe(2000);
    const after = await periodsOf(fixture.enrollmentId);
    expect(after[0]).toEqual(current);
    expect(await db.select().from(paymentAllocations).where(eq(paymentAllocations.feePeriodId, current.id))).toEqual(allocationsBefore);
    expect(after.slice(1).map((p) => p.expectedAmountCents)).toEqual([500, 500, 500, 500]);
    expect(totalExpected(after)).toBe(3000);
  });

  it("FULLY paid period: the same carry as unpaid, because the period's expected amount is what is subtracted", async () => {
    const { fixture, context, periods } = await scheduled(3, 3000);
    await pay(context, fixture, periods[0].id, 1000);
    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1, anchorDate: "2020-01-01" });
    expect(changed.ok && changed.schedule.amountCents).toBe(2000);
    expect(totalExpected(await periodsOf(fixture.enrollmentId))).toBe(3000);
  });

  it("MULTIPLE kept periods (several started, one paid ahead): all subtracted, the new plan resumes after the last", async () => {
    const today = todayDateOnlyInAcademyTimezone();
    const { fixture, context, periods } = await scheduled(6, 6000, shiftIso(today, { months: -2 }));
    const started = periods.filter((p) => p.periodStart <= today);
    expect(started.length).toBeGreaterThanOrEqual(2);
    const paidAhead = periods.find((p) => p.periodStart > today)!;
    await pay(context, fixture, started[0].id, 1000);
    await pay(context, fixture, started[1].id, 250);
    await pay(context, fixture, paidAhead.id, 100);
    const kept = [...started, paidAhead];

    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 1, anchorDate: today });
    expect(changed.ok && changed.schedule.amountCents).toBe(6000 - totalExpected(kept));
    const after = await periodsOf(fixture.enrollmentId);
    for (const period of kept) expect(after.find((p) => p.id === period.id)).toEqual(period);
    const added = after.filter((p) => !kept.some((k) => k.id === p.id));
    expect(added).toHaveLength(2);
    expect(added[0].periodStart).toBe(nextDayIso(paidAhead.periodEnd));
    expect(totalExpected(after)).toBe(6000);
  });

  it("NO kept periods: the submitted amount and date are used and the old periods are replaced", async () => {
    const future = shiftIso(todayDateOnlyInAcademyTimezone(), { days: 10 });
    const { fixture, context } = await scheduled(3, 3000, future);
    const later = shiftIso(future, { days: 5 });
    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 5000, anchorDate: later });
    expect(changed.ok && changed.schedule).toMatchObject({ amountCents: 5000, anchorDate: later });
    const after = await periodsOf(fixture.enrollmentId);
    expect(after[0].periodStart).toBe(later);
    expect(totalExpected(after)).toBe(5000);
  });

  it("ROUNDING: uneven splits still sum to exactly the course fee", async () => {
    const { fixture, context, periods } = await scheduled(3, 1000);
    expect(periods.map((p) => p.expectedAmountCents)).toEqual([333, 333, 334]);
    const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 1, anchorDate: "2020-01-01" });
    expect(changed.ok && changed.schedule.amountCents).toBe(667);
    const after = await periodsOf(fixture.enrollmentId);
    expect(after.slice(1).map((p) => p.expectedAmountCents)).toEqual([222, 222, 223]);
    expect(totalExpected(after)).toBe(1000);
  });

  it("REPEATED changes: periods kept from an earlier plan are not subtracted again, and the total never drifts", async () => {
    const { fixture, context, periods } = await scheduled(3, 1200);
    const first = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 1, anchorDate: "2020-01-01" });
    expect(first.ok && first.schedule.amountCents).toBe(800);
    expect(totalExpected(await periodsOf(fixture.enrollmentId))).toBe(1200);

    const second = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 4, amountCents: 1, anchorDate: "2020-01-01" });
    expect(second.ok && second.schedule.amountCents).toBe(800);
    let after = await periodsOf(fixture.enrollmentId);
    expect(after[0]).toEqual(periods[0]);
    expect(totalExpected(after)).toBe(1200);

    // Paying the new plan's first installment in advance keeps it too.
    await pay(context, fixture, after[1].id, 50);
    const third = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 1, amountCents: 1, anchorDate: "2020-01-01" });
    expect(third.ok && third.schedule.amountCents).toBe(800 - after[1].expectedAmountCents);
    after = await periodsOf(fixture.enrollmentId);
    expect(totalExpected(after)).toBe(1200);
  });

  it("OVERCHARGE prevention: a plan whose every installment is kept (unpaid or paid) can't be changed", async () => {
    for (const paid of [0, 1000]) {
      const { fixture, context, periods } = await scheduled(1, 1000);
      if (paid) await pay(context, fixture, periods[0].id, paid);
      const changed = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 3000, anchorDate: "2020-01-01" });
      expect(changed.ok).toBe(false);
      expect(!changed.ok && changed.error.code).toBe("validation");
      expect(await periodsOf(fixture.enrollmentId)).toEqual(periods);
      const [schedule] = await db.select().from(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.enrollmentId, fixture.enrollmentId));
      expect(schedule).toMatchObject({ intervalMonths: 1, amountCents: 1000 });
    }
  });

  it("INVALID schedules are refused before anything changes", async () => {
    const { fixture, context, periods } = await scheduled(3, 3000);
    for (const bad of [
      { intervalMonths: 3, amountCents: 0 },
      { intervalMonths: 3, amountCents: -100 },
      { intervalMonths: 5, amountCents: 3000 },
      { intervalMonths: 0, amountCents: 3000 },
    ]) {
      const result = await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, anchorDate: "2026-01-01", ...bad });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("validation");
    }
    expect(await periodsOf(fixture.enrollmentId)).toEqual(periods);
  });
});

describe("payment history for the Payments list — one payment, its allocations, page-scoped lookup", () => {
  it("a payment spread over several fee periods is ONE payment, with one history row listing every period and its course", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 3000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);

    const paid = await recordEnrollmentPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      amountCents: 1500,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const payments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
    expect(payments).toHaveLength(1);

    const history = await listFeePeriodPaymentHistory(context, { paymentIds: [payments[0].id] });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].periods.map((p) => p.amountCents)).toEqual([1000, 500]);
    for (const period of history.rows[0].periods) {
      expect(period).toMatchObject({ enrollmentId: fixture.enrollmentId, courseName: expect.any(String), batchName: expect.any(String) });
    }
  });

  it("paymentIds limits the lookup to those payments; an empty list returns nothing", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();
    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 2, amountCents: 2000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    for (let i = 0; i < 2; i += 1) {
      const result = await recordEnrollmentPayment(context, {
        studentId: fixture.studentId,
        enrollmentId: fixture.enrollmentId,
        amountCents: 1000,
        method: "cash",
        receivedAt: new Date(),
      });
      expect(result.ok).toBe(true);
    }
    const payments = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
    expect(payments).toHaveLength(2);

    const one = await listFeePeriodPaymentHistory(context, { paymentIds: [payments[0].id] });
    expect(one.ok && one.rows.map((row) => row.paymentId)).toEqual([payments[0].id]);
    const none = await listFeePeriodPaymentHistory(context, { paymentIds: [] });
    expect(none.ok && none.rows).toEqual([]);
  });

  it("never returns another academy's payment, even when its id is asked for", async () => {
    const theirs = await setupFixture();
    const theirManager = await addActingUser(theirs.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();
    await setEnrollmentFeeSchedule(theirManager.context, { enrollmentId: theirs.enrollmentId, intervalMonths: 1, amountCents: 1000, anchorDate: today });
    await generateFeePeriodsForEnrollment(db, theirs.enrollmentId, theirs.academyId);
    await recordEnrollmentPayment(theirManager.context, {
      studentId: theirs.studentId,
      enrollmentId: theirs.enrollmentId,
      amountCents: 1000,
      method: "cash",
      receivedAt: new Date(),
    });
    const [theirPayment] = await db.select().from(studentPayments).where(eq(studentPayments.studentId, theirs.studentId));

    const mine = await setupFixture();
    const { context } = await addActingUser(mine.academyId, "manager");
    const result = await listFeePeriodPaymentHistory(context, { paymentIds: [theirPayment.id] });
    expect(result.ok && result.rows).toEqual([]);
  });
});

describe("withdrawal keeps the course's financial history and the student's other courses", () => {
  it("periods, allocations and payments are untouched; the course stops counting as owed or overdue; other enrollments stay active", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const today = todayDateOnlyInAcademyTimezone();
    const twoMonthsAgo = (() => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 3, Math.min(d, 28))).toISOString().slice(0, 10);
    })();

    // A second course for the same student, in its own batch.
    const otherCourseId = await insertProgramAndCourse(fixture.academyId);
    const otherBatchId = await insertBatchDirect(fixture.academyId, fixture.branchId, otherCourseId);
    const otherEnrollmentId = await insertEnrollmentDirect(fixture.academyId, otherBatchId, fixture.studentId);

    await setEnrollmentFeeSchedule(context, { enrollmentId: fixture.enrollmentId, intervalMonths: 3, amountCents: 3000, anchorDate: twoMonthsAgo });
    await generateFeePeriodsForEnrollment(db, fixture.enrollmentId, fixture.academyId);
    const paid = await recordEnrollmentPayment(context, {
      studentId: fixture.studentId,
      enrollmentId: fixture.enrollmentId,
      amountCents: 1500,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(paid.ok).toBe(true);

    const overdueBefore = await getOverdueFeeSummary(fixture.academyId, null, [fixture.studentId]);
    expect(overdueBefore.studentCount).toBe(1);

    const periodsBefore = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart);
    const paymentsBefore = await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId));
    const allocationsBefore = await db
      .select()
      .from(paymentAllocations)
      .where(inArray(paymentAllocations.feePeriodId, periodsBefore.map((p) => p.id)));
    expect(allocationsBefore).toHaveLength(2);

    const withdrawn = await withdrawStudentFromBatch(context, fixture.enrollmentId, { reason: "Moved away" });
    expect(withdrawn.ok).toBe(true);

    expect(await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, fixture.enrollmentId)).orderBy(feePeriods.periodStart)).toEqual(periodsBefore);
    expect(await db.select().from(studentPayments).where(eq(studentPayments.studentId, fixture.studentId))).toEqual(paymentsBefore);
    expect(
      await db.select().from(paymentAllocations).where(inArray(paymentAllocations.feePeriodId, periodsBefore.map((p) => p.id))),
    ).toEqual(allocationsBefore);

    const enrollments = await db.select().from(batchEnrollments).where(eq(batchEnrollments.studentId, fixture.studentId));
    expect(enrollments.find((e) => e.id === fixture.enrollmentId)?.status).toBe("withdrawn");
    expect(enrollments.find((e) => e.id === otherEnrollmentId)?.status).toBe("active");

    // The withdrawn course no longer counts as overdue.
    const overdueAfter = await getOverdueFeeSummary(fixture.academyId, null, [fixture.studentId]);
    expect(overdueAfter.studentCount).toBe(0);

    // What the withdraw dialog reads stays available: the course-level
    // paid figure (its own allocations only) and its remaining balance.
    const ledger = await listFeePeriodsForEnrollment(context, fixture.enrollmentId);
    expect(ledger.ok).toBe(true);
    if (ledger.ok) {
      expect(ledger.periods.reduce((sum, p) => sum + p.paidCents, 0)).toBe(1500);
      expect(ledger.periods.reduce((sum, p) => sum + p.remainingCents, 0)).toBe(1500);
    }
  });
});

describe("refund basis — what counts as paid for a course (feeds the refund cap)", () => {
  async function scheduledEnrollment(fixture: Fixture, context: AuthContext, enrollmentId: string, amountCents: number) {
    await setEnrollmentFeeSchedule(context, { enrollmentId, intervalMonths: 1, amountCents, anchorDate: todayDateOnlyInAcademyTimezone() });
    await generateFeePeriodsForEnrollment(db, enrollmentId, fixture.academyId);
  }
  async function pay(context: AuthContext, fixture: Fixture, enrollmentId: string, amountCents: number) {
    const result = await recordEnrollmentPayment(context, {
      studentId: fixture.studentId,
      enrollmentId,
      amountCents,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(result.ok).toBe(true);
    const [latest] = await db
      .select()
      .from(studentPayments)
      .where(eq(studentPayments.studentId, fixture.studentId))
      .orderBy(sql`${studentPayments.createdAt} desc`)
      .limit(1);
    return latest;
  }
  async function paidFor(context: AuthContext, enrollmentId: string) {
    const ledger = await listFeePeriodsForEnrollment(context, enrollmentId);
    expect(ledger.ok).toBe(true);
    return ledger.ok ? ledger.periods.reduce((sum, p) => sum + p.paidCents, 0) : -1;
  }

  it("counts only this course's allocations: a payment for another course of the same student is excluded", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    const otherCourseId = await insertProgramAndCourse(fixture.academyId);
    const otherBatchId = await insertBatchDirect(fixture.academyId, fixture.branchId, otherCourseId);
    const otherEnrollmentId = await insertEnrollmentDirect(fixture.academyId, otherBatchId, fixture.studentId);
    await scheduledEnrollment(fixture, context, fixture.enrollmentId, 10_000);
    await scheduledEnrollment(fixture, context, otherEnrollmentId, 20_000);

    await pay(context, fixture, fixture.enrollmentId, 2_500);
    await pay(context, fixture, otherEnrollmentId, 7_000);

    expect(await paidFor(context, fixture.enrollmentId)).toBe(2_500);
    expect(await paidFor(context, otherEnrollmentId)).toBe(7_000);
  });

  it("a reversed payment no longer counts as paid for the course", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await scheduledEnrollment(fixture, context, fixture.enrollmentId, 10_000);
    const kept = await pay(context, fixture, fixture.enrollmentId, 2_000);
    const wrong = await pay(context, fixture, fixture.enrollmentId, 1_000);
    expect(kept.id).not.toBe(wrong.id);
    expect(await paidFor(context, fixture.enrollmentId)).toBe(3_000);

    const reversed = await reverseStudentPayment(context, wrong.id, "Entered twice.");
    expect(reversed.ok).toBe(true);
    expect(await paidFor(context, fixture.enrollmentId)).toBe(2_000);
  });

  it("an adjusted fee-period payment drops out entirely (existing adjustment model: the corrected row carries no allocation)", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await scheduledEnrollment(fixture, context, fixture.enrollmentId, 10_000);
    const payment = await pay(context, fixture, fixture.enrollmentId, 3_000);

    const adjusted = await adjustStudentPayment(context, payment.id, "Was 2,500.", 2_500);
    expect(adjusted.ok).toBe(true);
    // Pins the current behaviour the refund cap relies on: never MORE than
    // what remains approved-allocated, so a cap can't exceed money held.
    expect(await paidFor(context, fixture.enrollmentId)).toBe(0);
  });

  it("withdrawing keeps an issued receipt exactly as it was", async () => {
    const fixture = await setupFixture();
    const { context } = await addActingUser(fixture.academyId, "manager");
    await scheduledEnrollment(fixture, context, fixture.enrollmentId, 10_000);
    const payment = await pay(context, fixture, fixture.enrollmentId, 2_500);
    const issued = await issueReceipt(context, payment.id);
    expect(issued.ok).toBe(true);
    const before = await db.select().from(receipts).where(eq(receipts.studentPaymentId, payment.id));
    expect(before).toHaveLength(1);

    const withdrawn = await withdrawStudentFromBatch(context, fixture.enrollmentId, { reason: "Left the course" });
    expect(withdrawn.ok).toBe(true);

    expect(await db.select().from(receipts).where(eq(receipts.studentPaymentId, payment.id))).toEqual(before);
    expect(await paidFor(context, fixture.enrollmentId)).toBe(2_500);
  });
});
