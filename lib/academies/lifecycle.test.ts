import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  auditLogs,
  notifications,
  platformMemberships,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { GRACE_PERIOD_DAYS, type SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { notificationQueue } from "@/lib/notifications/queue";
import * as notificationsModule from "@/lib/notifications/notifications";
import {
  activateAcademy,
  cancelAcademy,
  closeAcademy,
  reactivateAcademy,
  suspendAcademy,
} from "./lifecycle";

// Phase 5 Item 58b failure-isolation test support: a real spy (not a full
// module mock) on the actual enqueueNotification, so every test still
// exercises the real DB/BullMQ enqueue path by default — only the one
// dedicated "still succeeds even if notifications enqueue fails" test below
// overrides it once via mockImplementationOnce, then it reverts to calling
// straight through.
const enqueueNotificationSpy = vi.spyOn(notificationsModule, "enqueueNotification");

async function getNotificationRows(academyId: string, eventType: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.academyId, academyId), eq(notifications.eventType, eventType)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
let paidPlanId: string;
let freePlanId: string;

const createdAcademyIds: string[] = [];
const createdSubscriptionIds: string[] = [];
const createdPaymentIds: string[] = [];
const createdUserIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `lifecycle-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(priceAmountCents: number): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Test plan ${randomUUID()}`,
      priceAmountCents,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 1,
      maxStudents: 10,
      maxStaff: 5,
      maxCourses: 5,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

async function createAcademy(opts?: { approved?: boolean; closed?: boolean }): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Test Academy ${randomUUID()}`,
      slug: `test-academy-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
      approvedBy: opts?.approved ? ownerUserId : undefined,
      approvedAt: opts?.approved ? new Date() : undefined,
      closedAt: opts?.closed ? new Date() : undefined,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function createSubscription(
  academyId: string,
  planId: string,
  overrides: Partial<typeof academySubscriptions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(academySubscriptions)
    .values({ academyId, planId, createdBy: ownerUserId, ...overrides })
    .returning({ id: academySubscriptions.id });
  createdSubscriptionIds.push(row.id);
  return row.id;
}

async function createVerifiedPayment(academyId: string, subscriptionId: string): Promise<void> {
  const [row] = await db
    .insert(subscriptionPayments)
    .values({
      academyId,
      subscriptionId,
      amountCents: 1000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      receivedAt: new Date(),
      recordedBy: ownerUserId,
      verifiedBy: ownerUserId,
      status: "verified",
    })
    .returning({ id: subscriptionPayments.id });
  createdPaymentIds.push(row.id);
}

async function getSubscriptionRow(subscriptionId: string) {
  const [row] = await db
    .select()
    .from(academySubscriptions)
    .where(eq(academySubscriptions.id, subscriptionId));
  return row;
}

async function getLatestAudit(entityId: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId))
    .orderBy(auditLogs.createdAt);
  return rows[rows.length - 1];
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });

  plainUserId = await createUser();

  paidPlanId = await createPlan(1000);
  freePlanId = await createPlan(0);
});

afterAll(async () => {
  // FK-ordering: audit_logs (references academies) first, then
  // subscription_payments (references academy_subscriptions), then
  // academy_subscriptions, then academies, then plans, then users.
  if (createdAcademyIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(
        or(
          inArray(auditLogs.academyId, createdAcademyIds),
          inArray(auditLogs.entityId, createdAcademyIds),
        ),
      );
  }
  if (createdSubscriptionIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.entityId, createdSubscriptionIds));
  }
  await db
    .delete(auditLogs)
    .where(
      or(
        inArray(auditLogs.actorUserId, createdUserIds),
        inArray(auditLogs.entityId, createdUserIds),
      ),
    );

  if (createdAcademyIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.academyId, createdAcademyIds));
  }
  if (createdPaymentIds.length > 0) {
    await db.delete(subscriptionPayments).where(inArray(subscriptionPayments.id, createdPaymentIds));
  }
  if (createdSubscriptionIds.length > 0) {
    await db.delete(academySubscriptions).where(inArray(academySubscriptions.id, createdSubscriptionIds));
  }
  if (createdAcademyIds.length > 0) {
    await db.delete(academies).where(inArray(academies.id, createdAcademyIds));
  }
  if (createdPlanIds.length > 0) {
    await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(platformMemberships).where(inArray(platformMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

// ---------------------------------------------------------------------------
// activateAcademy
// ---------------------------------------------------------------------------

describe("activateAcademy", () => {
  it("refuses when the actor is a platform_admin", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId);
    void subscriptionId;

    const adminContext = await resolveAuthContext(adminUserId);
    const result = await activateAcademy(adminContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("refuses for a plain user with no platform role", async () => {
    const academyId = await createAcademy({ approved: true });
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await activateAcademy(plainContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("rejects a malformed academy id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, "not-a-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("returns not_found for a well-formed id that doesn't exist", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("refuses a closed academy", async () => {
    const academyId = await createAcademy({ approved: true, closed: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("academy_closed");
  });

  it("refuses an unapproved academy", async () => {
    const academyId = await createAcademy({ approved: false });
    await createSubscription(academyId, freePlanId);
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_approved");
  });

  it("refuses an approved academy with no subscription at all", async () => {
    const academyId = await createAcademy({ approved: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_subscription");
  });

  it("rejects activating a subscription that is already Active (invalid_transition)", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("blocks activation of a paid plan with no verified payment", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, paidPlanId, { status: "draft" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_required");
  });

  it("activates a paid plan once a verified payment exists", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, paidPlanId, { status: "draft" });
    await createVerifiedPayment(academyId, subscriptionId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.status).toBe("active");
      expect(result.subscription.activatedAt).not.toBeNull();
    }

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("active");
    expect(row?.activatedAt).not.toBeNull();

    const audit = await getLatestAudit(subscriptionId);
    expect(audit?.action).toBe("activateAcademy");
    expect(audit?.entityType).toBe("academy_subscription");
    expect(audit?.actorUserId).toBe(ownerUserId);
  });

  it("Phase 5 Item 58b: enqueues an academy.activation notification on success", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, paidPlanId, { status: "draft" });
    await createVerifiedPayment(academyId, subscriptionId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);

    const rows = await getNotificationRows(academyId, "academy.activated");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.templateId === "academy.activation")).toBe(true);
    expect(rows.every((r) => r.userId === ownerUserId)).toBe(true);
    expect(rows.every((r) => r.academyId === academyId)).toBe(true);

    const job = await notificationQueue.getJob(`academy.activated:${academyId}:email`);
    await job?.remove();
  });

  it("Phase 5 Item 58b: activation still succeeds even when notification enqueuing fails", async () => {
    enqueueNotificationSpy.mockImplementationOnce(() => {
      throw new Error("simulated notification enqueue failure");
    });

    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, paidPlanId, { status: "draft" });
    await createVerifiedPayment(academyId, subscriptionId);

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("active");
    expect(enqueueNotificationSpy).toHaveBeenCalled();
  });

  it("activates a free plan (Trial source) with no payment required", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId, {
      status: "trial",
      trialEndsAt: new Date(Date.now() + 14 * DAY_MS),
    });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await activateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// suspendAcademy
// ---------------------------------------------------------------------------

describe("suspendAcademy", () => {
  it("refuses when the actor is a platform_admin", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await suspendAcademy(adminContext, academyId, "policy violation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses a closed academy", async () => {
    const academyId = await createAcademy({ approved: true, closed: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("academy_closed");
  });

  it("refuses an academy with no subscription", async () => {
    const academyId = await createAcademy({ approved: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_subscription");
  });

  it("rejects suspending a Draft subscription (invalid_transition)", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "draft" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("rejects suspending an already-Suspended subscription (invalid_transition)", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "suspended" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it.each(["active", "trial", "past_due"] as SubscriptionStatus[])(
    "suspends a %s subscription for cause, stamping suspended_at/notes and writing an audit reason",
    async (status) => {
      const academyId = await createAcademy({ approved: true });
      const subscriptionId = await createSubscription(academyId, freePlanId, { status });

      const ownerContext = await resolveAuthContext(ownerUserId);
      const result = await suspendAcademy(ownerContext, academyId, "terms of service violation");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.subscription.status).toBe("suspended");
      }

      const row = await getSubscriptionRow(subscriptionId);
      expect(row?.status).toBe("suspended");
      expect(row?.suspendedAt).not.toBeNull();
      expect(row?.notes).toBe("terms of service violation");

      const audit = await getLatestAudit(subscriptionId);
      expect(audit?.action).toBe("suspendAcademy");
      expect(audit?.reason).toBe("terms of service violation");
    },
  );

  it("Phase 5 Item 58b: enqueues a MANDATORY academy.suspension notification on success", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "policy violation");
    expect(result.ok).toBe(true);

    const rows = await getNotificationRows(academyId, "academy.suspended");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.templateId === "academy.suspension")).toBe(true);
    expect(rows.every((r) => r.userId === ownerUserId)).toBe(true);
    expect(rows.every((r) => r.academyId === academyId)).toBe(true);

    const job = await notificationQueue.getJob(`academy.suspended:${academyId}:email`);
    await job?.remove();
  });

  it("Phase 5 Item 58b: a suspension still succeeds even when notification enqueuing fails", async () => {
    enqueueNotificationSpy.mockImplementationOnce(() => {
      throw new Error("simulated notification enqueue failure");
    });

    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId, { status: "active" });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await suspendAcademy(ownerContext, academyId, "policy violation");
    expect(result.ok).toBe(true);

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("suspended");

    // Since the mocked call threw synchronously rather than actually
    // enqueuing, no notification row/BullMQ job exists for this one to
    // clean up.
    expect(enqueueNotificationSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reactivateAcademy
// ---------------------------------------------------------------------------

describe("reactivateAcademy", () => {
  it("refuses when the actor is a platform_admin", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "suspended" });
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await reactivateAcademy(adminContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("refuses a closed academy", async () => {
    const academyId = await createAcademy({ approved: true, closed: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("academy_closed");
  });

  it("refuses an academy with no subscription", async () => {
    const academyId = await createAcademy({ approved: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_subscription");
  });

  it("rejects reactivating a non-Suspended subscription (invalid_transition)", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("reactivates an administratively-suspended subscription with no ends_at set", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId, {
      status: "suspended",
      suspendedAt: new Date(),
    });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.subscription.status).toBe("active");

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("active");
  });

  it("reactivates an administratively-suspended subscription whose ends_at is still in the future", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId, {
      status: "suspended",
      endsAt: new Date(Date.now() + 10 * DAY_MS),
    });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(true);

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("active");
  });

  it("refuses to reactivate a subscription suspended for non-payment past its grace period (payment_lapse)", async () => {
    const academyId = await createAcademy({ approved: true });
    const startsAt = new Date(Date.now() - (GRACE_PERIOD_DAYS * DAY_MS + 30 * DAY_MS));
    const endsAt = new Date(Date.now() - (GRACE_PERIOD_DAYS * DAY_MS + 2 * DAY_MS));
    await createSubscription(academyId, freePlanId, { status: "suspended", startsAt, endsAt });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reactivateAcademy(ownerContext, academyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_lapse");
  });
});

// ---------------------------------------------------------------------------
// cancelAcademy
// ---------------------------------------------------------------------------

describe("cancelAcademy", () => {
  it("refuses when the actor is a platform_admin", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await cancelAcademy(adminContext, academyId, "no longer needed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await cancelAcademy(ownerContext, academyId, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses a closed academy", async () => {
    const academyId = await createAcademy({ approved: true, closed: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await cancelAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("academy_closed");
  });

  it("cancels a never-approved (Draft) academy — the required-reason rejection path", async () => {
    const academyId = await createAcademy({ approved: false });
    const subscriptionId = await createSubscription(academyId, freePlanId, { status: "draft" });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await cancelAcademy(ownerContext, academyId, "profile never completed");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.subscription.status).toBe("cancelled");

    const row = await getSubscriptionRow(subscriptionId);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).not.toBeNull();
    expect(row?.notes).toBe("profile never completed");

    const audit = await getLatestAudit(subscriptionId);
    expect(audit?.action).toBe("cancelAcademy");
    expect(audit?.reason).toBe("profile never completed");
  });

  it.each(["trial", "active", "past_due", "suspended", "expired"] as SubscriptionStatus[])(
    "cancels a %s subscription via the state machine's cancel event",
    async (status) => {
      const academyId = await createAcademy({ approved: true });
      const subscriptionId = await createSubscription(academyId, freePlanId, { status });

      const ownerContext = await resolveAuthContext(ownerUserId);
      const result = await cancelAcademy(ownerContext, academyId, "administrative cancellation");
      expect(result.ok).toBe(true);

      const row = await getSubscriptionRow(subscriptionId);
      expect(row?.status).toBe("cancelled");
    },
  );

  it("rejects cancelling an already-Cancelled subscription (invalid_transition)", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "cancelled" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await cancelAcademy(ownerContext, academyId, "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });
});

// ---------------------------------------------------------------------------
// closeAcademy
// ---------------------------------------------------------------------------

describe("closeAcademy", () => {
  it("refuses when the actor is a platform_admin", async () => {
    const academyId = await createAcademy({ approved: true });
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await closeAcademy(adminContext, academyId, "fraud investigation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("requires a non-empty reason", async () => {
    const academyId = await createAcademy({ approved: true });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await closeAcademy(ownerContext, academyId, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("returns not_found for a well-formed id that doesn't exist", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await closeAcademy(ownerContext, randomUUID(), "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("permanently closes an academy, independent of its subscription status", async () => {
    const academyId = await createAcademy({ approved: true });
    const subscriptionId = await createSubscription(academyId, freePlanId, { status: "active" });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await closeAcademy(ownerContext, academyId, "regulatory shutdown");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.academy.closedAt).not.toBeNull();

    const [academyRow] = await db.select().from(academies).where(eq(academies.id, academyId));
    expect(academyRow?.closedAt).not.toBeNull();

    // closeAcademy does not touch academy_subscriptions at all.
    const subscriptionRow = await getSubscriptionRow(subscriptionId);
    expect(subscriptionRow?.status).toBe("active");

    const audit = await getLatestAudit(academyId);
    expect(audit?.action).toBe("closeAcademy");
    expect(audit?.reason).toBe("regulatory shutdown");
  });

  it("refuses to close an already-closed academy a second time", async () => {
    const academyId = await createAcademy({ approved: true });
    const ownerContext = await resolveAuthContext(ownerUserId);

    const first = await closeAcademy(ownerContext, academyId, "first closure");
    expect(first.ok).toBe(true);

    const second = await closeAcademy(ownerContext, academyId, "second attempt");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_closed");
  });

  it("blocks every other lifecycle action once an academy is closed", async () => {
    const academyId = await createAcademy({ approved: true });
    await createSubscription(academyId, freePlanId, { status: "active" });
    const ownerContext = await resolveAuthContext(ownerUserId);

    const closeResult = await closeAcademy(ownerContext, academyId, "closing for good");
    expect(closeResult.ok).toBe(true);

    const activateResult = await activateAcademy(ownerContext, academyId);
    expect(activateResult.ok).toBe(false);
    if (!activateResult.ok) expect(activateResult.error.code).toBe("academy_closed");

    const suspendResult = await suspendAcademy(ownerContext, academyId, "reason");
    expect(suspendResult.ok).toBe(false);
    if (!suspendResult.ok) expect(suspendResult.error.code).toBe("academy_closed");

    const reactivateResult = await reactivateAcademy(ownerContext, academyId);
    expect(reactivateResult.ok).toBe(false);
    if (!reactivateResult.ok) expect(reactivateResult.error.code).toBe("academy_closed");

    const cancelResult = await cancelAcademy(ownerContext, academyId, "reason");
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) expect(cancelResult.error.code).toBe("academy_closed");
  });
});
