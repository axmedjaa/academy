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
  notifications,
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
  createStudentCharge,
  getReceipt,
  issueReceipt,
  listStudentCharges,
  listStudentPayments,
  recordStudentPayment,
  type CreateStudentChargeInput,
  type RecordStudentPaymentInput,
} from "./student-payments";
import { reverseStudentPayment } from "./finance-reversals";

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

/** Counts `approval_requests` rows for a given student payment — used to
 * confirm `recordStudentPayment` never creates one anymore (no approval
 * workflow for student payments). */
async function countApprovalRequestsForPayment(studentPaymentId: string): Promise<number> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.entityType, "student_payment"),
        eq(approvalRequests.entityId, studentPaymentId),
      ),
    );
  return rows.length;
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
    await db
      .delete(notifications)
      .where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
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
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])(
    "role %s: create allowed = %s (Owner/Trainer are view-only; Admin was raised to manage-level per the manual student-payment verification report)",
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
    ["academy_admin", true],
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

  it("always creates with status 'approved' immediately, approvedBy/approvedAt set to the recorder — no approval workflow", async () => {
    const { studentId, userId, context } = await setupAcademy("finance_officer");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.status).toBe("approved");
    expect(result.payment.approvedBy).toBe(userId);
    expect(result.payment.approvedAt).not.toBeNull();
  });

  it("creates no approval_requests row at all (student payments no longer use the shared approval workflow)", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await countApprovalRequestsForPayment(result.payment.id)).toBe(0);
  });

  it("Finance Officer's payment is immediately effective — no Manager approval needed (fixes the previous asymmetry where Finance Officer could record but never get approved)", async () => {
    const { studentId, context } = await setupAcademy("finance_officer");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.status).toBe("approved");

    // Immediately eligible for a receipt — no waiting on anyone else.
    const receipt = await issueReceipt(context, result.payment.id);
    expect(receipt.ok).toBe(true);
  });

  it("Manager's payment is immediately effective — no separate approval step, no approving their own work", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payment.status).toBe("approved");
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

  it("persists an optional notes field, distinct from reference", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const result = await recordStudentPayment(
      context,
      validPayment(studentId, { reference: "MM-84920", notes: "Second installment" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.reference).toBe("MM-84920");
    expect(result.payment.notes).toBe("Second installment");

    const [row] = await db.select().from(studentPayments).where(eq(studentPayments.id, result.payment.id));
    expect(row.notes).toBe("Second installment");
    expect(row.reference).toBe("MM-84920");
  });

  it("leaves notes null when omitted (never required)", async () => {
    const { studentId, context } = await setupAcademy("manager");
    const result = await recordStudentPayment(context, validPayment(studentId));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payment.notes).toBeNull();
  });

});

describe("recordStudentPayment — linked student_charge status recalculation (immediately effective, no separate approval step)", () => {
  it("1. a charge payment with no previous payments -> partially_paid, immediately", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");
  });

  it("2. a payment that brings the paid total to/above the charge amount -> paid, immediately", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(result.ok).toBe(true);

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

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");
  });

  it("3. multiple payments on the same charge accumulate to the correct cumulative status, each immediately", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    await recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 3_000 }));
    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");

    await recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 4_000 }));
    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid"); // 3,000 + 4,000 = 7,000 < 10,000

    await recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 3_000 }));
    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid"); // 3,000 + 4,000 + 3,000 = 10,000
  });

  it("4. a reversed payment stops counting toward the charge's paid total (the correction mechanism, since there's no reject step anymore)", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    const mistaken = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(mistaken.ok).toBe(true);
    if (!mistaken.ok) return;

    let [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid");

    // Correcting a wrongly-recorded payment uses reversal (Manager-only,
    // never the recorder themselves) — not a reject step, which no longer
    // exists for student payments.
    const reverser = await addActingUser(recorder.academyId, "manager");
    const reversed = await reverseStudentPayment(reverser.context, mistaken.payment.id, "Recorded in error.");
    expect(reversed.ok).toBe(true);

    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("open");

    // Now record a correct, smaller payment — only THIS amount should count.
    await recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 2_000 }));
    [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("partially_paid");
  });

  it("5. concurrent payments on the same charge cannot produce an incorrect cumulative status (charge row lock serializes them)", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);

    const [first, second] = await Promise.all([
      recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 4_000 })),
      recordStudentPayment(recorder.context, validPayment(recorder.studentId, { chargeId, amountCents: 6_000 })),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Both payments' amounts must be reflected exactly once each — never
    // lost (a race that overwrites rather than accumulates) and never
    // double-counted.
    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("paid"); // 4,000 + 6,000 = 10,000, exactly the charge amount
  });

  it("6. cross-academy/IDOR protection is unaffected by the recalculation change", async () => {
    const other = await setupAcademy("manager");
    const otherChargeId = await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId, 10_000);

    const { context } = await setupAcademy("manager");
    const result = await recordStudentPayment(
      context,
      validPayment(other.studentId, { chargeId: otherChargeId, amountCents: 5_000 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    // The other academy's charge must be completely untouched by the
    // refused cross-academy attempt.
    const [otherCharge] = await db.select().from(studentCharges).where(eq(studentCharges.id, otherChargeId));
    expect(otherCharge.status).toBe("open");
  });

  it("a payment with no linked charge (chargeId null) records normally with no recalculation attempted", async () => {
    const recorder = await setupAcademy("manager");
    const result = await recordStudentPayment(recorder.context, validPayment(recorder.studentId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.chargeId).toBeNull();
    expect(result.payment.status).toBe("approved");
  });

  it("a charge already 'cancelled' is left untouched by a later payment (judgment call — terminal state)", async () => {
    const recorder = await setupAcademy("manager");
    const chargeId = await insertChargeDirect(recorder.academyId, recorder.studentId, recorder.creatorUserId, 10_000);
    await db.update(studentCharges).set({ status: "cancelled" }).where(eq(studentCharges.id, chargeId));

    const result = await recordStudentPayment(
      recorder.context,
      validPayment(recorder.studentId, { chargeId, amountCents: 10_000 }),
    );
    expect(result.ok).toBe(true);

    const [charge] = await db.select().from(studentCharges).where(eq(studentCharges.id, chargeId));
    expect(charge.status).toBe("cancelled");
  });
});

describe("issueReceipt", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
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

  // PLAN.md Phase 5, Item 58b — notification wiring.
  it("enqueues a 'payment.receipt_issued' notification targeted at the issuing actor, without affecting the business outcome", async () => {
    const { academyId, studentId, creatorUserId, userId, context } = await setupAcademy("manager");
    const paymentId = await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");

    const result = await issueReceipt(context, paymentId);
    expect(result.ok).toBe(true); // No regression from adding the enqueue call.
    if (!result.ok) return;

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.idempotencyKey, `payment.receipt_issued:${result.receipt.id}`));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.eventType).toBe("payment.receipt_issued");
      expect(row.templateId).toBe("payment.receipt_issued");
      expect(row.academyId).toBe(academyId);
      // Recipient: the issuing actor — students have no user_id/login.
      expect(row.userId).toBe(userId);
    }
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
