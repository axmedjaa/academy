import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  auditLogs,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { createAcademySubscription } from "./create-subscription";

let userId: string;
let academyId: string;
let activePlanId: string;
let inactivePlanId: string;
const createdSubscriptionIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `create-subscription-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

beforeAll(async () => {
  userId = await createUser();

  const [academy] = await db
    .insert(academies)
    .values({
      name: `Test Academy ${randomUUID()}`,
      slug: `test-academy-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: userId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;

  const [activePlan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Active plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 500,
      maxStaff: 50,
      maxCourses: 50,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  activePlanId = activePlan.id;

  const [inactivePlan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Inactive plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 500,
      maxStaff: 50,
      maxCourses: 50,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
      isActive: false,
    })
    .returning({ id: subscriptionPlans.id });
  inactivePlanId = inactivePlan.id;
});

afterAll(async () => {
  for (const subscriptionId of createdSubscriptionIds) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, subscriptionId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subscriptionId));
  }
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.academyId, academyId)));
  await db.delete(academies).where(eq(academies.id, academyId));
  await db
    .delete(subscriptionPlans)
    .where(or(eq(subscriptionPlans.id, activePlanId), eq(subscriptionPlans.id, inactivePlanId)));
  await db.delete(users).where(eq(users.id, userId));
});

describe("createAcademySubscription", () => {
  it("creates a Draft subscription (no trial_ends_at) when trialDays is omitted", async () => {
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: activePlanId },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdSubscriptionIds.push(result.subscriptionId);
    expect(result.status).toBe("draft");
    expect(result.trialEndsAt).toBeNull();

    const [row] = await db
      .select()
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, result.subscriptionId));
    expect(row?.status).toBe("draft");
    expect(row?.planId).toBe(activePlanId);
    expect(row?.academyId).toBe(academyId);
    expect(row?.trialEndsAt).toBeNull();
    expect(row?.createdBy).toBe(userId);
  });

  it("creates a Trial subscription with trial_ends_at = starts_at + trialDays", async () => {
    const before = Date.now();
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: activePlanId, trialDays: "30" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdSubscriptionIds.push(result.subscriptionId);
    expect(result.status).toBe("trial");
    expect(result.trialEndsAt).not.toBeNull();

    const expectedMin = before + 30 * 24 * 60 * 60 * 1000;
    const expectedMax = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const trialEndsAtMs = result.trialEndsAt?.getTime() ?? 0;
    expect(trialEndsAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(trialEndsAtMs).toBeLessThanOrEqual(expectedMax);
  });

  it("writes a same-transaction-shaped audit_logs row (actor, entity, before/after)", async () => {
    const result = await createAcademySubscription(
      db,
      { userId, role: "platform_owner" },
      { academyId, planId: activePlanId },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdSubscriptionIds.push(result.subscriptionId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.subscriptionId));
    expect(audit?.action).toBe("createAcademySubscription");
    expect(audit?.entityType).toBe("academy_subscription");
    expect(audit?.academyId).toBe(academyId);
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.actorRole).toBe("platform_owner");
    expect(audit?.result).toBe("success");
  });

  it("rejects a plan id that doesn't exist", async () => {
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: randomUUID() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plan_not_found");
    }
  });

  it("rejects a retired (inactive) plan", async () => {
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: inactivePlanId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plan_inactive");
    }
  });

  it("rejects a malformed trialDays value", async () => {
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: activePlanId, trialDays: "not-a-number" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a trialDays value outside the 1-365 day range", async () => {
    const result = await createAcademySubscription(
      db,
      { userId },
      { academyId, planId: activePlanId, trialDays: "9999" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});
