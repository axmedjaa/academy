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
  receipts,
  students,
  studentCharges,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  approveStudentPayment,
  createStudentCharge,
  getReceipt,
  issueReceipt,
  listStudentCharges,
  listStudentPayments,
  recordStudentPayment,
  rejectStudentPayment,
  type CreateStudentChargeInput,
  type RecordStudentPaymentInput,
} from "./student-payments";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `student-payments-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Student Payments Test Plan ${randomUUID()}`,
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

async function createAcademy(creatorUserId: string, defaultCurrency = "USD"): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Student Payments Test Academy ${randomUUID()}`,
      slug: `student-payments-test-${randomUUID()}`,
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

async function insertPaymentDirect(
  academyId: string,
  studentId: string,
  recordedByUserId: string,
  status: "pending_approval" | "approved" | "rejected" | "reversed" = "pending_approval",
  amountCents = 5_000,
): Promise<string> {
  const [row] = await db
    .insert(studentPayments)
    .values({
      academyId,
      studentId,
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

/** Full fixture: fresh academy, one active plan/subscription, one branch,
 * one student, one membership of the given role. */
async function setupAcademy(
  role: AcademyRole,
  defaultCurrency = "USD",
): Promise<{
  academyId: string;
  branchId: string;
  studentId: string;
  creatorUserId: string;
  userId: string;
  context: AuthContext;
}> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId, defaultCurrency);
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

  return {
    academyId,
    branchId,
    studentId,
    creatorUserId,
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

function validCharge(
  studentId: string,
  overrides: Partial<CreateStudentChargeInput> = {},
): CreateStudentChargeInput {
  return {
    studentId,
    description: "Tuition fee",
    amountCents: 10_000,
    ...overrides,
  };
}

async function fetchApprovalRequestForPayment(studentPaymentId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "student_payment"),
        eq(approvalRequests.entityId, studentPaymentId),
      ),
    );
  return row;
}

/** Records a real pending payment (going through `recordStudentPayment`
 * itself, not a direct insert) so the matching `approval_requests` row
 * genuinely exists — required for `approveStudentPayment`/
 * `rejectStudentPayment` to find it. */
async function recordPendingPaymentAs(recorderContext: AuthContext, studentId: string): Promise<string> {
  const result = await recordStudentPayment(recorderContext, validPayment(studentId));
  if (!result.ok) {
    throw new Error(`Failed to record test payment: ${result.error.message}`);
  }
  return result.payment.id;
}

function validPayment(
  studentId: string,
  overrides: Partial<RecordStudentPaymentInput> = {},
): RecordStudentPaymentInput {
  return {
    studentId,
    amountCents: 5_000,
    method: "cash",
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
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
  if (createdAcademyIds.length > 0) {
    await db
      .delete(approvalRequests)
      .where(or(...createdAcademyIds.map((id) => eq(approvalRequests.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    const paymentRows = await db
      .select({ id: studentPayments.id })
      .from(studentPayments)
      .where(eq(studentPayments.academyId, academyId));
    for (const payment of paymentRows) {
      await db.delete(receipts).where(eq(receipts.studentPaymentId, payment.id));
    }
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
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

describe("createStudentCharge — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])(
    "role %s: create allowed = %s (Owner/Admin/Trainer are view-only — the confirmed inversion)",
    async (role, allowed) => {
      const { studentId, context } = await setupAcademy(role);
      const result = await createStudentCharge(context, validCharge(studentId));
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("creates in 'open' status, writes an audit row, and resolves currency from the academy's default_currency", async () => {
    const { academyId, studentId, userId, context } = await setupAcademy("manager", "GBP");
    const result = await createStudentCharge(context, validCharge(studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.charge.status).toBe("open");
    expect(result.charge.createdBy).toBe(userId);
    expect(result.charge.currency).toBe("GBP");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.charge.id));
    expect(audit?.action).toBe("createStudentCharge");
    expect(audit?.academyId).toBe(academyId);
  });

  it("uses an explicitly supplied currency instead of the academy default", async () => {
    const { studentId, context } = await setupAcademy("finance_officer", "GBP");
    const result = await createStudentCharge(context, validCharge(studentId, { currency: "usd" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.charge.currency).toBe("USD");
  });

  it("rejects a negative amountCents at the application layer with code 'validation'", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const result = await createStudentCharge(context, validCharge(studentId, { amountCents: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects a cross-academy student id with code 'not_found' (never a distinguishing error)", async () => {
    const other = await setupAcademy("manager");
    const { context } = await setupAcademy("manager");
    const result = await createStudentCharge(context, validCharge(other.studentId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent student id with code 'not_found'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await createStudentCharge(context, validCharge(randomUUID()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("recordStudentPayment — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])("role %s: record allowed = %s", async (role, allowed) => {
    const { studentId, context } = await setupAcademy(role);
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("always creates with status 'pending_approval', regardless of who records it", async () => {
    const { studentId, context } = await setupAcademy("finance_officer");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payment.status).toBe("pending_approval");
  });

  it("resolves currency from the academy's default_currency when not supplied", async () => {
    const { studentId, context } = await setupAcademy("manager", "KES");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payment.currency).toBe("KES");
  });

  it("accepts a valid chargeId belonging to the same student/academy", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(academyId, studentId, creatorUserId);
    const result = await recordStudentPayment(context, validPayment(studentId, { chargeId }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payment.chargeId).toBe(chargeId);
  });

  it("rejects a chargeId belonging to a different student with code 'not_found'", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const otherStudentId = await insertStudentDirect(academyId, await insertBranchDirect(academyId), creatorUserId);
    const chargeId = await insertChargeDirect(academyId, otherStudentId, creatorUserId);

    const result = await recordStudentPayment(context, validPayment(studentId, { chargeId }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a chargeId belonging to a different academy with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const otherChargeId = await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId);

    const { studentId, context } = await setupAcademy("manager");
    const result = await recordStudentPayment(context, validPayment(studentId, { chargeId: otherChargeId }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy student id with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const { context } = await setupAcademy("manager");
    const result = await recordStudentPayment(context, validPayment(other.studentId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a negative amountCents at the application layer with code 'validation'", async () => {
    const { studentId, context } = await setupAcademy("finance_officer");
    const result = await recordStudentPayment(context, validPayment(studentId, { amountCents: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("creates a real pending approval_requests row (entityType 'student_payment') in the same transaction — the confirmed Item 52 gap fix", async () => {
    const { academyId, studentId, userId, context } = await setupAcademy("finance_officer");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const request = await fetchApprovalRequestForPayment(result.payment.id);
    expect(request).toBeTruthy();
    expect(request?.status).toBe("pending");
    expect(request?.entityType).toBe("student_payment");
    expect(request?.entityId).toBe(result.payment.id);
    expect(request?.requestedBy).toBe(userId);
    expect(request?.academyId).toBe(academyId);
  });
});

describe("approveStudentPayment — pending_approval -> approved (authority: Manager only)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])(
    "role %s: approve allowed = %s (Finance Officer's 'manage' level never reaches approve, even though they can record)",
    async (role, allowed) => {
      const recorder = await setupAcademy("manager");
      const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
      const approver = await addActingUser(recorder.academyId, role);

      const result = await approveStudentPayment(approver.context, paymentId);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("explicitly refuses the Finance Officer who recorded the payment themselves — Finance Officer never reaches approve authority, regardless of whose submission it is", async () => {
    const { studentId, context } = await setupAcademy("finance_officer");
    const paymentId = await recordPendingPaymentAs(context, studentId);

    const result = await approveStudentPayment(context, paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("approves: status -> approved, approved_by/approved_at set, approval_requests row decided, audit before/after recorded", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const approver = await addActingUser(recorder.academyId, "manager");

    const result = await approveStudentPayment(approver.context, paymentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.status).toBe("approved");
    expect(result.payment.approvedBy).toBe(approver.userId);
    expect(result.payment.approvedAt).not.toBeNull();

    const request = await fetchApprovalRequestForPayment(paymentId);
    expect(request?.status).toBe("approved");
    expect(request?.decidedBy).toBe(approver.userId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, paymentId), eq(auditLogs.action, "approveStudentPayment")));
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("self-approval is refused: a Manager who recorded the payment cannot approve their own (proves decideApprovalRequest's guard actually fires, not just assumed)", async () => {
    const { studentId, academyId, context } = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(context, studentId);

    const result = await approveStudentPayment(context, paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");

    // A different Manager can still approve it — proves the refusal above
    // was specifically about self-approval, not a general breakage.
    const otherManager = await addActingUser(academyId, "manager");
    const approved = await approveStudentPayment(otherManager.context, paymentId);
    expect(approved.ok).toBe(true);
  });

  it("refuses to approve an already-approved payment with a clear 'already_processed' error", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const approver = await addActingUser(recorder.academyId, "manager");
    const first = await approveStudentPayment(approver.context, paymentId);
    expect(first.ok).toBe(true);

    const second = await approveStudentPayment(approver.context, paymentId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_processed");
  });

  it("refuses to approve a rejected payment with a clear 'already_processed' error", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, "manager");
    const rejected = await rejectStudentPayment(decider.context, paymentId, "Insufficient evidence.");
    expect(rejected.ok).toBe(true);

    const result = await approveStudentPayment(decider.context, paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("already_processed");
  });

  it("resolves exactly one winner when two approve calls race on the same row (row-locked concurrency guard)", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const approver = await addActingUser(recorder.academyId, "manager");

    const [first, second] = await Promise.all([
      approveStudentPayment(approver.context, paymentId),
      approveStudentPayment(approver.context, paymentId),
    ]);
    const outcomes = [first.ok, second.ok];
    expect(outcomes.filter((ok) => ok).length).toBe(1);
    expect(outcomes.filter((ok) => !ok).length).toBe(1);
    const failed = [first, second].find((r) => !r.ok);
    if (failed && !failed.ok) expect(failed.error.code).toBe("already_processed");
  });

  it("rejects a nonexistent payment id with code 'not_found'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await approveStudentPayment(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy payment id with code 'not_found' (never a distinguishing error)", async () => {
    const other = await setupAcademy("manager");
    const otherPaymentId = await recordPendingPaymentAs(other.context, other.studentId);

    const { context } = await setupAcademy("manager");
    const result = await approveStudentPayment(context, otherPaymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("approveStudentPayment — linked student_charge status recalculation", () => {
  it("1. approval with no previous approved payments on the charge -> partially_paid", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const approver = await addActingUser(recorder.academyId, "manager");
    const approved = await approveStudentPayment(approver.context, result.payment.id);
    expect(approved.ok).toBe(true);

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");
  });

  it("2. approval that brings the paid total to/above the charge amount -> paid", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const approver = await addActingUser(recorder.academyId, "manager");
    const approved = await approveStudentPayment(approver.context, result.payment.id);
    expect(approved.ok).toBe(true);

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");
  });

  it("2b. an overpayment (paid total exceeds the charge amount) still resolves to paid, never an invalid status", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 15_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const approver = await addActingUser(recorder.academyId, "manager");
    await approveStudentPayment(approver.context, result.payment.id);

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");
  });

  it("3. multiple approved payments on the same charge accumulate to the correct cumulative status", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    const first = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 3_000 }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await approveStudentPayment(approver.context, first.payment.id);

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");

    const second = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await approveStudentPayment(approver.context, second.payment.id);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid"); // 3,000 + 4,000 = 7,000 < 10,000

    const third = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 3_000 }),
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    await approveStudentPayment(approver.context, third.payment.id);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid"); // 3,000 + 4,000 + 3,000 = 10,000
  });

  it("4. pending and rejected payments never count toward the charge's paid total", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    // A pending payment large enough to fully cover the charge, left
    // un-decided.
    const pending = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(pending.ok).toBe(true);

    // A rejected payment, also large enough to cover the charge.
    const toReject = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(toReject.ok).toBe(true);
    if (!toReject.ok) return;
    const rejected = await rejectStudentPayment(approver.context, toReject.payment.id, "Duplicate submission.");
    expect(rejected.ok).toBe(true);

    // Rejecting doesn't touch the charge — confirm it's still "open" (the
    // rejection path never calls the recalculation at all).
    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("open");

    // Now approve a small payment — only THIS amount should count.
    const small = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 2_000 }),
    );
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    const approved = await approveStudentPayment(approver.context, small.payment.id);
    expect(approved.ok).toBe(true);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    // Only the 2,000 approved payment counts — the still-pending 10,000 and
    // the rejected 10,000 are excluded, so this must be partially_paid, not
    // paid.
    expect(charge.status).toBe("partially_paid");
  });

  it("5. concurrent approval of two different payments on the same charge cannot produce an incorrect cumulative status (charge row lock serializes them)", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    const first = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }),
    );
    const second = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 6_000 }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const [approveFirst, approveSecond] = await Promise.all([
      approveStudentPayment(approver.context, first.payment.id),
      approveStudentPayment(approver.context, second.payment.id),
    ]);
    expect(approveFirst.ok).toBe(true);
    expect(approveSecond.ok).toBe(true);

    // Both payments' amounts must be reflected exactly once each — never
    // lost (a race that overwrites rather than accumulates) and never
    // double-counted.
    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid"); // 4,000 + 6,000 = 10,000, exactly the charge amount
  });

  it("5b. concurrent approve calls on the SAME payment leave the charge reflecting exactly one application, never double-counted (also exercises rollback of the losing attempt)", async () => {
    const recorder = await setupAcademy("manager");
    const approver = await addActingUser(recorder.academyId, "manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const payment = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }),
    );
    expect(payment.ok).toBe(true);
    if (!payment.ok) return;

    const [outcomeA, outcomeB] = await Promise.all([
      approveStudentPayment(approver.context, payment.payment.id),
      approveStudentPayment(approver.context, payment.payment.id),
    ]);
    const succeeded = [outcomeA, outcomeB].filter((r) => r.ok);
    expect(succeeded.length).toBe(1);

    // 7. Transaction rollback leaves both payment and charge unchanged: the
    // losing attempt's transaction (row-lock re-check fails ->
    // "already_processed") never reaches the payment update or the charge
    // recalculation at all — the payment is left exactly as the winner set
    // it, and the charge reflects the 4,000 payment exactly once, not twice
    // and not zero times.
    const [finalPayment] = await db
      .select()
      .from(studentPayments)
      .where(eq(studentPayments.id, payment.payment.id));
    expect(finalPayment.status).toBe("approved");

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid"); // exactly one 4,000 application, not two (8,000) or zero (open)
  });

  it("6. cross-academy/IDOR protection is unaffected by the recalculation change", async () => {
    const other = await setupAcademy("manager");
    const otherChargeId = await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId, 10_000);
    const otherPayment = await recordStudentPayment(
      other.context,
      validPayment(other.studentId, { chargeId: otherChargeId, amountCents: 5_000 }),
    );
    expect(otherPayment.ok).toBe(true);
    if (!otherPayment.ok) return;

    const { context } = await setupAcademy("manager");
    const result = await approveStudentPayment(context, otherPayment.payment.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    // The other academy's charge must be completely untouched by the
    // refused cross-academy attempt.
    const [otherCharge] = await db.select().from(studentCharges).where(eq(studentCharges.id, otherChargeId));
    expect(otherCharge.status).toBe("open");
  });

  it("a payment with no linked charge (chargeId null) approves normally with no recalculation attempted", async () => {
    const recorder = await setupAcademy("manager");
    const result = await recordStudentPayment(recorder.context, validPayment(recorder.studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.chargeId).toBeNull();

    const approver = await addActingUser(recorder.academyId, "manager");
    const approved = await approveStudentPayment(approver.context, result.payment.id);
    expect(approved.ok).toBe(true);
  });

  it("a charge already 'cancelled' is left untouched by a later payment approval (judgment call — terminal state)", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    await db.update(studentCharges).set({ status: "cancelled" }).where(eq(studentCharges.id, chargeId));

    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const approver = await addActingUser(recorder.academyId, "manager");
    const approved = await approveStudentPayment(approver.context, result.payment.id);
    expect(approved.ok).toBe(true);

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("cancelled");
  });
});

describe("rejectStudentPayment — pending_approval -> rejected (same authority as approve)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reject allowed = %s", async (role, allowed) => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, role);

    const result = await rejectStudentPayment(decider.context, paymentId, "Missing evidence.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason with code 'validation', and leaves the payment untouched", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, "manager");

    const result = await rejectStudentPayment(decider.context, paymentId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");

    const [row] = await db.select().from(studentPayments).where(eq(studentPayments.id, paymentId));
    expect(row?.status).toBe("pending_approval");
  });

  it("rejects: status -> rejected, approval_requests row decided + reason persisted, audit before/after recorded", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, "manager");

    const result = await rejectStudentPayment(decider.context, paymentId, "Duplicate submission.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.status).toBe("rejected");

    const request = await fetchApprovalRequestForPayment(paymentId);
    expect(request?.status).toBe("rejected");
    expect(request?.decidedBy).toBe(decider.userId);
    expect(request?.reason).toBe("Duplicate submission.");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, paymentId), eq(auditLogs.action, "rejectStudentPayment")));
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("self-approval guard also blocks self-rejection: a Manager who recorded the payment cannot decide their own", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(context, studentId);

    const result = await rejectStudentPayment(context, paymentId, "Not valid.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");
  });

  it("refuses to reject an already-rejected payment with a clear 'already_processed' error", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, "manager");
    const first = await rejectStudentPayment(decider.context, paymentId, "First reason.");
    expect(first.ok).toBe(true);

    const second = await rejectStudentPayment(decider.context, paymentId, "Second reason.");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_processed");
  });

  it("refuses to reject an already-approved payment with a clear 'already_processed' error", async () => {
    const recorder = await setupAcademy("manager");
    const paymentId = await recordPendingPaymentAs(recorder.context, recorder.studentId);
    const decider = await addActingUser(recorder.academyId, "manager");
    const approved = await approveStudentPayment(decider.context, paymentId);
    expect(approved.ok).toBe(true);

    const result = await rejectStudentPayment(decider.context, paymentId, "Too late.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("already_processed");
  });

  it("rejects a cross-academy payment id with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const otherPaymentId = await recordPendingPaymentAs(other.context, other.studentId);

    const { context } = await setupAcademy("manager");
    const result = await rejectStudentPayment(context, otherPaymentId, "Reason.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent payment id with code 'not_found'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await rejectStudentPayment(context, randomUUID(), "Reason.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("issueReceipt", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])("role %s: issue allowed (permission-wise) = %s", async (role, allowed) => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy(role);
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    const result = await issueReceipt(context, paymentId);
    expect(result.ok).toBe(allowed);
    if (!result.ok && !allowed) expect(result.error.code).toBe("forbidden");
  });

  it("refuses to issue a receipt for a 'pending_approval' payment with code 'invalid_state'", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "pending_approval");

    const result = await issueReceipt(context, paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to issue a receipt for a 'rejected' payment with code 'invalid_state'", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "rejected");

    const result = await issueReceipt(context, paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("succeeds for an 'approved' payment, generating a sequential receipt number", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const paymentAId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");
    const paymentBId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    const resultA = await issueReceipt(context, paymentAId);
    expect(resultA.ok).toBe(true);
    const resultB = await issueReceipt(context, paymentBId);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.receipt.receiptNumber).not.toBe(resultB.receipt.receiptNumber);
    expect(resultA.receipt.studentPaymentId).toBe(paymentAId);
    expect(resultB.receipt.studentPaymentId).toBe(paymentBId);

    const fetched = await getReceipt(context, resultA.receipt.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) expect(fetched.receipt.receiptNumber).toBe(resultA.receipt.receiptNumber);
  });

  it("refuses a second receipt for the same payment with code 'conflict' (one-receipt-per-payment)", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    const first = await issueReceipt(context, paymentId);
    expect(first.ok).toBe(true);

    const second = await issueReceipt(context, paymentId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });

  it("rejects a cross-academy payment id with code 'not_found'", async () => {
    const other = await setupAcademy("manager");
    const otherPaymentId = await insertPaymentDirect(
      other.academyId,
      other.studentId,
      other.creatorUserId,
      "approved",
    );

    const { context } = await setupAcademy("manager");
    const result = await issueReceipt(context, otherPaymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent payment id with code 'not_found'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await issueReceipt(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("receipts — DB-level constraints", () => {
  it("enforces uniqueness of (academy_id, receipt_number)", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    const paymentAId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");
    const paymentBId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    await db.insert(receipts).values({
      academyId,
      studentPaymentId: paymentAId,
      receiptNumber: "RCT-DUPE",
      issuedAt: new Date(),
      issuedBy: creatorUserId,
    });

    await expect(
      db.insert(receipts).values({
        academyId,
        studentPaymentId: paymentBId,
        receiptNumber: "RCT-DUPE",
        issuedAt: new Date(),
        issuedBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });

  it("enforces uniqueness of student_payment_id (one receipt per payment) at the DB level", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    await db.insert(receipts).values({
      academyId,
      studentPaymentId: paymentId,
      receiptNumber: "RCT-A",
      issuedAt: new Date(),
      issuedBy: creatorUserId,
    });

    await expect(
      db.insert(receipts).values({
        academyId,
        studentPaymentId: paymentId,
        receiptNumber: "RCT-B",
        issuedAt: new Date(),
        issuedBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent student_payment_id is rejected", async () => {
    const { academyId, creatorUserId } = await setupAcademy("manager");
    await expect(
      db.insert(receipts).values({
        academyId,
        studentPaymentId: randomUUID(),
        receiptNumber: "RCT-ORPHAN",
        issuedAt: new Date(),
        issuedBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });
});

describe("student_charges / student_payments — amount_cents >= 0 CHECK constraint (direct DB-level enforcement)", () => {
  it("rejects a negative amount_cents on student_charges", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    await expect(
      db.insert(studentCharges).values({
        academyId,
        studentId,
        description: "Invalid",
        amountCents: -100,
        currency: "USD",
        createdBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a negative amount_cents on student_payments", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    await expect(
      db.insert(studentPayments).values({
        academyId,
        studentId,
        amountCents: -100,
        currency: "USD",
        method: "cash",
        receivedAt: new Date(),
        recordedBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent student_id is rejected on student_charges", async () => {
    const { academyId, creatorUserId } = await setupAcademy("manager");
    await expect(
      db.insert(studentCharges).values({
        academyId,
        studentId: randomUUID(),
        description: "Orphan",
        amountCents: 100,
        currency: "USD",
        createdBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent academy_id is rejected on student_payments", async () => {
    const { studentId, creatorUserId } = await setupAcademy("manager");
    await expect(
      db.insert(studentPayments).values({
        academyId: randomUUID(),
        studentId,
        amountCents: 100,
        currency: "USD",
        method: "cash",
        receivedAt: new Date(),
        recordedBy: creatorUserId,
      }),
    ).rejects.toThrow();
  });
});

describe("listStudentCharges / listStudentPayments — tenant isolation", () => {
  it("never returns another academy's charges or payments", async () => {
    const other = await setupAcademy("manager");
    await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId);
    await insertPaymentDirect(other.academyId, other.studentId, other.creatorUserId);

    const { context } = await setupAcademy("manager");
    const charges = await listStudentCharges(context);
    const payments = await listStudentPayments(context);
    expect(charges.ok).toBe(true);
    expect(payments.ok).toBe(true);
    if (charges.ok) expect(charges.charges).toEqual([]);
    if (payments.ok) expect(payments.payments).toEqual([]);
  });

  it("view-only roles (Owner/Admin/Trainer) can list but canManage is false", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    await insertChargeDirect(academyId, studentId, creatorUserId);
    const viewer = await addActingUser(academyId, "academy_owner");

    const result = await listStudentCharges(viewer.context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.charges).toHaveLength(1);
      expect(result.canManage).toBe(false);
    }
  });

  it("admissions_officer (no permission row entry) is forbidden from listing entirely", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await listStudentCharges(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
