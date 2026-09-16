import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getAcademyAuditLogs } from "./audit-logs";

// Same "one top-level cleanup, every test builds its own fully isolated
// fixture set" convention as lib/academies/settings.test.ts, plus the
// FK-ordering rule established there: audit_logs (both the rows this suite
// inserts to query against, AND any recordAudit-style rows) must be deleted
// before the academies/users rows they reference.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];
const createdAuditLogIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `academy-audit-log-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Academy Audit Log Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
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

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Academy Audit Log Test Academy ${randomUUID()}`,
      slug: `academy-audit-log-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(
  userId: string,
  academyId: string,
  role: AcademyRole,
): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertAuditLog(
  academyId: string,
  overrides: Partial<typeof auditLogs.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(auditLogs)
    .values({
      academyId,
      action: "test.action",
      entityType: "test-entity",
      result: "success",
      ...overrides,
    })
    .returning({ id: auditLogs.id });
  createdAuditLogIds.push(row.id);
  return row.id;
}

/** Full fixture: a fresh academy, one active plan/subscription, and one
 * membership of the given role — matches lib/academies/settings.test.ts's
 * fixture shape exactly, since this is the same access-gate precondition. */
async function setupAcademy(
  role: AcademyRole,
): Promise<{ academyId: string; userId: string; context: AuthContext }> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: creatorUserId,
  });

  const userId = await createUser();
  await addMembership(userId, academyId, role);

  return {
    academyId,
    userId,
    context: { userId, branchIds: [], academyWide: false },
  };
}

afterAll(async () => {
  if (createdAuditLogIds.length > 0) {
    await db.delete(auditLogs).where(
      or(
        ...createdAuditLogIds.map((id) => eq(auditLogs.id, id)),
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
      ),
    );
  }
  for (const academyId of createdAcademyIds) {
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

describe("getAcademyAuditLogs — positive access (Owner/Admin, Full)", () => {
  it("allows academy_owner to view the academy's own audit log", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    await insertAuditLog(academyId, { action: "some.action" });

    const result = await getAcademyAuditLogs(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows.length).toBeGreaterThan(0);
      expect(result.data.rows.every((row) => row.academyId === academyId)).toBe(true);
    }
  });

  it("allows academy_admin to view the academy's own audit log", async () => {
    const { academyId, context } = await setupAcademy("academy_admin");
    await insertAuditLog(academyId, { action: "some.other.action" });

    const result = await getAcademyAuditLogs(context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows.every((row) => row.academyId === academyId)).toBe(true);
    }
  });
});

describe("getAcademyAuditLogs — negative access (—)", () => {
  it.each<AcademyRole>(["manager", "admissions_officer", "finance_officer", "trainer"])(
    "denies %s with code 'forbidden'",
    async (role) => {
      const { academyId, context } = await setupAcademy(role);
      await insertAuditLog(academyId);

      const result = await getAcademyAuditLogs(context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
      }
    },
  );
});

describe("getAcademyAuditLogs — cross-tenant isolation (hard academy scoping)", () => {
  it("Academy A's owner never sees Academy B's rows", async () => {
    const academyA = await setupAcademy("academy_owner");
    const academyB = await setupAcademy("academy_owner");

    await insertAuditLog(academyA.academyId, { action: "academy-a.action" });
    await insertAuditLog(academyB.academyId, { action: "academy-b.action" });

    const result = await getAcademyAuditLogs(academyA.context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows.every((row) => row.academyId === academyA.academyId)).toBe(true);
      expect(result.data.rows.some((row) => row.academyId === academyB.academyId)).toBe(false);
    }
  });

  it("ignores a malicious/different academyId smuggled into the filters object", async () => {
    const academyA = await setupAcademy("academy_owner");
    const academyB = await setupAcademy("academy_owner");

    await insertAuditLog(academyA.academyId, { action: "academy-a.action" });
    await insertAuditLog(academyB.academyId, { action: "academy-b.action" });

    // AcademyAuditLogFilters has no `academyId` field at the type level, but
    // this simulates a caller bypassing that (e.g. a hand-built object cast
    // past TypeScript, or a future refactor accidentally widening the
    // type) — the wrapper must still hard-scope to the caller's own academy
    // rather than trust anything resembling a client-supplied academyId.
    const maliciousFilters = { academyId: academyB.academyId } as Record<string, unknown>;

    const result = await getAcademyAuditLogs(
      academyA.context,
      maliciousFilters as Parameters<typeof getAcademyAuditLogs>[1],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows.every((row) => row.academyId === academyA.academyId)).toBe(true);
      expect(result.data.rows.some((row) => row.academyId === academyB.academyId)).toBe(false);
    }
  });
});

describe("getAcademyAuditLogs — filtering and pagination pass through", () => {
  it("filters by result within the caller's own academy", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    await insertAuditLog(academyId, { result: "success" });
    await insertAuditLog(academyId, { result: "failure" });

    const result = await getAcademyAuditLogs(context, { result: "failure" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows.every((row) => row.result === "failure")).toBe(true);
      expect(result.data.rows.length).toBeGreaterThan(0);
    }
  });

  it("filters by action within the caller's own academy", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    const uniqueAction = `unique.action.${randomUUID()}`;
    await insertAuditLog(academyId, { action: uniqueAction });
    await insertAuditLog(academyId, { action: "some.other.action" });

    const result = await getAcademyAuditLogs(context, { action: uniqueAction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].action).toBe(uniqueAction);
    }
  });

  it("paginates with offset semantics", async () => {
    const { academyId, context } = await setupAcademy("academy_owner");
    for (let i = 0; i < 3; i++) {
      await insertAuditLog(academyId);
    }

    const page1 = await getAcademyAuditLogs(context, {}, { page: 1, pageSize: 2 });
    const page2 = await getAcademyAuditLogs(context, {}, { page: 2, pageSize: 2 });

    expect(page1.ok && page1.data.rows).toHaveLength(2);
    expect(page2.ok && page2.data.rows).toHaveLength(1);
    if (page1.ok && page2.ok) {
      expect(page1.data.totalCount).toBe(3);
      const page1Ids = page1.data.rows.map((r) => r.id);
      const page2Ids = page2.data.rows.map((r) => r.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    }
  });
});

describe("getAcademyAuditLogs — subscription-state gating", () => {
  it("blocks with code 'blocked' when the academy's subscription is suspended", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const planId = await createPlan();
    await db.insert(academySubscriptions).values({
      academyId,
      planId,
      status: "suspended",
      createdBy: creatorUserId,
    });
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");

    const result = await getAcademyAuditLogs({ userId, branchIds: [], academyWide: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked");
  });
});
