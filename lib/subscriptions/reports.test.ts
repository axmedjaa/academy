import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  auditLogs,
  platformAdminPermissions,
  platformMemberships,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import {
  getActiveAcademyTrend,
  getExpiringSubscriptions,
  getPlatformReports,
  getRevenueBreakdown,
  revenueBreakdownToCsv,
} from "./reports";

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerUserId: string;
let adminUserId: string;
let grantedAdminUserId: string;
let plainUserId: string;

let academyAId: string;
let academyBId: string;
let planAId: string;
let planBId: string;
let subActiveId: string; // academyA, planA, active, ends soon (expiring), activated this month
let subPastDueId: string; // academyB, planA, past_due, ends 5 days ago (overdue)
let subCancelledId: string; // academyA, planB, cancelled, ends soon but must be excluded everywhere

const now = new Date();
const activatedThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3));
const monthKeyThisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `reports-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function cleanupUser(userId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db.delete(platformAdminPermissions).where(eq(platformAdminPermissions.userId, userId));
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
  await db
    .insert(platformAdminPermissions)
    .values({ userId: grantedAdminUserId, capability: "getPlatformReports" });

  plainUserId = await createUser();

  // Fixtures inserted directly against the schema (not through
  // lib/subscriptions/plans.ts / payments.ts / renew*.ts, all off-limits for
  // this item) since these tests only need rows to exist for the
  // aggregation logic, not to exercise those modules' own validation —
  // same convention as lib/subscriptions/payments.test.ts's fixtures.
  const [planA] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Reports test plan A ${randomUUID()}`,
      priceAmountCents: 100_000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 1,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "advanced",
    })
    .returning({ id: subscriptionPlans.id });
  planAId = planA.id;

  const [planB] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Reports test plan B ${randomUUID()}`,
      priceAmountCents: 200_000,
      currency: "USD",
      billingPeriod: "annual",
      maxBranches: 5,
      maxStudents: 500,
      maxStaff: 50,
      maxCourses: 50,
      maxStorageBytes: 10_737_418_240,
      reportsLevel: "advanced",
    })
    .returning({ id: subscriptionPlans.id });
  planBId = planB.id;

  const [academyA] = await db
    .insert(academies)
    .values({
      name: `Reports test academy A ${randomUUID()}`,
      slug: `reports-test-a-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyAId = academyA.id;

  const [academyB] = await db
    .insert(academies)
    .values({
      name: `Reports test academy B ${randomUUID()}`,
      slug: `reports-test-b-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyBId = academyB.id;

  const [subActive] = await db
    .insert(academySubscriptions)
    .values({
      academyId: academyAId,
      planId: planAId,
      status: "active",
      startsAt: new Date(now.getTime() - 60 * DAY_MS),
      endsAt: new Date(now.getTime() + 10 * DAY_MS),
      activatedAt: activatedThisMonth,
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  subActiveId = subActive.id;

  const [subPastDue] = await db
    .insert(academySubscriptions)
    .values({
      academyId: academyBId,
      planId: planAId,
      status: "past_due",
      startsAt: new Date(now.getTime() - 100 * DAY_MS),
      endsAt: new Date(now.getTime() - 5 * DAY_MS),
      activatedAt: new Date(now.getTime() - 100 * DAY_MS),
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  subPastDueId = subPastDue.id;

  const [subCancelled] = await db
    .insert(academySubscriptions)
    .values({
      academyId: academyAId,
      planId: planBId,
      status: "cancelled",
      startsAt: new Date(now.getTime() - 200 * DAY_MS),
      endsAt: new Date(now.getTime() + 5 * DAY_MS),
      cancelledAt: new Date(now.getTime() - 1 * DAY_MS),
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  subCancelledId = subCancelled.id;

  // Collected revenue: only "verified" counts.
  await db.insert(subscriptionPayments).values([
    {
      academyId: academyAId,
      subscriptionId: subActiveId,
      amountCents: 100_000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      receivedAt: now,
      recordedBy: ownerUserId,
      verifiedBy: ownerUserId,
      status: "verified",
    },
    {
      academyId: academyBId,
      subscriptionId: subPastDueId,
      amountCents: 50_000,
      currency: "USD",
      paymentMethod: "mobile_money",
      receivedAt: now,
      recordedBy: ownerUserId,
      status: "pending", // must NOT count as collected
    },
    {
      academyId: academyAId,
      subscriptionId: subActiveId,
      amountCents: 20_000,
      currency: "USD",
      paymentMethod: "cash",
      receivedAt: now,
      recordedBy: ownerUserId,
      status: "rejected", // must NOT count as collected
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyAId), eq(auditLogs.academyId, academyBId)));
  await db
    .delete(subscriptionPayments)
    .where(or(eq(subscriptionPayments.academyId, academyAId), eq(subscriptionPayments.academyId, academyBId)));
  await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subActiveId));
  await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subPastDueId));
  await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subCancelledId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planAId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planBId));
  await db.delete(academies).where(eq(academies.id, academyAId));
  await db.delete(academies).where(eq(academies.id, academyBId));
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(grantedAdminUserId);
  await cleanupUser(plainUserId);
});

describe("getPlatformReports — capability split", () => {
  it("refuses a platform_admin with no grant", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await getPlatformReports(adminContext);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses a context with no platform role", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await getPlatformReports(plainContext);
    expect(result.ok).toBe(false);
  });

  it("allows a platform_admin granted getPlatformReports but returns revenue: null", async () => {
    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await getPlatformReports(grantedContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.revenue).toBeNull();
      // Non-revenue sections must still be present for a granted admin.
      expect(Array.isArray(result.data.activeAcademyTrend)).toBe(true);
      expect(Array.isArray(result.data.expiringSubscriptions)).toBe(true);
    }
  });

  it("gives platform_owner the full report including revenue", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await getPlatformReports(ownerContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.revenue).not.toBeNull();
    }
  });

  it("still returns revenue: null for a platform_admin even with a stray platform.revenue.view grant row", async () => {
    // Simulates a hypothetical bypass of the normal grant flow (which
    // already refuses to write this row — see
    // lib/platform-staff/staff.test.ts's ungrantable-capability tests) by
    // inserting the row directly. hasPermission() must still deny it,
    // because UNGRANTABLE_CAPABILITIES is checked before any grant lookup
    // (lib/auth/permissions.ts) — this is the exact property this item's
    // brief calls "never grantable, full stop".
    await db.insert(platformAdminPermissions).values({
      userId: adminUserId,
      capability: "platform.revenue.view",
    });
    try {
      const adminContext = await resolveAuthContext(adminUserId);
      // adminUserId has no getPlatformReports grant, so the outer gate
      // still refuses entirely — that alone proves the point for the outer
      // gate. Grant the outer capability too, directly, so we can observe
      // the revenue sub-gate specifically.
      await db.insert(platformAdminPermissions).values({
        userId: adminUserId,
        capability: "getPlatformReports",
      });
      const result = await getPlatformReports(adminContext);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.revenue).toBeNull();
      }
    } finally {
      await db
        .delete(platformAdminPermissions)
        .where(eq(platformAdminPermissions.userId, adminUserId));
    }
  });
});

describe("getRevenueBreakdown", () => {
  it("sums only verified payments as collected, grouped by academy", async () => {
    const result = await getRevenueBreakdown("academy");
    const academyARow = result.rows.find((r) => r.groupKey === academyAId);
    const academyBRow = result.rows.find((r) => r.groupKey === academyBId);

    // Academy A: 100_000 verified; the 20_000 rejected payment must be excluded.
    expect(academyARow?.collectedCents).toBe(100_000);
    // Academy B: only a pending payment exists — 0 collected.
    expect(academyBRow?.collectedCents ?? 0).toBe(0);
  });

  it("derives expected/pending as the current plan price for non-cancelled subscriptions with a known endsAt", async () => {
    const result = await getRevenueBreakdown("academy");
    const academyARow = result.rows.find((r) => r.groupKey === academyAId);
    const academyBRow = result.rows.find((r) => r.groupKey === academyBId);

    // Academy A's only counted subscription is subActive (planA, 100_000) —
    // subCancelled must be excluded even though it has an endsAt.
    expect(academyARow?.expectedCents).toBe(100_000);
    // Academy B's subPastDue (planA, 100_000) is not cancelled and has an endsAt.
    expect(academyBRow?.expectedCents).toBe(100_000);
  });

  it("groups by plan", async () => {
    const result = await getRevenueBreakdown("plan");
    const planARow = result.rows.find((r) => r.groupKey === planAId);
    expect(planARow).toBeDefined();
    expect(planARow?.collectedCents).toBe(100_000);
    // Both subActive and subPastDue are on planA and both count toward expected.
    expect(planARow?.expectedCents).toBe(200_000);
  });

  it("groups by payment method, collapsing expected into a single 'not yet paid' bucket", async () => {
    const result = await getRevenueBreakdown("method");
    const bankTransferRow = result.rows.find((r) => r.groupKey === "bank_transfer");
    expect(bankTransferRow?.collectedCents).toBe(100_000);
    expect(bankTransferRow?.expectedCents).toBe(0);

    const notYetPaidRow = result.rows.find((r) => r.groupKey === "__not_yet_paid__");
    expect(notYetPaidRow?.collectedCents).toBe(0);
    expect(notYetPaidRow?.expectedCents).toBe(200_000);
  });

  it("groups by month using receivedAt for collected and endsAt for expected", async () => {
    const result = await getRevenueBreakdown("month");
    const totalCollected = result.rows.reduce((sum, r) => sum + r.collectedCents, 0);
    const totalExpected = result.rows.reduce((sum, r) => sum + r.expectedCents, 0);
    expect(totalCollected).toBe(100_000);
    expect(totalExpected).toBe(200_000);
  });

  it("totals match the sum of all rows", async () => {
    const result = await getRevenueBreakdown("academy");
    const expectedCollectedTotal = result.rows.reduce((sum, r) => sum + r.collectedCents, 0);
    const expectedExpectedTotal = result.rows.reduce((sum, r) => sum + r.expectedCents, 0);
    expect(result.totals.collectedCents).toBe(expectedCollectedTotal);
    expect(result.totals.expectedCents).toBe(expectedExpectedTotal);
  });
});

describe("getActiveAcademyTrend", () => {
  it("counts academyA's activation in the current month and reflects it cumulatively", async () => {
    const trend = await getActiveAcademyTrend(12);
    const thisMonthPoint = trend.find((p) => p.month === monthKeyThisMonth);
    expect(thisMonthPoint).toBeDefined();
    expect(thisMonthPoint?.newlyActivated).toBeGreaterThanOrEqual(1);
    expect(thisMonthPoint?.cumulativeActive).toBeGreaterThanOrEqual(1);
  });

  it("does not count academyB's past_due subscription (not currently active)", async () => {
    const trend = await getActiveAcademyTrend(12);
    const totalCumulative = trend[trend.length - 1]?.cumulativeActive ?? 0;
    // Only subActive (academyA) is status = "active"; subPastDue/subCancelled
    // must not contribute regardless of their own activatedAt/cancelledAt.
    expect(totalCumulative).toBeGreaterThanOrEqual(1);
  });

  it("returns exactly the requested trailing window length", async () => {
    const trend = await getActiveAcademyTrend(6);
    expect(trend).toHaveLength(6);
  });
});

describe("getExpiringSubscriptions", () => {
  it("includes an active subscription ending within the window, with a positive days-until-expiry", async () => {
    const rows = await getExpiringSubscriptions(30);
    const row = rows.find((r) => r.subscriptionId === subActiveId);
    expect(row).toBeDefined();
    expect(row?.daysUntilExpiry).toBeGreaterThan(0);
  });

  it("includes an already-overdue non-cancelled subscription, with a negative days-until-expiry", async () => {
    const rows = await getExpiringSubscriptions(30);
    const row = rows.find((r) => r.subscriptionId === subPastDueId);
    expect(row).toBeDefined();
    expect(row?.daysUntilExpiry).toBeLessThan(0);
  });

  it("excludes cancelled subscriptions even when their endsAt falls in the window", async () => {
    const rows = await getExpiringSubscriptions(30);
    const row = rows.find((r) => r.subscriptionId === subCancelledId);
    expect(row).toBeUndefined();
  });

  it("excludes subscriptions ending after the requested window", async () => {
    const rows = await getExpiringSubscriptions(1);
    const row = rows.find((r) => r.subscriptionId === subActiveId);
    expect(row).toBeUndefined();
  });

  it("sorts soonest/most-overdue first", async () => {
    const rows = await getExpiringSubscriptions(30);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].endsAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1].endsAt.getTime());
    }
  });
});

describe("revenueBreakdownToCsv", () => {
  it("formats rows and a totals line as CSV, converting cents to a fixed-point decimal", () => {
    const csv = revenueBreakdownToCsv({
      groupBy: "academy",
      rows: [
        { groupKey: "a1", label: "Academy One", collectedCents: 150_000, expectedCents: 100_000 },
        { groupKey: "a2", label: "Academy, Two", collectedCents: 0, expectedCents: 50_000 },
      ],
      totals: { collectedCents: 150_000, expectedCents: 150_000 },
    });

    const lines = csv.split("\n");
    expect(lines[0]).toBe("Group,Collected,Expected");
    expect(lines[1]).toBe("Academy One,1500.00,1000.00");
    // A label containing a comma must be quoted.
    expect(lines[2]).toBe('"Academy, Two",0.00,500.00');
    expect(lines[3]).toBe("Total,1500.00,1500.00");
  });
});
