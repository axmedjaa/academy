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
  notifications,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { dollarsToCents } from "@/lib/ui/money";
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

async function fetchApprovalRequestForExpense(expenseRecordId: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.entityType, "expense"), eq(approvalRequests.entityId, expenseRecordId)));
  return row;
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db
    .insert(branches)
    .values({
      academyId,
      name: `Branch ${randomUUID().slice(0, 8)}`,
      code: `BR-${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: branches.id });
  return row.id;
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
    // Item 58b: createApprovalRequest/decideApprovalRequest now enqueue a
    // notification row FK-referencing academies.id — must be cleared before
    // that table's own delete below.
    await db
      .delete(notifications)
      .where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(expenseRecords).where(eq(expenseRecords.academyId, academyId));
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

describe("createExpenseRecord — permission matrix", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])(
    "role %s: create allowed = %s (Owner/Admin/Manager/Finance Officer, per the approved architecture decision — Admissions Officer/Trainer still refused)",
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

  it("creates a record when branchId belongs to the caller's own academy", async () => {
    const { academyId, context } = await setupAcademy("finance_officer");
    const branchId = await insertBranchDirect(academyId);

    const result = await createExpenseRecord(context, validInput({ branchId }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.branchId).toBe(branchId);
  });

  it("rejects a branchId belonging to a DIFFERENT academy and creates no record", async () => {
    const { context } = await setupAcademy("finance_officer");
    const other = await setupAcademy("finance_officer");
    const otherAcademyBranch = await insertBranchDirect(other.academyId);

    const before = await db.select().from(expenseRecords);

    const result = await createExpenseRecord(context, validInput({ branchId: otherAcademyBranch }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    const after = await db.select().from(expenseRecords);
    expect(after).toHaveLength(before.length);
  });
});

describe("submitExpenseForApproval — draft -> pending_approval", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", true],
    ["academy_admin", true],
    ["manager", true],
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

describe("approveExpense — pending_approval -> approved", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])(
    "role %s: approving a DIFFERENT user's submission allowed = %s (GENERAL approve authority — Admin/Manager only; Owner/Finance Officer may still self-approve their OWN, tested separately below)",
    async (role, allowed) => {
      const owner = await setupAcademy("finance_officer");
      const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
      const submitResult = await submitExpenseForApproval(owner.context, expenseId);
      expect(submitResult.ok).toBe(true);

      // A DIFFERENT user of the target role — never the submitter — so a
      // "forbidden" result here is unambiguously about GENERAL approve
      // authority, never self-approval.
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

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager", "finance_officer"])(
    "%s self-approval is ALLOWED: creates -> submits -> approves their own expense immediately (approved architecture decision)",
    async (role) => {
      const { context, userId } = await setupAcademy(role);
      const created = await createExpenseRecord(context, validInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const submitted = await submitExpenseForApproval(context, created.record.id);
      expect(submitted.ok).toBe(true);

      const result = await approveExpense(context, created.record.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record.status).toBe("approved");
      expect(result.record.approvedBy).toBe(userId);

      const request = await fetchApprovalRequestForExpense(created.record.id);
      expect(request?.status).toBe("approved");
      expect(request?.decidedBy).toBe(userId);
    },
  );

  it("a self-approve-only role (Owner) still cannot approve a DIFFERENT Owner's submission — self-approval is scoped to their own record, not unrestricted authority", async () => {
    const submitterAcademy = await setupAcademy("academy_owner");
    const created = await createExpenseRecord(submitterAcademy.context, validInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const submitted = await submitExpenseForApproval(submitterAcademy.context, created.record.id);
    expect(submitted.ok).toBe(true);

    // A DIFFERENT Owner in the SAME academy — self-approve-eligible as a
    // role, but this isn't their own submission, and Owner holds no
    // GENERAL approve authority.
    const otherOwner = await addActingUser(submitterAcademy.academyId, "academy_owner");
    const result = await approveExpense(otherOwner.context, created.record.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("a real pending expense id belonging to a DIFFERENT academy is rejected as not_found — never approved, even for a same-role self-approve attempt (tenant isolation)", async () => {
    const other = await setupAcademy("finance_officer");
    const otherCreated = await createExpenseRecord(other.context, validInput());
    expect(otherCreated.ok).toBe(true);
    if (!otherCreated.ok) return;
    const otherSubmitted = await submitExpenseForApproval(other.context, otherCreated.record.id);
    expect(otherSubmitted.ok).toBe(true);

    // A same-role Finance Officer in a completely different academy — must
    // never be able to decide a different academy's expense, self-approve
    // path included.
    const attacker = await setupAcademy("finance_officer");
    const result = await approveExpense(attacker.context, otherCreated.record.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("rejectExpense — pending_approval -> rejected", () => {
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", true],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", false],
    ["trainer", false],
  ])(
    "role %s: rejecting a DIFFERENT user's submission allowed = %s (GENERAL approve authority — Admin/Manager only)",
    async (role, allowed) => {
      const owner = await setupAcademy("finance_officer");
      const expenseId = await insertExpenseDirect(owner.academyId, owner.userId, "draft");
      await submitExpenseForApproval(owner.context, expenseId);

      const decider = await addActingUser(owner.academyId, role);
      const result = await rejectExpense(decider.context, expenseId, "Missing receipts.");
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.error.code).toBe("forbidden");
    },
  );

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

  it.each<AcademyRole>(["academy_owner", "academy_admin", "manager", "finance_officer"])(
    "%s self-rejection is ALLOWED (same approved architecture change as self-approval)",
    async (role) => {
      const { context } = await setupAcademy(role);
      const created = await createExpenseRecord(context, validInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const submitted = await submitExpenseForApproval(context, created.record.id);
      expect(submitted.ok).toBe(true);

      const result = await rejectExpense(context, created.record.id, "Changed my mind.");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.status).toBe("rejected");
    },
  );

  it("a self-approve-only role (Finance Officer) still cannot reject a DIFFERENT Finance Officer's submission", async () => {
    const submitterAcademy = await setupAcademy("finance_officer");
    const created = await createExpenseRecord(submitterAcademy.context, validInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const submitted = await submitExpenseForApproval(submitterAcademy.context, created.record.id);
    expect(submitted.ok).toBe(true);

    const otherFinanceOfficer = await addActingUser(submitterAcademy.academyId, "finance_officer");
    const result = await rejectExpense(otherFinanceOfficer.context, created.record.id, "Not mine to decide.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
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

  it("Owner: can list, can create, canSelfApprove but NOT general canApprove (approved architecture decision)", async () => {
    const financeOfficer = await setupAcademy("finance_officer");
    await insertExpenseDirect(financeOfficer.academyId, financeOfficer.userId);
    const owner = await addActingUser(financeOfficer.academyId, "academy_owner");

    const result = await listExpenseRecords(owner.context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.canCreate).toBe(true);
      expect(result.canApprove).toBe(false);
      expect(result.canSelfApprove).toBe(true);
    }
  });

  it("Academy Administrator/Manager: canCreate, GENERAL canApprove, AND canSelfApprove all true", async () => {
    const { academyId } = await setupAcademy("finance_officer");
    for (const role of ["academy_admin", "manager"] as const) {
      const actor = await addActingUser(academyId, role);
      const result = await listExpenseRecords(actor.context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.canCreate).toBe(true);
        expect(result.canApprove).toBe(true);
        expect(result.canSelfApprove).toBe(true);
      }
    }
  });

  it("Finance Officer: canCreate, canSelfApprove, but NOT general canApprove", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await listExpenseRecords(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canCreate).toBe(true);
      expect(result.canApprove).toBe(false);
      expect(result.canSelfApprove).toBe(true);
    }
  });

  it("Trainer: view-only — canCreate, canApprove, AND canSelfApprove all false (Trainer is not in the self-approve role set)", async () => {
    const financeOfficer = await setupAcademy("finance_officer");
    const trainer = await addActingUser(financeOfficer.academyId, "trainer");

    const result = await listExpenseRecords(trainer.context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canCreate).toBe(false);
      expect(result.canApprove).toBe(false);
      expect(result.canSelfApprove).toBe(false);
    }
  });

  it("admissions_officer (no permission row entry) is forbidden from listing entirely", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await listExpenseRecords(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("money-input-system fix — expense amount entered in dollars", () => {
  it('an amount entered as "10.01" is stored as 1001 cents ($10.01), never 10 cents', async () => {
    const { context } = await setupAcademy("finance_officer");
    const entered = dollarsToCents("10.01");
    expect(entered).toBe(1001);
    const result = await createExpenseRecord(context, validInput({ amountCents: entered! }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.amountCents).toBe(1001);
  });
});
