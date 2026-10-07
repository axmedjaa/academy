/**
 * One-time data repair for the reported "caaxi cali / STD-000008" payment
 * and fee-period mismatch.
 *
 * Root cause (see fee-periods.ts's setEnrollmentFeeSchedule doc comment for
 * the general fix): this enrollment's schedule was first anchored on the
 * wrong date (2026-10-30, from the pre-anchor-date-fix bug), a $10 payment
 * was recorded against that period (receipt RCT-000007), and the schedule
 * was LATER corrected to the right anchor (2026-10-06) — at that moment
 * nothing had "started" yet under the OLD code, so it silently created a
 * brand-new, disconnected period at the new anchor instead of recognizing
 * the existing payment, orphaning it on the old (now never-shown) period.
 *
 * This script performs exactly two writes, in one transaction, and nothing
 * else:
 *   1. Re-point the EXISTING payment_allocations row from the obsolete
 *      2026-10-30 period onto the correct, current 2026-10-06 period.
 *      The payment and receipt themselves (student_payments, receipts)
 *      are never touched — same row, same amount, same status, same
 *      received date.
 *   2. Delete the now-empty, superseded 2026-10-30 fee_periods row (zero
 *      remaining references to it after step 1) — this enrollment's
 *      schedule is a single 1-month installment; leaving a second,
 *      disconnected period around would itself be the "duplicate period"
 *      problem, not a fix for it.
 *
 * No payment is deleted or duplicated. No enrollment, permission, or
 * unrelated schedule is touched. Verifies the before/after state and
 * refuses to act if reality doesn't match what was audited.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { batchEnrollments, feePeriods, paymentAllocations, receipts, studentPayments, students } from "@/lib/db/schema";

const STUDENT_NUMBER = "STD-000008";
const OBSOLETE_PERIOD_ID = "699bad44-09bb-4043-81e7-c35de44fac41"; // 2026-10-30 – 2026-11-29
const CURRENT_PERIOD_ID = "5c35c2a2-1fbe-4653-bb65-1c176c102b86"; // 2026-10-06 – 2026-11-05
const ALLOCATION_ID = "fe8c1da2-048a-4d5f-8028-e54859daa307";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const [student] = await db.select().from(students).where(eq(students.studentNumber, STUDENT_NUMBER));
  if (!student) throw new Error(`Student ${STUDENT_NUMBER} not found — aborting, nothing written.`);
  console.log(`Student: ${student.fullName} (${student.studentNumber})`);

  const [obsoletePeriod] = await db.select().from(feePeriods).where(eq(feePeriods.id, OBSOLETE_PERIOD_ID));
  const [currentPeriod] = await db.select().from(feePeriods).where(eq(feePeriods.id, CURRENT_PERIOD_ID));
  if (!obsoletePeriod || !currentPeriod) {
    throw new Error("Expected fee_periods rows not found — aborting, nothing written.");
  }
  console.log(`Obsolete period: ${obsoletePeriod.periodStart} – ${obsoletePeriod.periodEnd} (expected ${money(obsoletePeriod.expectedAmountCents)})`);
  console.log(`Current period:  ${currentPeriod.periodStart} – ${currentPeriod.periodEnd} (expected ${money(currentPeriod.expectedAmountCents)})`);

  const [allocation] = await db.select().from(paymentAllocations).where(eq(paymentAllocations.id, ALLOCATION_ID));
  if (!allocation || allocation.feePeriodId !== OBSOLETE_PERIOD_ID) {
    throw new Error("Allocation not found or not pointing where expected — aborting, nothing written.");
  }
  const [payment] = await db.select().from(studentPayments).where(eq(studentPayments.id, allocation.studentPaymentId));
  console.log(`\nPayment: ${money(payment.amountCents)}  status=${payment.status}  receivedAt=${payment.receivedAt.toISOString()}`);

  const existingAllocationsOnCurrent = await db
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.feePeriodId, CURRENT_PERIOD_ID));
  if (existingAllocationsOnCurrent.length > 0) {
    throw new Error("Current period already has an allocation — aborting to avoid double-counting.");
  }

  const otherAllocationsOnObsolete = await db
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.feePeriodId, OBSOLETE_PERIOD_ID));
  if (otherAllocationsOnObsolete.length !== 1) {
    throw new Error(`Expected exactly 1 allocation on the obsolete period, found ${otherAllocationsOnObsolete.length} — aborting.`);
  }

  console.log("\nApplying fix in one transaction: re-point the allocation, then delete the now-empty obsolete period...");
  await db.transaction(async (tx) => {
    await tx.update(paymentAllocations).set({ feePeriodId: CURRENT_PERIOD_ID }).where(eq(paymentAllocations.id, ALLOCATION_ID));
    await tx.delete(feePeriods).where(eq(feePeriods.id, OBSOLETE_PERIOD_ID));
  });

  // Verify.
  const [stillPayment] = await db.select().from(studentPayments).where(eq(studentPayments.id, allocation.studentPaymentId));
  const [movedAllocation] = await db.select().from(paymentAllocations).where(eq(paymentAllocations.id, ALLOCATION_ID));
  const remainingObsolete = await db.select().from(feePeriods).where(eq(feePeriods.id, OBSOLETE_PERIOD_ID));
  const [stillReceipt] = await db.select().from(receipts).where(eq(receipts.studentPaymentId, allocation.studentPaymentId));
  const enrollmentPeriods = await db.select().from(feePeriods).where(eq(feePeriods.enrollmentId, currentPeriod.enrollmentId));
  const [enrollment] = await db.select().from(batchEnrollments).where(eq(batchEnrollments.id, currentPeriod.enrollmentId));

  console.log("\n--- VERIFICATION ---");
  console.log(`Payment ${stillPayment.id} still exists: amount=${money(stillPayment.amountCents)} status=${stillPayment.status}`);
  console.log(`Receipt ${stillReceipt?.receiptNumber ?? "MISSING"} still references this payment.`);
  console.log(`Allocation now points to fee_period_id=${movedAllocation.feePeriodId} (expected ${CURRENT_PERIOD_ID}): ${movedAllocation.feePeriodId === CURRENT_PERIOD_ID ? "OK" : "MISMATCH"}`);
  console.log(`Obsolete period rows remaining: ${remainingObsolete.length} (expected 0)`);
  console.log(`Enrollment ${enrollment.id} now has ${enrollmentPeriods.length} fee_periods row(s) (expected 1): ${JSON.stringify(enrollmentPeriods.map((p) => ({ id: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, expected: p.expectedAmountCents })))}`);

  if (movedAllocation.feePeriodId !== CURRENT_PERIOD_ID || remainingObsolete.length !== 0 || enrollmentPeriods.length !== 1) {
    throw new Error("Post-fix verification failed — state is not as expected. Investigate before trusting the UI.");
  }
  console.log("\nFix applied successfully. No payment, receipt, enrollment, or permission was deleted or duplicated.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Repair failed:", err);
    process.exit(1);
  });
