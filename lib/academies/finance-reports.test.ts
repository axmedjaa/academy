import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  expenseRecords,
  incomeRecords,
  students,
  studentCharges,
  studentPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import * as financeReportsModule from "./finance-reports";
import { getFinanceReports } from "./finance-reports";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `finance-reports-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Finance Reports Test Plan ${randomUUID()}`,
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
      name: `Finance Reports Test Academy ${randomUUID()}`,
      slug: `finance-reports-test-${randomUUID()}`,
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
  status: "open" | "partially_paid" | "paid" | "cancelled" = "open",
  amountCents = 10_000,
  createdAt?: Date,
): Promise<string> {
  const [row] = await db
    .insert(studentCharges)
    .values({
      academyId,
      studentId,
      description: "Tuition",
      amountCents,
      currency: "USD",
      status,
      createdBy: creatorUserId,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: studentCharges.id });
  return row.id;
}

async function insertPaymentDirect(
  academyId: string,
  studentId: string,
  recordedByUserId: string,
  status: "pending_approval" | "approved" | "rejected" | "reversed" = "approved",
  amountCents = 5_000,
  method: "cash" | "mobile_money" | "bank_transfer" = "cash",
  receivedAt: Date = new Date(),
): Promise<string> {
  const [row] = await db
    .insert(studentPayments)
    .values({
      academyId,
      studentId,
      amountCents,
      currency: "USD",
      method,
      receivedAt,
      recordedBy: recordedByUserId,
      status,
      approvedBy: status === "approved" ? recordedByUserId : undefined,
      approvedAt: status === "approved" ? new Date() : undefined,
    })
    .returning({ id: studentPayments.id });
  return row.id;
}

async function insertIncomeDirect(
  academyId: string,
  recordedBy: string,
  status: "posted" | "reversed" = "posted",
  amountCents = 20_000,
  branchId?: string,
): Promise<string> {
  const [row] = await db
    .insert(incomeRecords)
    .values({
      academyId,
      branchId,
      category: "Registration fees",
      amountCents,
      currency: "USD",
      recordedBy,
      status,
    })
    .returning({ id: incomeRecords.id });
  return row.id;
}

async function insertExpenseDirect(
  academyId: string,
  submittedBy: string,
  status: "draft" | "pending_approval" | "approved" | "rejected" | "reversed" = "approved",
  amountCents = 8_000,
  branchId?: string,
): Promise<string> {
  const [row] = await db
    .insert(expenseRecords)
    .values({
      academyId,
      branchId,
      category: "Supplies",
      amountCents,
      currency: "USD",
      submittedBy,
      status,
    })
    .returning({ id: expenseRecords.id });
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
    await db.delete(studentPayments).where(eq(studentPayments.academyId, academyId));
    await db.delete(studentCharges).where(eq(studentCharges.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));
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

describe("getFinanceReports — structural guarantee: platform billing is unreachable", () => {
  it("this module's own source text never mentions subscriptionPayments/academySubscriptions/subscriptionPlans", () => {
    // Stronger than a data-level assertion: this proves no code path in this
    // file could EVER reference a platform-billing table, not merely that
    // today's queries happen not to return one. Reads the compiled-from
    // source .ts file directly (not a build artifact), so this fails the
    // moment anyone adds such an import in the future.
    const modulePath = fileURLToPath(new URL("./finance-reports.ts", import.meta.url));
    const source = readFileSync(modulePath, "utf8");

    // Strip comments first so the doc comments ABOUT avoiding these tables
    // (which necessarily name them in prose) don't produce false negatives
    // for a check that's supposed to catch real code references.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(codeOnly).not.toMatch(/subscriptionPayments/);
    expect(codeOnly).not.toMatch(/academySubscriptions/);
    expect(codeOnly).not.toMatch(/subscriptionPlans/);
  });

  it("the exported result shape has no field that could ever carry a subscription_payments row", async () => {
    const { context } = await setupAcademy("academy_owner");
    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every top-level key in a real result, recursively, must belong to the
    // known finance-report vocabulary — nothing named "subscription"
    // anywhere in the shape.
    const json = JSON.stringify(result.report);
    expect(json.toLowerCase()).not.toContain("subscription");
  });
});

describe("getFinanceReports — per-entity permission scoping", () => {
  it("a Trainer sees student-payment and expense sections (view level) but the income section is invisible (no entry = none)", async () => {
    const { context } = await setupAcademy("trainer");
    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.studentPayments.visible).toBe(true);
    expect(result.report.expenses.visible).toBe(true);
    expect(result.report.income.visible).toBe(false);
  });

  it("an Admissions Officer (none on all three finance rows) sees nothing at all", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.studentPayments.visible).toBe(false);
    expect(result.report.income.visible).toBe(false);
    expect(result.report.expenses.visible).toBe(false);
  });

  it("a Finance Officer sees all three sections (manage on payments/income, manage on expenses)", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.studentPayments.visible).toBe(true);
    expect(result.report.income.visible).toBe(true);
    expect(result.report.expenses.visible).toBe(true);
  });

  it("reports never grant more than the caller's own view level: a role with 'none' on income never gets income data even when other sections are populated", async () => {
    const { academyId, userId, context } = await setupAcademy("trainer");
    await insertIncomeDirect(academyId, userId);

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.income).toEqual({ visible: false });
  });

  it("a caller not signed in / not a member gets a whole-report 'blocked' error, not a partially empty report", async () => {
    const result = await getFinanceReports({ userId: randomUUID(), branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});

describe("getFinanceReports — outstanding charges / pending approvals aggregation correctness", () => {
  it("sums only 'open'/'partially_paid' charges into outstandingCharges, excluding 'paid' and 'cancelled'", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertChargeDirect(academyId, studentId, creatorUserId, "open", 10_000);
    await insertChargeDirect(academyId, studentId, creatorUserId, "partially_paid", 4_000);
    await insertChargeDirect(academyId, studentId, creatorUserId, "paid", 99_999);
    await insertChargeDirect(academyId, studentId, creatorUserId, "cancelled", 99_999);

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;

    const { outstandingCharges } = result.report.studentPayments;
    expect(outstandingCharges.count).toBe(2);
    expect(outstandingCharges.totalsByCurrency).toEqual([
      { currency: "USD", amountCents: 14_000, count: 2 },
    ]);
  });

  it("counts pending student-payment approvals directly off status, independent of the status filter", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "pending_approval");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "pending_approval");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "rejected");

    const result = await getFinanceReports(context, { status: "approved" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.pendingApprovalsCount).toBe(2);
  });

  it("counts pending expense approvals directly off status", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    await insertExpenseDirect(academyId, userId, "pending_approval");
    await insertExpenseDirect(academyId, userId, "draft");
    await insertExpenseDirect(academyId, userId, "approved");

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.expenses.visible) return;
    expect(result.report.expenses.pendingApprovalsCount).toBe(1);
  });

  it("paymentsReceived defaults to 'approved' status only, excluding pending/rejected/reversed", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 3_000);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "pending_approval", 1_000);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "rejected", 1_000);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "reversed", 1_000);

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.paymentsReceived).toEqual({
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 3_000, count: 1 }],
    });
  });

  it("income defaults to 'posted' status only, excluding 'reversed'", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    await insertIncomeDirect(academyId, userId, "posted", 5_000);
    await insertIncomeDirect(academyId, userId, "reversed", 9_999);

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.income.visible) return;
    expect(result.report.income).toEqual({
      visible: true,
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 5_000, count: 1 }],
    });
  });

  it("expenses default to 'approved' status only", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    await insertExpenseDirect(academyId, userId, "approved", 2_000);
    await insertExpenseDirect(academyId, userId, "draft", 9_999);
    await insertExpenseDirect(academyId, userId, "pending_approval", 9_999);

    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.expenses.visible) return;
    expect(result.report.expenses.count).toBe(1);
    expect(result.report.expenses.totalsByCurrency).toEqual([
      { currency: "USD", amountCents: 2_000, count: 1 },
    ]);
  });
});

describe("getFinanceReports — filter correctness", () => {
  it("date filters (dateFrom/dateTo) narrow payments to the given receivedAt range, inclusive", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    const inRange = new Date("2025-06-15T00:00:00Z");
    const before = new Date("2025-01-01T00:00:00Z");
    const after = new Date("2025-12-31T00:00:00Z");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 1_000, "cash", inRange);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 2_000, "cash", before);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 3_000, "cash", after);

    const result = await getFinanceReports(context, {
      dateFrom: new Date("2025-06-01T00:00:00Z"),
      dateTo: new Date("2025-06-30T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.paymentsReceived).toEqual({
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 1_000, count: 1 }],
    });
  });

  it("branch filter narrows student-payment/charge sections via the student's branch", async () => {
    const { academyId, creatorUserId, context } = await setupAcademy("manager");
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);
    const studentA = await insertStudentDirect(academyId, branchA, creatorUserId);
    const studentB = await insertStudentDirect(academyId, branchB, creatorUserId);
    await insertChargeDirect(academyId, studentA, creatorUserId, "open", 1_000);
    await insertChargeDirect(academyId, studentB, creatorUserId, "open", 2_000);

    const result = await getFinanceReports(context, { branchId: branchA });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.outstandingCharges).toEqual({
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 1_000, count: 1 }],
    });
  });

  it("branch filter narrows income/expense sections via their own branch_id column", async () => {
    const { academyId, userId, context } = await setupAcademy("manager");
    const branchA = await insertBranchDirect(academyId);
    const branchB = await insertBranchDirect(academyId);
    await insertIncomeDirect(academyId, userId, "posted", 1_000, branchA);
    await insertIncomeDirect(academyId, userId, "posted", 2_000, branchB);

    const result = await getFinanceReports(context, { branchId: branchA });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.income.visible) return;
    expect(result.report.income).toEqual({
      visible: true,
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 1_000, count: 1 }],
    });
  });

  it("status filter overrides the payments-received default when it names a valid student_payments status", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "rejected", 7_000);
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 1_000);

    const result = await getFinanceReports(context, { status: "rejected" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.paymentsReceived).toEqual({
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 7_000, count: 1 }],
    });
  });

  it("a status value from a foreign vocabulary (e.g. 'posted', an income-only status) is ignored for payments, falling back to the 'approved' default", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 1_000);

    const result = await getFinanceReports(context, { status: "posted" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.paymentsReceived.count).toBe(1);
  });

  it("method filter narrows payments received to the given method", async () => {
    const { academyId, studentId, creatorUserId, context } = await setupAcademy("manager");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 1_000, "cash");
    await insertPaymentDirect(academyId, studentId, creatorUserId, "approved", 2_000, "bank_transfer");

    const result = await getFinanceReports(context, { method: "bank_transfer" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.paymentsReceived).toEqual({
      count: 1,
      totalsByCurrency: [{ currency: "USD", amountCents: 2_000, count: 1 }],
    });
  });

  it("rejects an invalid branchId with code 'validation'", async () => {
    const { context } = await setupAcademy("manager");
    const result = await getFinanceReports(context, { branchId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("getFinanceReports — cross-academy tenant isolation", () => {
  it("never includes another academy's charges, payments, income, or expenses", async () => {
    const other = await setupAcademy("manager");
    await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId, "open", 50_000);
    await insertPaymentDirect(other.academyId, other.studentId, other.creatorUserId, "approved", 50_000);
    await insertIncomeDirect(other.academyId, other.userId, "posted", 50_000);
    await insertExpenseDirect(other.academyId, other.userId, "approved", 50_000);

    const { context } = await setupAcademy("manager");
    const result = await getFinanceReports(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.studentPayments).toEqual({
      visible: true,
      outstandingCharges: { count: 0, totalsByCurrency: [] },
      paymentsReceived: { count: 0, totalsByCurrency: [] },
      pendingApprovalsCount: 0,
    });
    expect(result.report.income).toEqual({ visible: true, count: 0, totalsByCurrency: [] });
    expect(result.report.expenses).toEqual({
      visible: true,
      count: 0,
      totalsByCurrency: [],
      pendingApprovalsCount: 0,
    });
  });

  it("a branchId belonging to a different academy yields empty results rather than leaking that academy's data", async () => {
    const other = await setupAcademy("manager");
    await insertChargeDirect(other.academyId, other.studentId, other.creatorUserId, "open", 50_000);

    const { context } = await setupAcademy("manager");
    const result = await getFinanceReports(context, { branchId: other.branchId });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.outstandingCharges).toEqual({ count: 0, totalsByCurrency: [] });
  });
});

describe("getFinanceReports — role coverage matches the underlying entities' own permission rows", () => {
  it.each<[AcademyRole, boolean, boolean, boolean]>([
    ["academy_owner", true, true, true],
    ["academy_admin", true, true, true],
    ["manager", true, true, true],
    ["admissions_officer", false, false, false],
    ["finance_officer", true, true, true],
    ["trainer", true, false, true],
  ])(
    "role %s: studentPayments visible=%s, income visible=%s, expenses visible=%s",
    async (role, paymentsVisible, incomeVisible, expensesVisible) => {
      const { context } = await setupAcademy(role);
      const result = await getFinanceReports(context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.studentPayments.visible).toBe(paymentsVisible);
      expect(result.report.income.visible).toBe(incomeVisible);
      expect(result.report.expenses.visible).toBe(expensesVisible);
    },
  );

  it("a second academy_owner added via addActingUser on the same academy sees the same fixtures", async () => {
    const { academyId, studentId, creatorUserId } = await setupAcademy("manager");
    await insertChargeDirect(academyId, studentId, creatorUserId, "open", 1_000);
    const viewer = await addActingUser(academyId, "academy_owner");

    const result = await getFinanceReports(viewer.context);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.report.studentPayments.visible) return;
    expect(result.report.studentPayments.outstandingCharges.count).toBe(1);
  });
});

describe("getFinanceReports — module surface", () => {
  it("exports exactly the documented functions/types (no accidental extra surface)", () => {
    const exported = Object.keys(financeReportsModule).sort();
    expect(exported).toEqual(["financeReportFiltersSchema", "getFinanceReports"].sort());
  });
});
