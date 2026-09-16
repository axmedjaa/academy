import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  academyUsage,
  auditLogs,
  branches,
  platformAdminPermissions,
  platformMemberships,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import {
  checkAllowance,
  listAcademyUsageOverview,
  recalculateUsage,
} from "./usage";

let ownerUserId: string;
let adminUserId: string;
let grantedAdminUserId: string;
let plainUserId: string;

// Two-branch-limit academy: exactly at its limit once two active branches
// exist, which is what exercises checkAllowance's "current >= limit"
// blocking behavior without needing Phase 2 tables.
let academyId: string;
let planId: string;
let subscriptionId: string;

// A second academy with no subscription at all, for the no_plan/limits-null
// paths.
let bareAcademyId: string;

const createdAcademyIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `usage-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function cleanupUser(userId: string): Promise<void> {
  // recordAudit() carries this userId as actor_user_id (a real FK to
  // users.id) on every recalculateUsage call — those audit rows must go
  // before the user row can be deleted (same ordering as
  // lib/subscriptions/plans.test.ts's / payments.test.ts's cleanupUser).
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db
    .delete(platformAdminPermissions)
    .where(eq(platformAdminPermissions.userId, userId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  grantedAdminUserId = await createUser();
  await db
    .insert(platformMemberships)
    .values({ userId: grantedAdminUserId, role: "platform_admin" });
  await db.insert(platformAdminPermissions).values({
    userId: grantedAdminUserId,
    capability: "getPlatformReports",
  });

  plainUserId = await createUser();

  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Usage test plan ${randomUUID()}`,
      priceAmountCents: 5_000_00,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 2,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  planId = plan.id;

  const [academy] = await db
    .insert(academies)
    .values({
      name: `Usage test academy ${randomUUID()}`,
      slug: `usage-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;
  createdAcademyIds.push(academyId);

  const [subscription] = await db
    .insert(academySubscriptions)
    .values({
      academyId,
      planId,
      status: "active",
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  subscriptionId = subscription.id;

  // Two active branches (at the plan's maxBranches=2 limit) + one archived
  // branch, which must NOT count toward branch_count/allowance.
  await db.insert(branches).values([
    { academyId, name: "Main", code: "MAIN", status: "active" },
    { academyId, name: "Annex", code: "ANNEX", status: "active" },
    { academyId, name: "Old Site", code: "OLD", status: "archived" },
  ]);

  const [bareAcademy] = await db
    .insert(academies)
    .values({
      name: `Usage test bare academy ${randomUUID()}`,
      slug: `usage-test-bare-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  bareAcademyId = bareAcademy.id;
  createdAcademyIds.push(bareAcademyId);
});

afterAll(async () => {
  for (const id of createdAcademyIds) {
    await db.delete(auditLogs).where(or(eq(auditLogs.academyId, id), eq(auditLogs.entityId, id)));
  }
  await db.delete(academyUsage).where(eq(academyUsage.academyId, academyId));
  await db.delete(academyUsage).where(eq(academyUsage.academyId, bareAcademyId));
  await db.delete(branches).where(eq(branches.academyId, academyId));
  await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subscriptionId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await db.delete(academies).where(eq(academies.id, academyId));
  await db.delete(academies).where(eq(academies.id, bareAcademyId));
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(grantedAdminUserId);
  await cleanupUser(plainUserId);
});

describe("checkAllowance", () => {
  it("counts only active branches, and blocks at the plan limit", async () => {
    const outcome = await checkAllowance(academyId, "branches");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.current).toBe(2); // archived branch excluded
      expect(outcome.result.limit).toBe(2);
      expect(outcome.result.allowed).toBe(false); // at limit -> blocked
    }
  });

  it("treats students/staff/courses/storage as 0 (no Phase 2 tables yet), never blocking a positive limit", async () => {
    for (const resource of ["students", "staff", "courses", "storage"] as const) {
      const outcome = await checkAllowance(academyId, resource);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.current).toBe(0);
        expect(outcome.result.allowed).toBe(true);
      }
    }
  });

  it("returns no_plan for an academy with no subscription", async () => {
    const outcome = await checkAllowance(bareAcademyId, "branches");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("no_plan");
    }
  });

  it("returns a validation error for a malformed academy id", async () => {
    const outcome = await checkAllowance("not-a-uuid", "branches");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("validation");
    }
  });
});

describe("recalculateUsage", () => {
  it("refuses when the actor is a platform_admin with no grant", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await recalculateUsage(adminContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for a context with no platform role", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await recalculateUsage(plainContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("returns not_found for a nonexistent academy id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recalculateUsage(ownerContext, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("recomputes and persists a snapshot when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recalculateUsage(ownerContext, academyId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.branchCount).toBe(2);
      expect(result.usage.activeStudentsCount).toBe(0);
      expect(result.usage.activeStaffCount).toBe(0);
      expect(result.usage.courseCount).toBe(0);
      expect(result.usage.storageUsedBytes).toBe(0);
      expect(result.usage.academyId).toBe(academyId);
    }
  });

  it("succeeds when the actor is a platform_admin granted getPlatformReports", async () => {
    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await recalculateUsage(grantedContext, academyId);
    expect(result.ok).toBe(true);
  });

  it("writes an audit row for the recalculation", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recalculateUsage(ownerContext, academyId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, result.usage.id));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe("recalculateUsage");
      expect(audit?.entityType).toBe("academy_usage");
    }
  });

  it("appends a new snapshot row rather than overwriting the previous one", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const first = await recalculateUsage(ownerContext, academyId);
    const second = await recalculateUsage(ownerContext, academyId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.usage.id).not.toBe(second.usage.id);
    }
  });
});

describe("listAcademyUsageOverview", () => {
  it("includes the fixture academy with its plan limits and latest usage snapshot", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await recalculateUsage(ownerContext, academyId);

    const rows = await listAcademyUsageOverview();
    const found = rows.find((row) => row.academyId === academyId);
    expect(found).toBeDefined();
    expect(found?.limits?.maxBranches).toBe(2);
    expect(found?.usage?.branchCount).toBe(2);
  });

  it("shows null limits and null usage for an academy with no subscription and no recalculation yet", async () => {
    const rows = await listAcademyUsageOverview();
    const found = rows.find((row) => row.academyId === bareAcademyId);
    expect(found).toBeDefined();
    expect(found?.limits).toBeNull();
    expect(found?.usage).toBeNull();
  });
});
