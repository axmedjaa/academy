import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  approvalRequests,
  auditLogs,
  branches,
  expenseRecords,
  incomeRecords,
  notifications,
  receipts,
  studentCharges,
  students,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  adjustExpenseRecord,
  adjustIncomeRecord,
  adjustStudentPayment,
  reverseExpenseRecord,
  reverseIncomeRecord,
  reverseStudentPayment,
} from "./finance-reversals";
import { approveStudentPayment, recordStudentPayment } from "./student-payments";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `finance-reversals-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Finance Reversals Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
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

async function createAcademy(creatorUserId: string, defaultCurrency = "USD"): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Finance Reversals Test Academy ${randomUUID()}`,
      slug: `finance-reversals-test-${randomUUID()}`,
      defaultCurrency,
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const code = `BR-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(branches)
    .values({ academyId, name: `Branch ${code}`, code })
    .returning({ id: branches.id });
  return row.id;
}

async function insertStudentDirect(
  academyId: string,
  branchId: string,
  creatorUserId: string,
): Promise<string> {
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

async function insertPaymentDirect(
  academyId: string,
  studentId: string,
  recordedByUserId: string,
  status: "pending_approval" | "approved" | "rejected" | "reversed" = "approved",
  amountCents = 5_000,
  chargeId?: string,
): Promise<string> {
  const [row] = await db
    .insert(studentPayments)
    .values({
      academyId,
      studentId,
      chargeId,
      amountCents,
      currency: "USD",
      method: "cash",
      receivedAt: new Date(),
      recordedBy: recordedByUserId,
      status,
      approvedBy: status === "approved" ? recordedByUserId : undefined,
      approvedAt: status === "approved" ? new Date() : undefined,
    })
    .returning({ id: studentPayments.id });
  return row.id;
}

/** Same shape as student-payments.test.ts's own `insertChargeDirect` — this
 * file didn't need `student_charges` at all until the confirmed Phase 4
 * audit gap fix (charge-status recalculation on reversal/adjustment). */
async function insertChargeDirect(
  academyId: string,
  studentId: string,
  creatorUserId: string,
  amountCents = 10_000,
): Promise<string> {
  const [row] = await db
    .insert(studentCharges)
    .values({
      academyId,
      studentId,
      description: "Tuition",
      amountCents,
      currency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: studentCharges.id });
  return row.id;
}

async function insertIncomeDirect(
  academyId: string,
  recordedByUserId: string,
  status: "posted" | "reversed" = "posted",
  amountCents = 8_000,
): Promise<string> {
  const [row] = await db
    .insert(incomeRecords)
    .values({
      academyId,
      category: "Registration fees",
      amountCents,
      currency: "USD",
      recordedBy: recordedByUserId,
      status,
    })
    .returning({ id: incomeRecords.id });
  return row.id;
}

async function insertExpenseDirect(
  academyId: string,
  submittedByUserId: string,
  status: "draft" | "pending_approval" | "approved" | "rejected" | "reversed" = "approved",
  amountCents = 12_000,
): Promise<string> {
  const [row] = await db
    .insert(expenseRecords)
    .values({
      academyId,
      category: "Supplies",
      amountCents,
      currency: "USD",
      submittedBy: submittedByUserId,
      status,
      approvedBy: status === "approved" ? submittedByUserId : undefined,
      approvedAt: status === "approved" ? new Date() : undefined,
    })
    .returning({ id: expenseRecords.id });
  return row.id;
}

/** Full fixture: fresh academy, active subscription, one branch, one
 * student, plus a "recorder" user (who records the original transaction)
 * and a distinct actor of the given role (who attempts the reversal) —
 * kept as two separate users by default so tests aren't accidentally
 * exercising the self-reversal guard unless they mean to. */
async function setupAcademy(
  role: AcademyRole,
): Promise<{
  academyId: string;
  branchId: string;
  studentId: string;
  recorderUserId: string;
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

  const recorderUserId = await createUser();

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    branchId,
    studentId,
    recorderUserId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

async function addActingUser(
  academyId: string,
  role: AcademyRole,
): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
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
    const paymentRows = await db
      .select({ id: studentPayments.id })
      .from(studentPayments)
      .where(eq(studentPayments.academyId, academyId));
    for (const payment of paymentRows) {
      await db.delete(receipts).where(eq(receipts.studentPaymentId, payment.id));
    }
    // Self-FK rows must be nulled before the referencing rows can be
    // deleted (a reversal row references the original via
    // reversedPaymentId/reversedRecordId).
    await db
      .update(studentPayments)
      .set({ reversedPaymentId: null })
      .where(eq(studentPayments.academyId, academyId));
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    // Added alongside the charge-recalculation-on-reversal tests — payments
    // reference charges (never the reverse), so this must run after the
    // studentPayments delete above.
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));

    await db
      .update(incomeRecords)
      .set({ reversedRecordId: null })
      .where(eq(incomeRecords.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));

    await db
      .update(expenseRecords)
      .set({ reversedRecordId: null })
      .where(eq(expenseRecords.academyId, academyId));
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));

    // Added alongside the charge-recalculation-on-reversal tests — those
    // use the real recordStudentPayment (unlike this file's other,
    // direct-insert-only tests), which creates a genuine approval_requests
    // row (and, via createApprovalRequest's own notification side effect, a
    // notifications row) per PLAN.md Item 52's confirmed gap fix. Both must
    // be deleted before the academy itself, same FK-ordering reasoning as
    // every other table in this teardown.
    await db.delete(approvalRequests).where(eq(approvalRequests.academyId, academyId));
    await db.delete(notifications).where(eq(notifications.academyId, academyId));
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

// =============================================================================
// reverseStudentPayment
// =============================================================================

describe("reverseStudentPayment — permission matrix (same authority as approveStudentPayment: Manager only)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reverse allowed = %s", async (role, allowed) => {
    const { academyId, studentId, recorderUserId, context } = await setupAcademy(role);
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const result = await reverseStudentPayment(context, paymentId, "Bounced cheque.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("reverseStudentPayment — mechanics, state, reason, self-reversal, audit, receipts, tenant isolation", () => {
  it("reverses an approved payment: original flips to 'reversed' (not deleted), a new linked row is inserted with status 'reversed' and reversedPaymentId pointing back", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved", 7_500);

    const beforeCount = await db.select().from(studentPayments).where(eq(studentPayments.academyId, academyId));
    expect(beforeCount).toHaveLength(1);

    const result = await reverseStudentPayment(manager.context, paymentId, "Duplicate charge.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.original.id).toBe(paymentId);
    expect(result.original.status).toBe("reversed");
    expect(result.original.amountCents).toBe(7_500); // untouched core field

    expect(result.reversal.id).not.toBe(paymentId);
    expect(result.reversal.status).toBe("reversed");
    expect(result.reversal.reversedPaymentId).toBe(paymentId);
    expect(result.reversal.reversalReason).toBe("Duplicate charge.");
    expect(result.reversal.amountCents).toBe(7_500);
    expect(result.reversal.studentId).toBe(studentId);

    // No-hard-delete: row count increased by one (original retained + new
    // linked row), never decreased.
    const afterRows = await db.select().from(studentPayments).where(eq(studentPayments.academyId, academyId));
    expect(afterRows).toHaveLength(2);
    const originalRow = afterRows.find((r) => r.id === paymentId);
    expect(originalRow).toBeTruthy();
    expect(originalRow?.status).toBe("reversed");
  });

  it("refuses to reverse a 'pending_approval' payment with code 'invalid_state'", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "pending_approval");

    const result = await reverseStudentPayment(manager.context, paymentId, "Some reason.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to reverse a 'rejected' payment with code 'invalid_state'", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "rejected");

    const result = await reverseStudentPayment(manager.context, paymentId, "Some reason.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to reverse an already-'reversed' payment with code 'invalid_state' (no double reversal)", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const first = await reverseStudentPayment(manager.context, paymentId, "First reversal.");
    expect(first.ok).toBe(true);

    const second = await reverseStudentPayment(manager.context, paymentId, "Second attempt.");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("invalid_state");
  });

  it("requires a non-empty reason with code 'validation'", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const result = await reverseStudentPayment(manager.context, paymentId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("self-reversal: the recorder of the original payment cannot reverse it themselves, even as Manager", async () => {
    const { academyId, studentId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, manager.userId, "approved");

    const result = await reverseStudentPayment(manager.context, paymentId, "Trying to self-reverse.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    // A different Manager can still reverse it.
    const otherManager = await addActingUser(academyId, "manager");
    const secondAttempt = await reverseStudentPayment(otherManager.context, paymentId, "Valid reversal.");
    expect(secondAttempt.ok).toBe(true);
  });

  it("writes an audit row with before/after status and the reason", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const result = await reverseStudentPayment(manager.context, paymentId, "Audit trail check.");
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, paymentId), eq(auditLogs.action, "reverseStudentPayment")));
    expect(audit).toBeTruthy();
    expect(audit?.reason).toBe("Audit trail check.");
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("leaves an existing receipt on the reversed payment untouched — never deleted, never modified", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const [receipt] = await db
      .insert(receipts)
      .values({
        academyId,
        studentPaymentId: paymentId,
        receiptNumber: `RCT-${randomUUID().slice(0, 8)}`,
        issuedAt: new Date(),
        issuedBy: recorderUserId,
      })
      .returning();

    const result = await reverseStudentPayment(manager.context, paymentId, "Refunded.");
    expect(result.ok).toBe(true);

    const [stillThere] = await db.select().from(receipts).where(eq(receipts.id, receipt.id));
    expect(stillThere).toBeTruthy();
    expect(stillThere.studentPaymentId).toBe(paymentId);
    expect(stillThere.receiptNumber).toBe(receipt.receiptNumber);
    expect(stillThere.issuedAt.getTime()).toBe(receipt.issuedAt.getTime());
  });

  it("rejects a cross-academy payment id with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const otherPaymentId = await insertPaymentDirect(other.academyId, other.studentId, other.recorderUserId, "approved");

    const { academyId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const result = await reverseStudentPayment(manager.context, otherPaymentId, "Cross tenant attempt.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent payment id with code 'not_found'", async () => {
    const { academyId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const result = await reverseStudentPayment(manager.context, randomUUID(), "N/A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

// =============================================================================
// Confirmed Phase 4 post-implementation audit gap fix — reversing/adjusting
// a charge-linked student payment must recalculate the linked
// student_charges.status the same way approveStudentPayment already does.
// Uses the REAL recordStudentPayment/approveStudentPayment functions (not
// insertPaymentDirect) to build up the "approved, charge-linked" starting
// state, since the recalculation only ever runs inside those functions'
// own transactions — a direct insert of an "approved" row would never have
// triggered it in the first place, which would make requirement 1 below
// untestable as a REGRESSION check (it would trivially pass even if the
// approval-side recalculation itself were broken).
// =============================================================================
describe("reversal/adjustment recalculates the linked student_charges.status (Phase 4 audit gap fix)", () => {
  it("1. sanity check: an approved, charge-linked payment makes the charge paid/partially_paid as appropriate (pre-existing approveStudentPayment behavior, unchanged)", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.recorderUserId, 10_000);

    const partial = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 4_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    await approveStudentPayment(approver.context, partial.payment.id);

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");

    const rest = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 6_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    await approveStudentPayment(approver.context, rest.payment.id);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");
  });

  it("2. reversing a fully-paid charge's only approved payment recalculates the charge back to 'open'", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.recorderUserId, 10_000);

    const payment = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 10_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(payment.ok).toBe(true);
    if (!payment.ok) return;
    await approveStudentPayment(approver.context, payment.payment.id);

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");

    // Reversed by a THIRD user (not the recorder, not required to be the
    // same approver) — any Manager who isn't the recorder may reverse.
    const reverser = await addActingUser(recorder.academyId, "manager");
    const reversed = await reverseStudentPayment(reverser.context, payment.payment.id, "Bounced cheque.");
    expect(reversed.ok).toBe(true);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("open");
  });

  it("3. adjusting an approved payment down to a smaller corrected amount recalculates the charge from 'paid' to 'partially_paid'", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.recorderUserId, 10_000);

    const payment = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 10_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(payment.ok).toBe(true);
    if (!payment.ok) return;
    await approveStudentPayment(approver.context, payment.payment.id);

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");

    // adjustStudentPayment flips the ORIGINAL to "reversed" (per this
    // file's own module comment: an adjustment never leaves a live
    // "approved" row) — the corrected 4,000 lands on a new row that is
    // itself born "reversed", so it never counts toward the charge either.
    // The charge's paid total after this adjustment is therefore 0, not
    // 4,000 — matching the module comment's "adjustX only fixes the audit
    // trail's record, it does not re-inject money into any report" rule.
    const reverser = await addActingUser(recorder.academyId, "manager");
    const adjusted = await adjustStudentPayment(reverser.context, payment.payment.id, "Recorded wrong amount.", 4_000);
    expect(adjusted.ok).toBe(true);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("open");
  });

  it("4. reversing one of several approved payments on the same charge leaves the charge reflecting the correct remaining aggregate", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.recorderUserId, 10_000);

    const first = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 3_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await approveStudentPayment(approver.context, first.payment.id);

    const second = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 4_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await approveStudentPayment(approver.context, second.payment.id);

    const third = await recordStudentPayment(recorder.context, {
      studentId: recorder.studentId,
      chargeId,
      amountCents: 3_000,
      method: "cash",
      receivedAt: new Date(),
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    await approveStudentPayment(approver.context, third.payment.id);

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid"); // 3,000 + 4,000 + 3,000 = 10,000

    // Reverse only the middle (4,000) payment — 3,000 + 3,000 = 6,000 remains
    // approved, which is > 0 and < 10,000 -> partially_paid.
    const reverser = await addActingUser(recorder.academyId, "manager");
    const reversed = await reverseStudentPayment(reverser.context, second.payment.id, "Duplicate entry.");
    expect(reversed.ok).toBe(true);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");
  });

  it("5. reversing a payment with no linked charge (chargeId null) succeeds with no recalculation attempted", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved", 5_000);

    const result = await reverseStudentPayment(manager.context, paymentId, "No charge attached.");
    expect(result.ok).toBe(true);
  });
});

describe("adjustStudentPayment", () => {
  it("inserts the new linked row with the corrected amount instead of a copy of the original's, while the original still flips to 'reversed' with its own amount untouched", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved", 10_000);

    const result = await adjustStudentPayment(manager.context, paymentId, "Amount was recorded wrong.", 6_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.original.amountCents).toBe(10_000);
    expect(result.original.status).toBe("reversed");
    expect(result.reversal.amountCents).toBe(6_000);
    expect(result.reversal.reversedPaymentId).toBe(paymentId);
  });

  it("still requires the same Manager-only authority as reverseStudentPayment", async () => {
    const { academyId, studentId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const paymentId = await insertPaymentDirect(academyId, studentId, recorderUserId, "approved");

    const result = await adjustStudentPayment(financeOfficer.context, paymentId, "Trying to adjust.", 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

// =============================================================================
// reverseIncomeRecord
// =============================================================================

describe("reverseIncomeRecord — permission matrix (reuses the create-level authority: Manager or Finance Officer)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])("role %s: reverse allowed = %s", async (role, allowed) => {
    const { academyId, recorderUserId, context } = await setupAcademy(role);
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted");

    const result = await reverseIncomeRecord(context, incomeId, "Recorded in error.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("reverseIncomeRecord — mechanics, state, reason, self-reversal, audit, tenant isolation", () => {
  it("reverses a 'posted' income record: original flips to 'reversed' (not deleted), a new linked row is inserted with status 'reversed' and reversedRecordId pointing back", async () => {
    const { academyId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted", 9_000);

    const result = await reverseIncomeRecord(financeOfficer.context, incomeId, "Duplicate entry.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.original.id).toBe(incomeId);
    expect(result.original.status).toBe("reversed");
    expect(result.original.amountCents).toBe(9_000);

    expect(result.reversal.status).toBe("reversed");
    expect(result.reversal.reversedRecordId).toBe(incomeId);
    expect(result.reversal.amountCents).toBe(9_000);
    expect(result.reversal.description).toContain("Duplicate entry.");

    const afterRows = await db.select().from(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    expect(afterRows).toHaveLength(2);
  });

  it("any 'posted' row may be reversed — no 'from X only' qualifier for income, unlike student_payments/expense_records", async () => {
    const { academyId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted");

    const result = await reverseIncomeRecord(financeOfficer.context, incomeId, "Any posted row qualifies.");
    expect(result.ok).toBe(true);
  });

  it("refuses to reverse an already-'reversed' income record with code 'invalid_state'", async () => {
    const { academyId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "reversed");

    const result = await reverseIncomeRecord(financeOfficer.context, incomeId, "Already reversed.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("requires a non-empty reason with code 'validation'", async () => {
    const { academyId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted");

    const result = await reverseIncomeRecord(financeOfficer.context, incomeId, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("self-reversal: the recorder cannot reverse their own income record", async () => {
    const { academyId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, financeOfficer.userId, "posted");

    const result = await reverseIncomeRecord(financeOfficer.context, incomeId, "Self reversal attempt.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    const otherFinanceOfficer = await addActingUser(academyId, "finance_officer");
    const secondAttempt = await reverseIncomeRecord(otherFinanceOfficer.context, incomeId, "Valid reversal.");
    expect(secondAttempt.ok).toBe(true);
  });

  it("writes an audit row with the reason", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted");

    await reverseIncomeRecord(manager.context, incomeId, "Audit check.");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, incomeId), eq(auditLogs.action, "reverseIncomeRecord")));
    expect(audit?.reason).toBe("Audit check.");
  });

  it("rejects a cross-academy income record id with code 'not_found'", async () => {
    const other = await setupAcademy("finance_officer");
    const otherIncomeId = await insertIncomeDirect(other.academyId, other.recorderUserId, "posted");

    const { academyId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const result = await reverseIncomeRecord(financeOfficer.context, otherIncomeId, "Cross tenant.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("adjustIncomeRecord", () => {
  it("inserts the new linked row with the corrected amount, original untouched besides status", async () => {
    const { academyId, recorderUserId } = await setupAcademy("finance_officer");
    const financeOfficer = await addActingUser(academyId, "finance_officer");
    const incomeId = await insertIncomeDirect(academyId, recorderUserId, "posted", 5_000);

    const result = await adjustIncomeRecord(financeOfficer.context, incomeId, "Wrong amount entered.", 4_200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.original.amountCents).toBe(5_000);
    expect(result.reversal.amountCents).toBe(4_200);
  });
});

// =============================================================================
// reverseExpenseRecord
// =============================================================================

describe("reverseExpenseRecord — permission matrix (same authority as approveExpense: Admin/Manager only)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reverse allowed = %s", async (role, allowed) => {
    const { academyId, recorderUserId, context } = await setupAcademy(role);
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "approved");

    const result = await reverseExpenseRecord(context, expenseId, "Duplicate expense.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("reverseExpenseRecord — mechanics, state, reason, self-reversal, audit, tenant isolation", () => {
  it("reverses an 'approved' expense: original flips to 'reversed' (not deleted), a new linked row is inserted with status 'reversed' and reversedRecordId pointing back", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "approved", 15_000);

    const result = await reverseExpenseRecord(manager.context, expenseId, "Vendor refunded us.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.original.status).toBe("reversed");
    expect(result.original.amountCents).toBe(15_000);
    expect(result.reversal.status).toBe("reversed");
    expect(result.reversal.reversedRecordId).toBe(expenseId);
    expect(result.reversal.amountCents).toBe(15_000);
    expect(result.reversal.description).toContain("Vendor refunded us.");

    const afterRows = await db.select().from(expenseRecords).where(eq(expenseRecords.academyId, academyId));
    expect(afterRows).toHaveLength(2);
  });

  it("refuses to reverse a 'draft' expense with code 'invalid_state'", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "draft");

    const result = await reverseExpenseRecord(manager.context, expenseId, "Not applicable.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to reverse a 'pending_approval' expense with code 'invalid_state'", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "pending_approval");

    const result = await reverseExpenseRecord(manager.context, expenseId, "Not applicable.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("requires a non-empty reason with code 'validation'", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "approved");

    const result = await reverseExpenseRecord(manager.context, expenseId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("self-reversal: the submitter of the original expense cannot reverse it themselves, even as Manager", async () => {
    const { academyId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, manager.userId, "approved");

    const result = await reverseExpenseRecord(manager.context, expenseId, "Self reversal attempt.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    const admin = await addActingUser(academyId, "academy_admin");
    const secondAttempt = await reverseExpenseRecord(admin.context, expenseId, "Valid reversal.");
    expect(secondAttempt.ok).toBe(true);
  });

  it("writes an audit row with before/after status and the reason", async () => {
    const { academyId, recorderUserId } = await setupAcademy("academy_admin");
    const admin = await addActingUser(academyId, "academy_admin");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "approved");

    await reverseExpenseRecord(admin.context, expenseId, "Audit check.");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, expenseId), eq(auditLogs.action, "reverseExpenseRecord")));
    expect(audit?.reason).toBe("Audit check.");
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("rejects a cross-academy expense id with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const otherExpenseId = await insertExpenseDirect(other.academyId, other.recorderUserId, "approved");

    const { academyId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const result = await reverseExpenseRecord(manager.context, otherExpenseId, "Cross tenant.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent expense id with code 'not_found'", async () => {
    const { academyId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const result = await reverseExpenseRecord(manager.context, randomUUID(), "N/A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("adjustExpenseRecord", () => {
  it("inserts the new linked row with the corrected amount, original untouched besides status", async () => {
    const { academyId, recorderUserId } = await setupAcademy("manager");
    const manager = await addActingUser(academyId, "manager");
    const expenseId = await insertExpenseDirect(academyId, recorderUserId, "approved", 20_000);

    const result = await adjustExpenseRecord(manager.context, expenseId, "Wrong amount submitted.", 18_500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.original.amountCents).toBe(20_000);
    expect(result.reversal.amountCents).toBe(18_500);
  });
});
