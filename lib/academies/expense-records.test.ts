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
  expenseRecords,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  approveExpense,
  createExpenseRecord,
  listExpenseRecords,
  rejectExpense,
  submitExpenseForApproval,
  type CreateExpenseRecordInput,
} from "./expense-records";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `expense-records-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Expense Records Test Plan ${randomUUID()}`,
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
      name: `Expense Records Test Academy ${randomUUID()}`,
      slug: `expense-records-test-${randomUUID()}`,
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

async function setupAcademy(
  role: AcademyRole,
  defaultCurrency = "USD",
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
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

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return { academyId, userId, context: { userId, branchIds: [], academyWide: false } };
}

async function addActingUser(
  academyId: string,
  role: AcademyRole,
): Promise<{ userId: string; context: AuthContext }> {
  const userId = await createUser();
  await addMembership(userId, academyId, role);
  return { userId, context: { userId, branchIds: [], academyWide: false } };
}

async function insertExpenseDirect(
  academyId: string,
  submittedBy: string,
  status: "draft" | "pending_approval" | "approved" | "rejected" | "reversed" = "draft",
  amountCents = 20_000,
): Promise<string> {
  const [row] = await db
    .insert(expenseRecords)
    .values({
      academyId,
      category: "Supplies",
      amountCents,
      currency: "USD",
      submittedBy,
      status,
    })
    .returning({ id: expenseRecords.id });
  return row.id;
}

async function insertApprovalRequestDirect(
  academyId: string,
  entityId: string,
  requestedBy: string,
): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({ academyId, entityType: "expense", entityId, requestedBy })
    .returning({ id: approvalRequests.id });
  return row.id;
}

async function fetchApprovalRequestForExpense(expenseRecordId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.entityType, "expense"), eq(approvalRequests.entityId, expenseRecordId)));
  return row;
}

function validInput(overrides: Partial<CreateExpenseRecordInput> = {}): CreateExpenseRecordInput {
  return {
    category: "Office supplies",
    amountCents: 12_000,
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
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));
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

describe("createExpenseRecord — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", false],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])(
    "role %s: create allowed = %s (per the matrix's Create/Submit cell — Admin/Manager only ever approve, they don't create)",
    async (role, allowed) => {
      const { context } = await setupAcademy(role);
      const result = await createExpenseRecord(context, validInput());
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("creates in 'draft' status, writes an audit row, and resolves currency from the academy default", async () => {
    const { academyId, userId, context } = await setupAcademy("finance_officer", "GBP");
    const result = await createExpenseRecord(context, validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("draft");
    expect(result.record.submittedBy).toBe(userId);
    expect(result.record.currency).toBe("GBP");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.record.id));
    expect(audit?.action).toBe("createExpenseRecord");
    expect(audit?.academyId).toBe(academyId);
    expect(audit?.after).toBeTruthy();
  });

  it("rejects a negative amountCents at the application layer with code 'validation'", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await createExpenseRecord(context, validInput({ amountCents: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("submitExpenseForApproval — draft -> pending_approval", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", false],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])("role %s: submit allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    const actor = await addActingUser(owner.academyId, role);

    const result = await submitExpenseForApproval(actor.context, expenseId);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("flips status to pending_approval and creates a matching pending approval_requests row", async () => {
    const { academyId, userId, context } = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(academyId, userId, "draft");

    const result = await submitExpenseForApproval(context, expenseId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("pending_approval");

    const request = await fetchApprovalRequestForExpense(expenseId);
    expect(request?.status).toBe("pending");
    expect(request?.requestedBy).toBe(userId);
    expect(request?.academyId).toBe(academyId);
  });

  it("refuses to submit a non-draft expense with code 'invalid_state'", async () => {
    const { academyId, userId, context } = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(academyId, userId, "pending_approval");

    const result = await submitExpenseForApproval(context, expenseId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a cross-academy expense id with code 'not_found'", async () => {
    const other = await setupAcademy("finance_officer");
    const otherExpenseId = await insertExpenseDirect(other.academyId, other.userId, "draft");

    const { context } = await setupAcademy("finance_officer");
    const result = await submitExpenseForApproval(context, otherExpenseId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a nonexistent expense id with code 'not_found'", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await submitExpenseForApproval(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("approveExpense — pending_approval -> approved (authority: Admin/Manager only)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])(
    "role %s: approve allowed = %s (Owner is View-only and Finance Officer is Create/Submit-only on this row)",
    async (role, allowed) => {
      const owner = await setupAcademy("finance_officer");
      const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
      const submitResult = await submitExpenseForApproval(owner.context, expenseId);
      expect(submitResult.ok).toBe(true);

      const approver = await addActingUser(owner.academyId, role);
      const result = await approveExpense(approver.context, expenseId);
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

  it("approves: status -> approved, approved_by/approved_at set, approval_requests row decided, audit before/after recorded", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    await submitExpenseForApproval(owner.context, expenseId);

    const admin = await addActingUser(owner.academyId, "academy_admin");
    const result = await approveExpense(admin.context, expenseId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("approved");
    expect(result.record.approvedBy).toBe(admin.userId);
    expect(result.record.approvedAt).not.toBeNull();

    const request = await fetchApprovalRequestForExpense(expenseId);
    expect(request?.status).toBe("approved");
    expect(request?.decidedBy).toBe(admin.userId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, expenseId), eq(auditLogs.action, "approveExpense")));
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("refuses to approve an expense that was never submitted (still 'draft') with code 'invalid_state'", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    const admin = await addActingUser(owner.academyId, "academy_admin");

    const result = await approveExpense(admin.context, expenseId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("refuses to approve an already-approved expense with code 'invalid_state'", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    await submitExpenseForApproval(owner.context, expenseId);
    const admin = await addActingUser(owner.academyId, "academy_admin");
    await approveExpense(admin.context, expenseId);

    const result = await approveExpense(admin.context, expenseId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  it("rejects a nonexistent expense id with code 'not_found'", async () => {
    const { context } = await setupAcademy("academy_admin");
    const result = await approveExpense(context, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a cross-academy expense id with code 'not_found'", async () => {
    const other = await setupAcademy("finance_officer");
    const otherExpenseId = await insertExpenseDirect(other.academyId, other.userId, "draft");
    await submitExpenseForApproval(other.context, otherExpenseId);

    const { context } = await setupAcademy("academy_admin");
    const result = await approveExpense(context, otherExpenseId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it(
    "self-approval is refused via decideApprovalRequest's own guard — proven directly by manufacturing a pending " +
      "approval_requests row 'requestedBy' the same Admin/Manager user who then attempts to decide it (structurally, " +
      "a Finance Officer submitter can never simultaneously hold Admin/Manager's approve level, so this fixture " +
      "isolates and exercises the guard itself rather than a permission-level refusal)",
    async () => {
      const owner = await setupAcademy("finance_officer");
      const admin = await addActingUser(owner.academyId, "academy_admin");
      const expenseId = await insertExpenseDirect(owner.academyId, admin.userId, "pending_approval");
      await insertApprovalRequestDirect(owner.academyId, expenseId, admin.userId);

      const result = await approveExpense(admin.context, expenseId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("self_approval");

      // A different Admin/Manager can still approve it.
      const otherAdmin = await addActingUser(owner.academyId, "manager");
      const approved = await approveExpense(otherAdmin.context, expenseId);
      expect(approved.ok).toBe(true);
    },
  );
});

describe("rejectExpense — pending_approval -> rejected (same authority as approve)", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])("role %s: reject allowed = %s", async (role, allowed) => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    await submitExpenseForApproval(owner.context, expenseId);

    const decider = await addActingUser(owner.academyId, role);
    const result = await rejectExpense(decider.context, expenseId, "Missing receipts.");
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason with code 'validation'", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    await submitExpenseForApproval(owner.context, expenseId);
    const manager = await addActingUser(owner.academyId, "manager");

    const result = await rejectExpense(manager.context, expenseId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects: status -> rejected, rejection_reason persisted on both the expense row and the approval_requests row", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    await submitExpenseForApproval(owner.context, expenseId);

    const manager = await addActingUser(owner.academyId, "manager");
    const result = await rejectExpense(manager.context, expenseId, "Duplicate expense.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("rejected");
    expect(result.record.rejectionReason).toBe("Duplicate expense.");

    const request = await fetchApprovalRequestForExpense(expenseId);
    expect(request?.status).toBe("rejected");
    expect(request?.reason).toBe("Duplicate expense.");
  });

  it("refuses self-rejection via decideApprovalRequest's guard, same fixture technique as the self-approval test", async () => {
    const owner = await setupAcademy("finance_officer");
    const manager = await addActingUser(owner.academyId, "manager");
    const expenseId = await insertExpenseDirect(owner.academyId, manager.userId, "pending_approval");
    await insertApprovalRequestDirect(owner.academyId, expenseId, manager.userId);

    const result = await rejectExpense(manager.context, expenseId, "Changed my mind.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("self_approval");
  });

  it("refuses to reject an expense that isn't pending approval with code 'invalid_state'", async () => {
    const owner = await setupAcademy("finance_officer");
    const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
    const admin = await addActingUser(owner.academyId, "academy_admin");

    const result = await rejectExpense(admin.context, expenseId, "Not applicable.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });
});

describe("expense_records — DB-level constraints", () => {
  it("rejects a negative amount_cents via the CHECK constraint", async () => {
    const { academyId, userId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(expenseRecords).values({
        academyId,
        category: "Invalid",
        amountCents: -100,
        currency: "USD",
        submittedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent academy_id is rejected", async () => {
    const { userId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(expenseRecords).values({
        academyId: randomUUID(),
        category: "Orphan",
        amountCents: 100,
        currency: "USD",
        submittedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent submitted_by is rejected", async () => {
    const { academyId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(expenseRecords).values({
        academyId,
        category: "Orphan",
        amountCents: 100,
        currency: "USD",
        submittedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("listExpenseRecords — tenant isolation", () => {
  it("never returns another academy's expense records", async () => {
    const other = await setupAcademy("finance_officer");
    await insertExpenseDirect(other.academyId, other.userId);

    const { context } = await setupAcademy("finance_officer");
    const result = await listExpenseRecords(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toEqual([]);
  });

  it("view-only Owner/Trainer can list but neither canCreate nor canApprove", async () => {
    const financeOfficer = await setupAcademy("finance_officer");
    await insertExpenseDirect(financeOfficer.academyId, financeOfficer.userId);
    const owner = await addActingUser(financeOfficer.academyId, "academy_owner");

    const result = await listExpenseRecords(owner.context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.canCreate).toBe(false);
      expect(result.canApprove).toBe(false);
    }
  });

  it("admissions_officer (no permission row entry) is forbidden from listing entirely", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await listExpenseRecords(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
