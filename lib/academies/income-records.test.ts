import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  incomeRecords,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import * as incomeRecordsModule from "./income-records";
import { createIncomeRecord, listIncomeRecords, type CreateIncomeRecordInput } from "./income-records";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `income-records-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Income Records Test Plan ${randomUUID()}`,
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
      name: `Income Records Test Academy ${randomUUID()}`,
      slug: `income-records-test-${randomUUID()}`,
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

function validInput(overrides: Partial<CreateIncomeRecordInput> = {}): CreateIncomeRecordInput {
  return {
    category: "Registration fees",
    amountCents: 15_000,
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
  for (const academyId of createdAcademyIds) {
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
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

describe("createIncomeRecord — permission matrix", () => {
  // PLAN.md's Finance Lifecycle table: "posted directly by Manager or
  // Finance Officer" — corrected in Wave 2 from an earlier guess that gave
  // Manager view-only (see lib/auth/academy-permissions.ts's module
  // comment on ACADEMY_INCOME_ACTION).
  it.each<[AcademyRole, boolean]>([
    ["academy_owner", false],
    ["academy_admin", false],
    ["manager", true],
    ["admissions_officer", false],
    ["finance_officer", true],
    ["trainer", false],
  ])("role %s: create allowed = %s (Manager or Finance Officer)", async (role, allowed) => {
    const { context } = await setupAcademy(role);
    const result = await createIncomeRecord(context, validInput());
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("writes status 'posted' directly, writes an audit row, and resolves currency from the academy default", async () => {
    const { academyId, userId, context } = await setupAcademy("finance_officer", "GBP");
    const result = await createIncomeRecord(context, validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("posted");
    expect(result.record.recordedBy).toBe(userId);
    expect(result.record.currency).toBe("GBP");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.record.id));
    expect(audit?.action).toBe("createIncomeRecord");
    expect(audit?.academyId).toBe(academyId);
  });

  it("uses an explicitly supplied currency instead of the academy default", async () => {
    const { context } = await setupAcademy("finance_officer", "GBP");
    const result = await createIncomeRecord(context, validInput({ currency: "usd" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.currency).toBe("USD");
  });

  it("no pending_approval state is ever reachable — the schema's status enum has no such value, and this module exports no submit/approve/reject function to call", () => {
    // The (posted, reversed) enum has no intermediate status at all — there
    // is no code path in this module (or anywhere else) that could ever
    // produce a "pending_approval"-like income record. Confirmed at the
    // module-surface level: only createIncomeRecord/listIncomeRecords are
    // exported.
    const exported = Object.keys(incomeRecordsModule).sort();
    expect(exported).toEqual(
      [
        "createIncomeRecord",
        "createIncomeRecordSchema",
        "listIncomeRecords",
      ].sort(),
    );
    expect((incomeRecordsModule as Record<string, unknown>).submitIncomeForApproval).toBeUndefined();
    expect((incomeRecordsModule as Record<string, unknown>).approveIncome).toBeUndefined();
    expect((incomeRecordsModule as Record<string, unknown>).rejectIncome).toBeUndefined();
  });

  it("rejects a negative amountCents at the application layer with code 'validation'", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await createIncomeRecord(context, validInput({ amountCents: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an empty category with code 'validation'", async () => {
    const { context } = await setupAcademy("finance_officer");
    const result = await createIncomeRecord(context, validInput({ category: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("income_records — DB-level constraints", () => {
  it("rejects a negative amount_cents via the CHECK constraint", async () => {
    const { academyId, userId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(incomeRecords).values({
        academyId,
        category: "Invalid",
        amountCents: -500,
        currency: "USD",
        recordedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent academy_id is rejected", async () => {
    const { userId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(incomeRecords).values({
        academyId: randomUUID(),
        category: "Orphan",
        amountCents: 100,
        currency: "USD",
        recordedBy: userId,
      }),
    ).rejects.toThrow();
  });

  it("FK violation: a nonexistent recorded_by is rejected", async () => {
    const { academyId } = await setupAcademy("finance_officer");
    await expect(
      db.insert(incomeRecords).values({
        academyId,
        category: "Orphan",
        amountCents: 100,
        currency: "USD",
        recordedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("listIncomeRecords — tenant isolation", () => {
  it("never returns another academy's income records", async () => {
    const other = await setupAcademy("finance_officer");
    await createIncomeRecord(other.context, validInput());

    const { context } = await setupAcademy("finance_officer");
    const result = await listIncomeRecords(context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toEqual([]);
  });

  it("view-only roles (Owner/Admin) can list but canCreate is false", async () => {
    const financeOfficer = await setupAcademy("finance_officer");
    await createIncomeRecord(financeOfficer.context, validInput());

    const ownerUserId = await createUser();
    await addMembership(ownerUserId, financeOfficer.academyId, "academy_owner");
    const ownerContext: AuthContext = { userId: ownerUserId, branchIds: [], academyWide: false };

    const result = await listIncomeRecords(ownerContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.canCreate).toBe(false);
    }
  });

  // Manager reuses Finance Officer's "manage" level (see the permission
  // matrix test above) — canCreate must reflect that, unlike Owner/Admin.
  it("manager can list and canCreate is true", async () => {
    const financeOfficer = await setupAcademy("finance_officer");
    await createIncomeRecord(financeOfficer.context, validInput());

    const managerUserId = await createUser();
    await addMembership(managerUserId, financeOfficer.academyId, "manager");
    const managerContext: AuthContext = { userId: managerUserId, branchIds: [], academyWide: false };

    const result = await listIncomeRecords(managerContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.canCreate).toBe(true);
    }
  });

  it("admissions_officer (no permission row entry) is forbidden from listing entirely", async () => {
    const { context } = await setupAcademy("admissions_officer");
    const result = await listIncomeRecords(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});
