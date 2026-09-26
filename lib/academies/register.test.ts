import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  notifications,
  platformMemberships,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { notificationQueue } from "@/lib/notifications/queue";
import * as notificationsModule from "@/lib/notifications/notifications";
import { registerAcademy, type RegisterAcademyInput } from "./register";

// Phase 5 Item 58b failure-isolation test support — see lifecycle.test.ts's
// identical comment: a spy on the real enqueueNotification, overridden only
// once in the dedicated failure test below.
const enqueueNotificationSpy = vi.spyOn(notificationsModule, "enqueueNotification");

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
let activePlanId: string;
let inactivePlanId: string;

// academyIds created by successful registerAcademy calls in this file —
// cleaned up (along with their branch/membership/owner rows) in afterEach.
const createdAcademyIds: string[] = [];
// Extra "owner" users created directly by tests (e.g. to pre-occupy an
// email) that aren't tied to a created academy.
const extraUserIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `register-academy-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

function baseInput(overrides: Partial<RegisterAcademyInput> = {}): RegisterAcademyInput {
  const unique = randomUUID();
  return {
    name: `Test Academy ${unique}`,
    defaultCurrency: "usd",
    ownerEmail: `owner-${unique}@example.com`,
    ownerPassword: "a-valid-password-123",
    branchName: "Main Branch",
    branchCode: "MAIN",
    // Item 24: planId is required (academy_subscriptions.plan_id is NOT
    // NULL). Defaults to no trial (Draft) so tests unrelated to subscription
    // behavior don't have to reason about trial_ends_at math; the dedicated
    // "subscription creation" tests below override trialDays explicitly.
    planId: activePlanId,
    ...overrides,
  };
}

/**
 * Cleans up everything a successful registerAcademy call created. Ordering
 * matters: audit_logs carries a real FK to both users.id (actor_user_id) and
 * academies.id (academy_id) — as prior Wave 1 agents found the hard way,
 * those rows must be deleted before the academies/users rows they
 * reference, or the delete fails with a foreign-key violation.
 */
async function cleanupAcademy(academyId: string, ownerId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyId), eq(auditLogs.actorUserId, ownerId)));
  await db.delete(notifications).where(eq(notifications.academyId, academyId));
  await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  // academy_subscriptions.academy_id FKs to academies.id — must go before
  // the academies delete below (same ordering concern as auditLogs above).
  await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
  await db.delete(branches).where(eq(branches.academyId, academyId));
  await db.delete(academies).where(eq(academies.id, academyId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
}

async function cleanupUser(userId: string): Promise<void> {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.actorUserId, userId), eq(auditLogs.entityId, userId)));
  await db.delete(academyMemberships).where(eq(academyMemberships.userId, userId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function planValues(overrides: Partial<typeof subscriptionPlans.$inferInsert> = {}) {
  return {
    name: `Test plan ${randomUUID()}`,
    priceAmountCents: 1000,
    currency: "USD",
    billingPeriod: "monthly" as const,
    maxBranches: 5,
    maxStudents: 500,
    maxStaff: 50,
    maxCourses: 50,
    maxStorageBytes: 1_073_741_824,
    smsEnabled: false,
    emailEnabled: true,
    certificateEnabled: false,
    reportsLevel: "basic" as const,
    ...overrides,
  };
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  plainUserId = await createUser();

  const [activePlan] = await db
    .insert(subscriptionPlans)
    .values(planValues())
    .returning({ id: subscriptionPlans.id });
  activePlanId = activePlan.id;

  const [inactivePlan] = await db
    .insert(subscriptionPlans)
    .values(planValues({ isActive: false }))
    .returning({ id: subscriptionPlans.id });
  inactivePlanId = inactivePlan.id;
});

afterEach(async () => {
  for (const academyId of createdAcademyIds.splice(0)) {
    const [academy] = await db
      .select({ id: academies.id })
      .from(academies)
      .where(eq(academies.id, academyId));
    if (!academy) continue;

    const [membership] = await db
      .select({ userId: academyMemberships.userId })
      .from(academyMemberships)
      .where(eq(academyMemberships.academyId, academyId));

    await cleanupAcademy(academyId, membership?.userId ?? "");
  }
  for (const userId of extraUserIds.splice(0)) {
    await cleanupUser(userId);
  }
});

afterAll(async () => {
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(plainUserId);
  await db
    .delete(subscriptionPlans)
    .where(or(eq(subscriptionPlans.id, activePlanId), eq(subscriptionPlans.id, inactivePlanId)));
});

describe("registerAcademy — authorization", () => {
  it("refuses when the actor is a platform_admin (not platform_owner), even with no grants checked", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await registerAcademy(adminContext, baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for a context with no platform role at all", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await registerAcademy(plainContext, baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });
});

describe("registerAcademy — validation", () => {
  it("rejects a missing academy name", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ name: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a currency that isn't a 3-letter code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ defaultCurrency: "dollars" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects an owner password shorter than 8 characters", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ ownerPassword: "short1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a missing default branch code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ branchCode: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});

describe("registerAcademy — success path", () => {
  it("creates the academy, a default branch, the owner account, and the academy_owner membership in one transaction", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput();
    const result = await registerAcademy(ownerContext, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [academy] = await db
      .select()
      .from(academies)
      .where(eq(academies.id, result.academyId));
    expect(academy?.name).toBe(input.name);
    expect(academy?.defaultCurrency).toBe("USD");
    expect(academy?.createdBy).toBe(ownerUserId);
    expect(academy?.approvedAt).toBeNull();
    expect(academy?.closedAt).toBeNull();
    expect(academy?.slug).toBeTruthy();

    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, result.branchId));
    expect(branch?.academyId).toBe(result.academyId);
    expect(branch?.name).toBe("Main Branch");
    expect(branch?.code).toBe("MAIN");

    const [ownerUserRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, result.ownerUserId));
    expect(ownerUserRow?.email).toBe(input.ownerEmail);

    const [membership] = await db
      .select()
      .from(academyMemberships)
      .where(eq(academyMemberships.userId, result.ownerUserId));
    expect(membership?.academyId).toBe(result.academyId);
    expect(membership?.role).toBe("academy_owner");
    expect(membership?.status).toBe("active");
  });

  it("writes a registerAcademy audit_logs row in the same transaction", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput();
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    // Filtered by action, not just academyId: Item 24 now also writes a
    // second, createAcademySubscription audit row for the same academyId in
    // this same transaction (see the "subscription creation" describe block
    // below), so academyId alone is no longer a unique-enough filter here.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.academyId, result.academyId), eq(auditLogs.action, "registerAcademy")));
    expect(audit?.action).toBe("registerAcademy");
    expect(audit?.entityType).toBe("academy");
    expect(audit?.entityId).toBe(result.academyId);
    expect(audit?.actorUserId).toBe(ownerUserId);
    expect(audit?.result).toBe("success");
  });

  it("Phase 5 Item 58b: enqueues an academy.registered notification on success", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput();
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.academyId, result.academyId), eq(notifications.eventType, "academy.registered")));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.templateId === "academy.onboarding")).toBe(true);
    expect(rows.every((r) => r.userId === ownerUserId)).toBe(true);
    expect(rows.every((r) => r.academyId === result.academyId)).toBe(true);

    const job = await notificationQueue.getJob(`academy.registered:${result.academyId}:email`);
    await job?.remove();
  });

  it("Phase 5 Item 58b: registration still succeeds even when notification enqueuing fails", async () => {
    enqueueNotificationSpy.mockImplementationOnce(() => {
      throw new Error("simulated notification enqueue failure");
    });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);
    expect(enqueueNotificationSpy).toHaveBeenCalled();
  });

  it("normalizes blank optional profile fields to null rather than empty strings", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput({ type: "", address: "", website: "" });
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [academy] = await db
      .select()
      .from(academies)
      .where(eq(academies.id, result.academyId));
    expect(academy?.type).toBeNull();
    expect(academy?.address).toBeNull();
    expect(academy?.website).toBeNull();
  });

  it("refuses when the owner email is already in use by an existing account", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const takenEmail = `taken-${randomUUID()}@example.com`;
    const existingId = await createUser();
    extraUserIds.push(existingId);
    await db.update(users).set({ email: takenEmail }).where(eq(users.id, existingId));

    const result = await registerAcademy(ownerContext, baseInput({ ownerEmail: takenEmail }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("owner_email_taken");
    }
  });

  it("assigns a unique slug when two academies share the same name", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const sharedName = `Duplicate Name Academy ${randomUUID()}`;

    const first = await registerAcademy(ownerContext, baseInput({ name: sharedName }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdAcademyIds.push(first.academyId);

    const second = await registerAcademy(ownerContext, baseInput({ name: sharedName }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    createdAcademyIds.push(second.academyId);

    const [firstAcademy] = await db
      .select({ slug: academies.slug })
      .from(academies)
      .where(eq(academies.id, first.academyId));
    const [secondAcademy] = await db
      .select({ slug: academies.slug })
      .from(academies)
      .where(eq(academies.id, second.academyId));

    expect(firstAcademy?.slug).not.toBe(secondAcademy?.slug);
  });
});

// Item 24: "createAcademySubscription wired into registration" —
// academy_subscriptions.plan_id is NOT NULL with no default, so a plan must
// be chosen up front; the resulting row starts in Draft (no trial) or Trial
// (trialDays given), matching initialSubscriptionStatus()
// (lib/subscriptions/state-machine.ts, Item 23) and never Active directly.
describe("registerAcademy — subscription creation (Item 24)", () => {
  it("creates the academy_subscriptions row in Draft status with no trial_ends_at when trialDays is omitted", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);
    expect(result.subscriptionStatus).toBe("draft");

    const [subscription] = await db
      .select()
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, result.subscriptionId));
    expect(subscription?.academyId).toBe(result.academyId);
    expect(subscription?.planId).toBe(activePlanId);
    expect(subscription?.status).toBe("draft");
    expect(subscription?.trialEndsAt).toBeNull();
    expect(subscription?.endsAt).toBeNull();
    expect(subscription?.createdBy).toBe(ownerUserId);
  });

  it("creates the academy_subscriptions row in Trial status with trial_ends_at set when trialDays is given", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const before = Date.now();
    const result = await registerAcademy(ownerContext, baseInput({ trialDays: "14" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);
    expect(result.subscriptionStatus).toBe("trial");

    const [subscription] = await db
      .select()
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, result.subscriptionId));
    expect(subscription?.status).toBe("trial");
    expect(subscription?.trialEndsAt).not.toBeNull();

    const expectedMin = before + 14 * 24 * 60 * 60 * 1000;
    const expectedMax = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const trialEndsAtMs = subscription?.trialEndsAt?.getTime() ?? 0;
    expect(trialEndsAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(trialEndsAtMs).toBeLessThanOrEqual(expectedMax);
  });

  it("writes a createAcademySubscription audit_logs row in the same transaction", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAcademyIds.push(result.academyId);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.academyId, result.academyId),
          eq(auditLogs.action, "createAcademySubscription"),
        ),
      );
    expect(audit?.entityType).toBe("academy_subscription");
    expect(audit?.entityId).toBe(result.subscriptionId);
    expect(audit?.actorUserId).toBe(ownerUserId);
    expect(audit?.result).toBe("success");
  });

  it("refuses registration when planId does not correspond to an existing plan", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ planId: randomUUID() }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plan_unavailable");
    }
  });

  it("refuses registration when planId refers to a retired (inactive) plan", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ planId: inactivePlanId }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plan_unavailable");
    }
  });

  it("does not create an academy at all when the chosen plan is unavailable (full transaction rollback)", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const input = baseInput({ planId: inactivePlanId });
    const result = await registerAcademy(ownerContext, input);
    expect(result.ok).toBe(false);

    const [academy] = await db
      .select({ id: academies.id })
      .from(academies)
      .where(eq(academies.name, input.name));
    expect(academy).toBeUndefined();
  });

  it("rejects a malformed trialDays value", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await registerAcademy(ownerContext, baseInput({ trialDays: "not-a-number" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });
});
