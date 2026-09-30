/**
 * READ-ONLY reconciliation for one specific enrollment — no writes, no
 * deletes, no reversals, no reassignment. Reports every fee_periods row,
 * every student_payments row touching it, every payment_allocations row,
 * totals, and exactly which periods overlap / look structurally redundant.
 * Not wired into any app code; run manually, then delete.
 */
import { asc, eq, inArray } from "drizzle-orm";
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
  users,
} from "@/lib/db/schema";

const ENROLLMENT_ID = "77b4144e-5704-48f0-9de6-ddecfe56ef73";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

async function main() {
  const [enrollment] = await db
    .select({
      id: batchEnrollments.id,
      studentId: batchEnrollments.studentId,
      academyId: batchEnrollments.academyId,
      studentName: students.fullName,
      studentNumber: students.studentNumber,
      batchName: batches.name,
      courseName: courses.name,
    })
    .from(batchEnrollments)
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(courses, eq(courses.id, batches.courseId))
    .where(eq(batchEnrollments.id, ENROLLMENT_ID));

  if (!enrollment) {
    console.log(`Enrollment ${ENROLLMENT_ID} not found.`);
    process.exit(0);
  }

  console.log("=".repeat(100));
  console.log(`RECONCILIATION REPORT — read-only, no writes performed`);
  console.log("=".repeat(100));
  console.log(`Enrollment: ${enrollment.id}`);
  console.log(`Student: ${enrollment.studentName} (${enrollment.studentNumber})`);
  console.log(`Batch: ${enrollment.batchName}  Course: ${enrollment.courseName}`);
  console.log(`Academy: ${enrollment.academyId}\n`);

  const [schedule] = await db
    .select()
    .from(enrollmentFeeSchedules)
    .where(eq(enrollmentFeeSchedules.enrollmentId, ENROLLMENT_ID));
  console.log(
    schedule
      ? `Current fee schedule: every ${schedule.intervalMonths} month(s), ${money(schedule.amountCents)}, anchor ${schedule.anchorDate}`
      : "No current fee schedule row.",
  );

  const periods = await db
    .select()
    .from(feePeriods)
    .where(eq(feePeriods.enrollmentId, ENROLLMENT_ID))
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
          paymentMethod: studentPayments.method,
          paymentReference: studentPayments.reference,
          paymentNotes: studentPayments.notes,
          paymentReceivedAt: studentPayments.receivedAt,
          paymentRecordedBy: studentPayments.recordedBy,
          recordedByEmail: users.email,
        })
        .from(paymentAllocations)
        .innerJoin(studentPayments, eq(paymentAllocations.studentPaymentId, studentPayments.id))
        .innerJoin(users, eq(users.id, studentPayments.recordedBy))
        .where(inArray(paymentAllocations.feePeriodId, periodIds))
    : [];

  const allocByPeriod = new Map<string, typeof allocRows>();
  for (const row of allocRows) {
    const list = allocByPeriod.get(row.feePeriodId) ?? [];
    list.push(row);
    allocByPeriod.set(row.feePeriodId, list);
  }

  console.log(`\n--- FEE PERIODS (${periods.length}) ---\n`);
  let totalExpected = 0;
  let totalApprovedPaid = 0;
  const periodSummaries: {
    id: string;
    periodStart: string;
    periodEnd: string;
    expected: number;
    paid: number;
  }[] = [];

  for (const period of periods) {
    const allocs = allocByPeriod.get(period.id) ?? [];
    const approvedPaid = allocs
      .filter((a) => a.paymentStatus === "approved")
      .reduce((sum, a) => sum + a.allocationAmountCents, 0);
    const remaining = Math.max(0, period.expectedAmountCents - approvedPaid);
    const status = remaining <= 0 ? "paid" : approvedPaid > 0 ? "partially_paid" : "unpaid";
    totalExpected += period.expectedAmountCents;
    totalApprovedPaid += approvedPaid;
    periodSummaries.push({
      id: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      expected: period.expectedAmountCents,
      paid: approvedPaid,
    });

    console.log(`Period [${period.id}]`);
    console.log(`  Range:      ${period.periodStart} – ${period.periodEnd}  (${period.intervalMonths} month interval)`);
    console.log(`  Due date:   ${period.dueDate}`);
    console.log(`  Expected:   ${money(period.expectedAmountCents)}`);
    console.log(`  Paid:       ${money(approvedPaid)}`);
    console.log(`  Remaining:  ${money(remaining)}`);
    console.log(`  Status:     ${status}`);
    console.log(`  Created:    ${period.createdAt.toISOString()}`);
    if (allocs.length === 0) {
      console.log(`  No payments allocated to this period.`);
    }
    for (const a of allocs) {
      console.log(
        `  - Allocation ${a.allocationId}: ${money(a.allocationAmountCents)} from payment ${a.paymentId}\n` +
          `      status=${a.paymentStatus}  paymentTotal=${money(a.paymentAmountCents)}  method=${a.paymentMethod}\n` +
          `      receivedAt=${a.paymentReceivedAt.toISOString()}  reference=${a.paymentReference ?? "—"}  notes=${a.paymentNotes ?? "—"}\n` +
          `      recordedBy=${a.recordedByEmail} (${a.paymentRecordedBy})`,
      );
    }
    console.log("");
  }

  console.log("--- OVERLAP ANALYSIS ---\n");
  const overlapPairs: string[] = [];
  for (let i = 0; i < periods.length; i += 1) {
    for (let j = i + 1; j < periods.length; j += 1) {
      const a = periods[i];
      const b = periods[j];
      if (overlaps(a.periodStart, a.periodEnd, b.periodStart, b.periodEnd)) {
        overlapPairs.push(
          `  [${a.id}] ${a.periodStart}-${a.periodEnd} (${a.intervalMonths}mo)  overlaps  [${b.id}] ${b.periodStart}-${b.periodEnd} (${b.intervalMonths}mo)`,
        );
      }
    }
  }
  if (overlapPairs.length === 0) {
    console.log("  No overlapping periods.");
  } else {
    overlapPairs.forEach((line) => console.log(line));
  }

  // "Structurally redundant" = a period whose entire date range is already
  // covered by ANOTHER period's range for the same enrollment (i.e. it
  // represents no calendar time not already billed elsewhere). Reported,
  // never acted on.
  console.log("\n--- STRUCTURAL REDUNDANCY (read-only judgment, not acted on) ---\n");
  let foundRedundant = false;
  for (const a of periods) {
    for (const b of periods) {
      if (a.id === b.id) continue;
      const aFullyInsideB = a.periodStart >= b.periodStart && a.periodEnd <= b.periodEnd;
      if (aFullyInsideB) {
        foundRedundant = true;
        console.log(
          `  Period [${a.id}] ${a.periodStart}-${a.periodEnd} is entirely contained within period [${b.id}] ${b.periodStart}-${b.periodEnd} — the later/shorter one covers no calendar time the other doesn't already claim.`,
        );
      }
    }
  }
  if (!foundRedundant) console.log("  None found by strict containment.");

  console.log("\n--- TOTALS (raw sum across ALL periods listed above, including overlaps) ---\n");
  console.log(`  Total expected (sum of every period's expected amount): ${money(totalExpected)}`);
  console.log(`  Total received (sum of every APPROVED allocation):      ${money(totalApprovedPaid)}`);

  // Distinct underlying payments (the real money actually received),
  // independent of how many periods each was allocated across.
  const distinctPaymentIds = new Set(allocRows.map((r) => r.paymentId));
  const distinctPayments = await db
    .select()
    .from(studentPayments)
    .where(inArray(studentPayments.id, [...distinctPaymentIds]));
  const realTotalReceived = distinctPayments
    .filter((p) => p.status === "approved")
    .reduce((sum, p) => sum + p.amountCents, 0);

  console.log(`\n--- DISTINCT UNDERLYING PAYMENTS (${distinctPayments.length}) — the actual money received ---\n`);
  for (const p of distinctPayments) {
    console.log(
      `  Payment [${p.id}]  ${money(p.amountCents)}  status=${p.status}  method=${p.method}  receivedAt=${p.receivedAt.toISOString()}` +
        `  reference=${p.reference ?? "—"}  notes=${p.notes ?? "—"}`,
    );
  }
  console.log(`\n  Real total money received (distinct approved payments, not double-counted by allocation spread): ${money(realTotalReceived)}`);

  console.log("\n" + "=".repeat(100));
  console.log("This report performed NO writes. No period/payment/allocation was deleted, reversed, moved, or altered.");
}

main().catch((err) => {
  console.error("Reconciliation failed:", err);
  process.exit(1);
});
