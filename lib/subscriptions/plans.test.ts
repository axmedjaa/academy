import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, platformMemberships, subscriptionPlans, users } from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import {
  createSubscriptionPlan,
  listSubscriptionPlans,
  setPlanActive,
  updateSubscriptionPlan,
  type PlanInput,
} from "./plans";

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
const createdPlanIds: string[] = [];

function validPlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    name: `Test plan ${randomUUID()}`,
    description: "A plan created by plans.test.ts",
    priceAmountCents: 999_00,
    currency: "usd",
    billingPeriod: "monthly",
    maxBranches: 1,
    maxStudents: 100,
    maxStaff: 10,
    maxCourses: 10,
    maxStorageBytes: 1_073_741_824,
    smsEnabled: false,
    emailEnabled: true,
    certificateEnabled: false,
    reportsLevel: "basic",
    ...overrides,
  };
}

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `plans-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function cleanupUser(userId: string): Promise<void> {
  // recordAudit() carries this userId as actor_user_id (a real FK to
  // users.id) on every plan mutation — those audit rows must go before the
  // user row can be deleted (same ordering as lib/platform-staff/
  // staff.test.ts's cleanupUser).
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  plainUserId = await createUser();
});

afterAll(async () => {
  for (const planId of createdPlanIds) {
    await db
      .delete(auditLogs)
      .where(eq(auditLogs.entityId, planId));
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(plainUserId);
});

describe("createSubscriptionPlan", () => {
  it("refuses when the actor is a platform_admin (plans.manage is ungrantable)", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await createSubscriptionPlan(adminContext, validPlanInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for a context with no platform role", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await createSubscriptionPlan(plainContext, validPlanInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects a negative price", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(
      ownerContext,
      validPlanInput({ priceAmountCents: -100 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects an invalid currency code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(
      ownerContext,
      validPlanInput({ currency: "dollars" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects an invalid billing period", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(
      ownerContext,
      // @ts-expect-error deliberately invalid enum value
      validPlanInput({ billingPeriod: "weekly" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("creates a plan when the actor is platform_owner, uppercasing currency and defaulting isActive true", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(ownerContext, validPlanInput({ currency: "usd" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdPlanIds.push(result.plan.id);
      expect(result.plan.currency).toBe("USD");
      expect(result.plan.isActive).toBe(true);

      const [row] = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, result.plan.id));
      expect(row).toBeDefined();
      expect(row?.name).toBe(result.plan.name);
    }
  });

  it("writes an audit row for the creation", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(ownerContext, validPlanInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdPlanIds.push(result.plan.id);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, result.plan.id));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe("createSubscriptionPlan");
      expect(audit?.entityType).toBe("subscription_plan");
    }
  });
});

describe("updateSubscriptionPlan", () => {
  let planId: string;

  beforeEach(async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(ownerContext, validPlanInput());
    if (!result.ok) throw new Error("setup failed");
    planId = result.plan.id;
    createdPlanIds.push(planId);
  });

  it("refuses when the actor is a platform_admin", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await updateSubscriptionPlan(
      adminContext,
      planId,
      validPlanInput({ name: "Renamed" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("returns not_found for a nonexistent plan id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await updateSubscriptionPlan(
      ownerContext,
      randomUUID(),
      validPlanInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns a validation error for a malformed plan id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await updateSubscriptionPlan(
      ownerContext,
      "not-a-uuid",
      validPlanInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("updates plan fields and does not change isActive", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await updateSubscriptionPlan(
      ownerContext,
      planId,
      validPlanInput({ name: "Updated plan name", maxStudents: 500 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.name).toBe("Updated plan name");
      expect(result.plan.maxStudents).toBe(500);
      expect(result.plan.isActive).toBe(true);
    }
  });
});

describe("setPlanActive", () => {
  let planId: string;

  beforeEach(async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await createSubscriptionPlan(ownerContext, validPlanInput());
    if (!result.ok) throw new Error("setup failed");
    planId = result.plan.id;
    createdPlanIds.push(planId);
  });

  it("refuses when the actor is a platform_admin", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await setPlanActive(adminContext, planId, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("retires (deactivates) a plan", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await setPlanActive(ownerContext, planId, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.isActive).toBe(false);
    }
  });

  it("restores (reactivates) a retired plan", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await setPlanActive(ownerContext, planId, false);
    const result = await setPlanActive(ownerContext, planId, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.isActive).toBe(true);
    }
  });

  it("returns not_found for a nonexistent plan id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await setPlanActive(ownerContext, randomUUID(), false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns a validation error for a malformed plan id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await setPlanActive(ownerContext, "not-a-uuid", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});

describe("listSubscriptionPlans", () => {
  it("includes both active and retired plans", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const created = await createSubscriptionPlan(ownerContext, validPlanInput());
    if (!created.ok) throw new Error("setup failed");
    createdPlanIds.push(created.plan.id);
    await setPlanActive(ownerContext, created.plan.id, false);

    const plans = await listSubscriptionPlans();
    const found = plans.find((plan) => plan.id === created.plan.id);
    expect(found).toBeDefined();
    expect(found?.isActive).toBe(false);
  });
});
