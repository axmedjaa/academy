/**
 * READ-ONLY audit script — finds enrollments with overlapping `fee_periods`
 * rows (the interval-change generation bug), and reports every payment/
 * allocation touching those periods plus the enrollment's derived summary.
 * Makes NO writes. Not wired into any app code; run manually, then delete.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batchEnrollments,
  batches,
  courses,
  enrollmentFeeSchedules,
  feePeriods,
  paymentAllocations,
  students,
  studentPayments,
} from "@/lib/db/schema";

async function main() {
  // Self-join fee_periods on enrollment_id, a.id < b.id (unordered pair,
  // each pair reported once), where the two date ranges overlap
  // (a.period_start <= b.period_end AND a.period_end >= b.period_start).
  const overlaps = await db.execute(sql`
    SELECT
      a.enrollment_id AS enrollment_id,
      a.id AS a_id, a.period_start AS a_start, a.period_end AS a_end, a.interval_months AS a_interval, a.expected_amount_cents AS a_expected,
      b.id AS b_id, b.period_start AS b_start, b.period_end AS b_end, b.interval_months AS b_interval, b.expected_amount_cents AS b_expected
    FROM fee_periods a
    JOIN fee_periods b
      ON a.enrollment_id = b.enrollment_id
     AND a.id < b.id
     AND a.period_start <= b.period_end
     AND a.period_end >= b.period_start
    ORDER BY a.enrollment_id, a.period_start
  `);

  const rows = overlaps.rows as Array<Record<string, unknown>>;

  console.log(`\n=== Overlapping fee_periods pairs found: ${rows.length} ===\n`);
  if (rows.length === 0) {
    console.log("No overlapping fee_periods rows exist in this database. Nothing further to report.");
    await auditGeneral();
    process.exit(0);
  }

  const enrollmentIds = [...new Set(rows.map((r) => String(r.enrollment_id)))];
  console.log(`Affected enrollments: ${enrollmentIds.length}\n`);

  // Enrollment -> student/batch/course context, for a human-readable report.
  const enrollmentInfo = await db
    .select({
      enrollmentId: batchEnrollments.id,
      studentId: batchEnrollments.studentId,
      studentName: students.fullName,
      studentNumber: students.studentNumber,
      batchName: batches.name,
      courseName: courses.name,
      academyId: batchEnrollments.academyId,
    })
    .from(batchEnrollments)
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(courses, eq(courses.id, batches.courseId))
    .where(inArray(batchEnrollments.id, enrollmentIds));
  const infoByEnrollment = new Map(enrollmentInfo.map((r) => [r.enrollmentId, r]));

  const schedules = await db
    .select()
    .from(enrollmentFeeSchedules)
    .where(inArray(enrollmentFeeSchedules.enrollmentId, enrollmentIds));
  const scheduleByEnrollment = new Map(schedules.map((r) => [r.enrollmentId, r]));

  for (const enrollmentId of enrollmentIds) {
    const info = infoByEnrollment.get(enrollmentId);
    const schedule = scheduleByEnrollment.get(enrollmentId);
    console.log("=".repeat(100));
    console.log(`Enrollment: ${enrollmentId}`);
    console.log(
      info
        ? `Student: ${info.studentName} (${info.studentNumber})  |  Batch: ${info.batchName}  |  Course: ${info.courseName}  |  Academy: ${info.academyId}`
        : "Student/batch context not found (orphan enrollment?)",
    );
    console.log(
      schedule
        ? `Current schedule: every ${schedule.intervalMonths} month(s), ${schedule.amountCents} cents, anchor ${schedule.anchorDate}`
        : "No current fee schedule row",
    );

    // Every fee_periods row for this enrollment, in order, with its
    // approved-paid total and every payment touching it.
    const periods = await db
      .select()
      .from(feePeriods)
      .where(eq(feePeriods.enrollmentId, enrollmentId))
      .orderBy(asc(feePeriods.periodStart));

    const periodIds = periods.map((p) => p.id);
    const allocRows = periodIds.length
      ? await db
          .select({
            feePeriodId: paymentAllocations.feePeriodId,
            allocationId: paymentAllocations.id,
            allocationAmountCents: paymentAllocations.amountCents,
            paymentId: studentPayments.id,
            paymentAmountCents: studentPayments.amountCents,
            paymentStatus: studentPayments.status,
            paymentReceivedAt: studentPayments.receivedAt,
            paymentRecordedBy: studentPayments.recordedBy,
            paymentReversedPaymentId: studentPayments.reversedPaymentId,
          })
          .from(paymentAllocations)
          .innerJoin(studentPayments, eq(paymentAllocations.studentPaymentId, studentPayments.id))
          .where(inArray(paymentAllocations.feePeriodId, periodIds))
      : [];
    const allocByPeriod = new Map<string, typeof allocRows>();
    for (const row of allocRows) {
      const list = allocByPeriod.get(row.feePeriodId) ?? [];
      list.push(row);
      allocByPeriod.set(row.feePeriodId, list);
    }

    const overlappingPairsForEnrollment = rows.filter((r) => String(r.enrollment_id) === enrollmentId);
    const overlappingIds = new Set<string>();
    for (const pair of overlappingPairsForEnrollment) {
      overlappingIds.add(String(pair.a_id));
      overlappingIds.add(String(pair.b_id));
    }

    console.log(`\nAll ${periods.length} fee_periods row(s) for this enrollment:`);
    let expectedTotal = 0;
    let approvedPaidTotal = 0;
    for (const period of periods) {
      const allocs = allocByPeriod.get(period.id) ?? [];
      const approvedPaid = allocs
        .filter((a) => a.paymentStatus === "approved")
        .reduce((sum, a) => sum + a.allocationAmountCents, 0);
      expectedTotal += period.expectedAmountCents;
      approvedPaidTotal += approvedPaid;
      const flag = overlappingIds.has(period.id) ? " *** OVERLAPS ANOTHER PERIOD ***" : "";
      console.log(
        `  [${period.id}] ${period.periodStart} - ${period.periodEnd}  (${period.intervalMonths}mo)  due ${period.dueDate}  expected=${period.expectedAmountCents}  approvedPaid=${approvedPaid}${flag}`,
      );
      if (allocs.length === 0) {
        console.log(`      no payments allocated to this period`);
      }
      for (const a of allocs) {
        console.log(
          `      allocation ${a.allocationId}: ${a.allocationAmountCents} cents from payment ${a.paymentId} ` +
            `(status=${a.paymentStatus}, amount=${a.paymentAmountCents}, receivedAt=${a.paymentReceivedAt.toISOString()}, ` +
            `recordedBy=${a.paymentRecordedBy}${a.paymentReversedPaymentId ? `, reversalOf=${a.paymentReversedPaymentId}` : ""})`,
        );
      }
    }

    console.log(`\nOverlapping pairs for this enrollment: ${overlappingPairsForEnrollment.length}`);
    for (const pair of overlappingPairsForEnrollment) {
      console.log(
        `  A [${pair.a_id}] ${pair.a_start}-${pair.a_end} (${pair.a_interval}mo, expected=${pair.a_expected})` +
          `  overlaps  B [${pair.b_id}] ${pair.b_start}-${pair.b_end} (${pair.b_interval}mo, expected=${pair.b_expected})`,
      );
    }

    console.log(
      `\nRaw totals across ALL periods (including overlaps, i.e. "what the table would sum to"): expected=${expectedTotal} approvedPaid=${approvedPaidTotal}`,
    );
    console.log("");
  }

  await auditGeneral();
  process.exit(0);
}

/** General sanity counts, unconditional on whether overlaps were found. */
async function auditGeneral() {
  const [{ count: totalPeriods }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(feePeriods);
  const [{ count: totalEnrollmentsWithPeriods }] = await db
    .select({ count: sql<number>`count(distinct ${feePeriods.enrollmentId})::int` })
    .from(feePeriods);
  const [{ count: totalFeePeriodPayments }] = await db
    .select({ count: sql<number>`count(distinct ${paymentAllocations.studentPaymentId})::int` })
    .from(paymentAllocations);
  const [{ count: reversedFeePeriodPayments }] = await db
    .select({ count: sql<number>`count(distinct ${studentPayments.id})::int` })
    .from(studentPayments)
    .innerJoin(paymentAllocations, eq(paymentAllocations.studentPaymentId, studentPayments.id))
    .where(eq(studentPayments.status, "reversed"));

  console.log("=".repeat(100));
  console.log("General fee-period ledger counts:");
  console.log(`  total fee_periods rows: ${totalPeriods}`);
  console.log(`  distinct enrollments with fee_periods: ${totalEnrollmentsWithPeriods}`);
  console.log(`  distinct student_payments rows with at least one allocation: ${totalFeePeriodPayments}`);
  console.log(`  of those, currently status='reversed': ${reversedFeePeriodPayments}`);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
