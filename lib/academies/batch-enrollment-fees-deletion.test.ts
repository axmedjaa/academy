import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  auditLogs,
  batchEnrollments,
  enrollmentFeeSchedules,
  feePeriods,
  studentPayments,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getEnrollmentPaymentSummary, recordFeePeriodPayment, todayDateOnlyInAcademyTimezone } from "./fee-periods";
import {
  deleteBatchEnrollment,
  enrollStudentInBatch,
  getEnrollmentDeletionEligibility,
  withdrawStudentFromBatch,
} from "./batch-assignments";
import {
  registerFixtureCleanup,
  DEFAULT_PAYMENT_PLAN,
  createUser,
  addMembership,
  addActingUser,
  insertBatchDirect,
  insertStudentDirect,
  assignUserToBranches,
  insertExamResultDirect,
  insertCertificateDirect,
  setupAcademy,
} from "./batch-assignments-test-fixtures";

/**
 * Batch enrollments — money and history: the atomic initial payment plan on
 * enrollment, and when an enrollment may be deleted (never destroying
 * financial or academic history). Split out of batch-assignments.test.ts so
 * each file finishes well inside the per-run time limit; both share
 * batch-assignments-test-fixtures.ts.
 */

registerFixtureCleanup();

describe("enrollStudentInBatch — atomic initial payment plan", () => {
  it("rejects enrollment with a missing payment plan, and creates no enrollment row at all", async () => {
    const { context, academyId, branchId, batchId, creatorUserId } = await setupAcademy("manager");
    const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);

    const result = await enrollStudentInBatch(context, {
      batchId,
      studentId,
      // Omitted: only a full scholarship may enroll without a plan.
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
    ["trainer", false],
  ])("role %s: delete allowed = %s (Trainer's own-branch withdraw access does not extend to delete)", async (role, allowed) => {
    const owner = await setupAcademy("academy_owner");
    const studentId = await insertStudentDirect(owner.academyId, owner.branchId, owner.creatorUserId);
    const enrolled = await enrollStudentInBatch(owner.context, { batchId: owner.batchId, studentId, paymentPlan: DEFAULT_PAYMENT_PLAN });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const actingUserId = await createUser();
    await addMembership(actingUserId, owner.academyId, role);
    if (role === "trainer") {
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
