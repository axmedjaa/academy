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
import {
  checkAcademyAccess,
  checkAcademyAccessForContext,
} from "./access-gate";

const DAY_MS = 24 * 60 * 60 * 1000;

// Every row this file creates, tracked for a single top-level cleanup —
// simpler than register.test.ts's per-test afterEach since every test here
// builds its own fully isolated academy/user/subscription set rather than
// reusing shared fixtures.
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `access-gate-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createAcademy(overrides: { closedAt?: Date } = {}): Promise<{
  academyId: string;
  creatorUserId: string;
}> {
  const creatorUserId = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Access Gate Test Academy ${randomUUID()}`,
      slug: `access-gate-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
      closedAt: overrides.closedAt,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return { academyId: academy.id, creatorUserId };
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Access Gate Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 1,
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

async function addMembership(
  userId: string,
  academyId: string,
  role: "academy_owner" | "manager" = "academy_owner",
  status: "active" | "removed" = "active",
): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status });
}

interface SubscriptionOverrides {
  status: "draft" | "trial" | "active" | "past_due" | "suspended" | "expired" | "cancelled";
  startsAt?: Date;
  endsAt?: Date | null;
  trialEndsAt?: Date | null;
}

async function addSubscription(
  academyId: string,
  planId: string,
  overrides: SubscriptionOverrides,
): Promise<string> {
  // startsAt is NOT NULL with defaultNow() — the key must be omitted
  // entirely (not passed as `undefined`) for that default to apply, so
  // this only includes it when a test explicitly overrides it.
  const [row] = await db
    .insert(academySubscriptions)
    .values({
      academyId,
      planId,
      status: overrides.status,
      ...(overrides.startsAt ? { startsAt: overrides.startsAt } : {}),
      endsAt: overrides.endsAt,
      trialEndsAt: overrides.trialEndsAt,
      createdBy: await getAnyCreatedUser(),
    })
    .returning({ id: academySubscriptions.id });
  return row.id;
}

// academy_subscriptions.created_by is NOT NULL but this test file never
// exercises anything that reads it — reusing the first user created keeps
// every addSubscription() call from needing its own throwaway actor.
let anyCreatedUserId: string | undefined;
async function getAnyCreatedUser(): Promise<string> {
  if (!anyCreatedUserId) {
    anyCreatedUserId = await createUser();
  }
  return anyCreatedUserId;
}

afterAll(async () => {
  // FK ordering: audit_logs before academy_subscriptions/academies/users
  // (as established by lib/academies/register.test.ts and
  // lib/subscriptions/plans.test.ts's cleanup comments).
  await db
    .delete(auditLogs)
    .where(
      or(
        ...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)),
        ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id)),
      ),
    );
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

describe("checkAcademyAccess — membership resolution", () => {
  it("blocks a user with no academy membership at all", async () => {
    const userId = await createUser();
    const result = await checkAcademyAccess(userId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("not_a_member");
    }
  });

  it("blocks a user whose only membership has been removed", async () => {
    const { academyId } = await createAcademy();
    const planId = await createPlan();
    await addSubscription(academyId, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    const userId = await createUser();
    await addMembership(userId, academyId, "manager", "removed");

    const result = await checkAcademyAccess(userId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("not_a_member");
    }
  });

  it("blocks with ambiguous_academy when the user has more than one active membership and no academyId is given", async () => {
    const { academyId: academyIdA } = await createAcademy();
    const { academyId: academyIdB } = await createAcademy();
    const planId = await createPlan();
    await addSubscription(academyIdA, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    await addSubscription(academyIdB, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });

    const userId = await createUser();
    await addMembership(userId, academyIdA);
    await addMembership(userId, academyIdB);

    const result = await checkAcademyAccess(userId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("ambiguous_academy");
    }
  });

  it("resolves correctly when academyId is given explicitly, even with multiple memberships", async () => {
    const { academyId: academyIdA } = await createAcademy();
    const { academyId: academyIdB } = await createAcademy();
    const planId = await createPlan();
    await addSubscription(academyIdA, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    await addSubscription(academyIdB, planId, { status: "suspended" });

    const userId = await createUser();
    await addMembership(userId, academyIdA);
    await addMembership(userId, academyIdB);

    const resultA = await checkAcademyAccess(userId, academyIdA);
    expect(resultA.level).toBe("full");

    const resultB = await checkAcademyAccess(userId, academyIdB);
    expect(resultB.level).toBe("blocked");
  });

  it("blocks not_a_member for an academyId the user isn't a member of (IDOR-safe, no existence leak)", async () => {
    const { academyId } = await createAcademy();
    const planId = await createPlan();
    await addSubscription(academyId, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    const userId = await createUser();

    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("not_a_member");
    }
  });
});

describe("checkAcademyAccess — closure overrides everything", () => {
  it("blocks with reason 'closed' even when the subscription is Active", async () => {
    const { academyId } = await createAcademy({ closedAt: new Date() });
    const planId = await createPlan();
    await addSubscription(academyId, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    const userId = await createUser();
    await addMembership(userId, academyId);

    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("closed");
    }
  });
});

describe("checkAcademyAccess — no subscription row", () => {
  it("blocks with reason 'no_subscription'", async () => {
    const { academyId } = await createAcademy();
    const userId = await createUser();
    await addMembership(userId, academyId);

    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") {
      expect(result.reason).toBe("no_subscription");
    }
  });
});

describe("checkAcademyAccess — status -> access-level mapping", () => {
  async function setupWithStatus(overrides: SubscriptionOverrides) {
    const { academyId } = await createAcademy();
    const planId = await createPlan();
    const subscriptionId = await addSubscription(academyId, planId, overrides);
    const userId = await createUser();
    await addMembership(userId, academyId, "academy_owner");
    return { academyId, subscriptionId, userId };
  }

  it("blocks Draft as not_yet_active", async () => {
    const { academyId, userId } = await setupWithStatus({ status: "draft" });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("not_yet_active");
  });

  it("grants full access for Trial before trial_ends_at", async () => {
    const { academyId, userId } = await setupWithStatus({
      status: "trial",
      trialEndsAt: new Date(Date.now() + 10 * DAY_MS),
    });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("full");
    if (result.level === "full") {
      expect(result.subscriptionStatus).toBe("trial");
      expect(result.membershipRole).toBe("academy_owner");
    }
  });

  it("lazily flips an expired Trial to Expired, blocks, and persists the flip", async () => {
    const { academyId, subscriptionId, userId } = await setupWithStatus({
      status: "trial",
      // starts_at must precede trial_ends_at (DB check constraint), so this
      // can't rely on starts_at's defaultNow() the way the "before
      // trial_ends_at" case above does.
      startsAt: new Date(Date.now() - 30 * DAY_MS),
      trialEndsAt: new Date(Date.now() - 1 * DAY_MS),
    });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("expired");

    const [row] = await db
      .select({ status: academySubscriptions.status })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId));
    expect(row?.status).toBe("expired");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, subscriptionId));
    expect(audit?.action).toBe("lazySubscriptionStatusFlip");
    expect(audit?.academyId).toBe(academyId);
  });

  it("grants full access for Active before ends_at", async () => {
    const { academyId, userId } = await setupWithStatus({
      status: "active",
      endsAt: new Date(Date.now() + 30 * DAY_MS),
    });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("full");
  });

  it("degrades a lapsed Active subscription to grace access (Past Due, within 7 days) and persists the flip", async () => {
    const { academyId, subscriptionId, userId } = await setupWithStatus({
      status: "active",
      // starts_at must precede ends_at (DB check constraint).
      startsAt: new Date(Date.now() - 30 * DAY_MS),
      endsAt: new Date(Date.now() - 2 * DAY_MS),
    });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("grace");
    if (result.level === "grace") {
      expect(result.subscriptionStatus).toBe("past_due");
      expect(result.graceDaysRemaining).toBe(5);
      expect(result.message).toContain("grace period");
    }

    const [row] = await db
      .select({ status: academySubscriptions.status })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId));
    expect(row?.status).toBe("past_due");
  });

  it("blocks as suspended once the 7-day grace period has elapsed (lazy flip from Active), and persists it", async () => {
    const { academyId, subscriptionId, userId } = await setupWithStatus({
      status: "active",
      // starts_at must precede ends_at (DB check constraint).
      startsAt: new Date(Date.now() - 30 * DAY_MS),
      endsAt: new Date(Date.now() - 10 * DAY_MS),
    });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("suspended");

    const [row] = await db
      .select({ status: academySubscriptions.status })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId));
    expect(row?.status).toBe("suspended");
  });

  it("blocks an already-Suspended subscription without needing a flip", async () => {
    const { academyId, subscriptionId, userId } = await setupWithStatus({ status: "suspended" });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("suspended");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, subscriptionId));
    expect(audit).toBeUndefined();
  });

  it("blocks Expired", async () => {
    const { academyId, userId } = await setupWithStatus({ status: "expired" });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("expired");
  });

  it("blocks Cancelled", async () => {
    const { academyId, userId } = await setupWithStatus({ status: "cancelled" });
    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("cancelled");
  });
});

describe("checkAcademyAccess — current subscription selection", () => {
  it("uses the most recently started subscription row when an academy has more than one", async () => {
    const { academyId } = await createAcademy();
    const planId = await createPlan();
    // Older, terminal subscription.
    await addSubscription(academyId, planId, {
      status: "cancelled",
      startsAt: new Date(Date.now() - 100 * DAY_MS),
      endsAt: new Date(Date.now() - 60 * DAY_MS),
    });
    // Newer subscription created after re-registering service.
    await addSubscription(academyId, planId, {
      status: "active",
      startsAt: new Date(Date.now() - 1 * DAY_MS),
      endsAt: new Date(Date.now() + 29 * DAY_MS),
    });
    const userId = await createUser();
    await addMembership(userId, academyId);

    const result = await checkAcademyAccess(userId, academyId);
    expect(result.level).toBe("full");
  });
});

describe("checkAcademyAccessForContext", () => {
  it("blocks with not_authenticated for a null AuthContext", async () => {
    const result = await checkAcademyAccessForContext(null);
    expect(result.level).toBe("blocked");
    if (result.level === "blocked") expect(result.reason).toBe("not_authenticated");
  });

  it("delegates to checkAcademyAccess for a real AuthContext", async () => {
    const { academyId } = await createAcademy();
    const planId = await createPlan();
    await addSubscription(academyId, planId, { status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS) });
    const userId = await createUser();
    await addMembership(userId, academyId);

    const result = await checkAcademyAccessForContext(
      { userId, branchIds: [], academyWide: false },
      academyId,
    );
    expect(result.level).toBe("full");
  });
});
