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
  subscriptionPaymentConsumptions,
  subscriptionPayments,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/auth-context";
import { renewSubscription, listPlatformSubscriptions, EXPIRING_SOON_WINDOW_DAYS } from "./renew";

let ownerUserId: string;
let adminUserId: string;
let plainUserId: string;
let academyId: string;
let planId: string;

const createdSubscriptionIds: string[] = [];
const createdPaymentIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `renew-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

async function createSubscription(overrides: {
  status: "draft" | "trial" | "active" | "past_due" | "suspended" | "expired" | "cancelled";
  startsAt?: Date;
  endsAt?: Date | null;
  trialEndsAt?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(academySubscriptions)
    .values({
      academyId,
      planId,
      status: overrides.status,
      // Default startsAt to well in the past (rather than leaving it to
      // defaultNow()) so it never falls after an intentionally-past
      // `endsAt` fixture (e.g. Expired/Suspended cases) and trips the
      // ends_at >= starts_at check constraint.
      startsAt: overrides.startsAt ?? new Date(Date.now() - 400 * DAY_MS),
      endsAt: overrides.endsAt,
      trialEndsAt: overrides.trialEndsAt,
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  createdSubscriptionIds.push(row.id);
  return row.id;
}

async function createPayment(overrides: {
  subscriptionId: string;
  status: "pending" | "verified" | "rejected" | "reversed";
  receivedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(subscriptionPayments)
    .values({
      academyId,
      subscriptionId: overrides.subscriptionId,
      amountCents: 10_000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      receivedAt: overrides.receivedAt ?? new Date(),
      recordedBy: ownerUserId,
      verifiedBy: overrides.status === "verified" || overrides.status === "reversed" ? ownerUserId : undefined,
      status: overrides.status,
    })
    .returning({ id: subscriptionPayments.id });
  createdPaymentIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ownerUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: ownerUserId, role: "platform_owner" });

  adminUserId = await createUser();
  await db.insert(platformMemberships).values({ userId: adminUserId, role: "platform_admin" });
  // renewSubscription is in UNGRANTABLE_CAPABILITIES — granting it anyway
  // (an impossible admin UI state, but cheap to prove defensively) must
  // still never satisfy hasPermission() for a platform_admin.
  await db
    .insert(platformAdminPermissions)
    .values({ userId: adminUserId, capability: "renewSubscription" });

  plainUserId = await createUser();

  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Renew test plan ${randomUUID()}`,
      priceAmountCents: 10_000,
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
  planId = plan.id;

  const [academy] = await db
    .insert(academies)
    .values({
      name: `Renew test academy ${randomUUID()}`,
      slug: `renew-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;
});

afterAll(async () => {
  // FK ordering: audit_logs and subscription_payment_consumptions
  // reference subscription_payments/academy_subscriptions, so both must
  // be deleted before their parent rows.
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyId), eq(auditLogs.entityId, academyId)));
  for (const subscriptionId of createdSubscriptionIds) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, subscriptionId));
    await db
      .delete(subscriptionPaymentConsumptions)
      .where(eq(subscriptionPaymentConsumptions.academySubscriptionId, subscriptionId));
  }
  for (const paymentId of createdPaymentIds) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, paymentId));
    await db
      .delete(subscriptionPaymentConsumptions)
      .where(eq(subscriptionPaymentConsumptions.subscriptionPaymentId, paymentId));
  }
  await db.delete(subscriptionPayments).where(eq(subscriptionPayments.academyId, academyId));
  await db
    .delete(academySubscriptions)
    .where(eq(academySubscriptions.academyId, academyId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await db.delete(academies).where(eq(academies.id, academyId));

  await db
    .delete(auditLogs)
    .where(
      or(
        eq(auditLogs.actorUserId, ownerUserId),
        eq(auditLogs.actorUserId, adminUserId),
        eq(auditLogs.actorUserId, plainUserId),
      ),
    );
  await db.delete(platformAdminPermissions).where(eq(platformAdminPermissions.userId, adminUserId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, ownerUserId));
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, adminUserId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  await db.delete(users).where(eq(users.id, adminUserId));
  await db.delete(users).where(eq(users.id, plainUserId));
});

describe("renewSubscription — authorization", () => {
  it("refuses a platform_admin, even one granted the capability directly", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await renewSubscription(adminContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  it("refuses a context with no platform role", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await renewSubscription(plainContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("renewSubscription — source state gate", () => {
  it("rejects a Draft subscription outright", async () => {
    const subscriptionId = await createSubscription({ status: "draft", endsAt: null });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("rejects a Trial subscription (still within its trial window) outright", async () => {
    const subscriptionId = await createSubscription({
      status: "trial",
      trialEndsAt: new Date(Date.now() + 30 * DAY_MS),
    });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("rejects a Cancelled subscription outright, even with a verified payment", async () => {
    const subscriptionId = await createSubscription({ status: "cancelled", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_transition");
  });

  it("treats a lapsed Trial (past trial_ends_at) as effectively Expired and allows renewal", async () => {
    const subscriptionId = await createSubscription({
      status: "trial",
      trialEndsAt: new Date(Date.now() - DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.status).toBe("active");
    }
  });
});

describe("renewSubscription — payment precondition", () => {
  it("rejects Active with no subscription_payments row at all", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_verified_payment");
  });

  it("rejects when the only payment is pending (not yet verified)", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "pending" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_verified_payment");
  });

  it("rejects when the only verified payment has since been reversed", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "reversed" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_verified_payment");
  });

  it("rejects a second renewal once the only verified payment has already been consumed", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);

    const first = await renewSubscription(ownerContext, { subscriptionId });
    expect(first.ok).toBe(true);

    const second = await renewSubscription(ownerContext, { subscriptionId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("no_verified_payment");
  });
});

describe("renewSubscription — status effects", () => {
  it("Active -> Active (no-op on status, only ends_at moves)", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.statusBefore).toBe("active");
      expect(result.subscription.status).toBe("active");
    }
  });

  it("Past Due -> Active (reactivates in the same call)", async () => {
    const subscriptionId = await createSubscription({
      status: "past_due",
      endsAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.statusBefore).toBe("past_due");
      expect(result.subscription.status).toBe("active");
    }
  });

  it("Suspended -> Active (reactivates in the same call)", async () => {
    const subscriptionId = await createSubscription({
      status: "suspended",
      endsAt: new Date(Date.now() - 20 * DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.statusBefore).toBe("suspended");
      expect(result.subscription.status).toBe("active");
    }
  });

  it("Expired -> Active (reactivates in the same call)", async () => {
    const subscriptionId = await createSubscription({
      status: "expired",
      endsAt: new Date(Date.now() - 60 * DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.statusBefore).toBe("expired");
      expect(result.subscription.status).toBe("active");
    }
  });
});

describe("renewSubscription — date effects", () => {
  it("never changes starts_at", async () => {
    const startsAt = new Date(Date.now() - 10 * DAY_MS);
    const subscriptionId = await createSubscription({
      status: "active",
      startsAt,
      endsAt: new Date(Date.now() + 5 * DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    await renewSubscription(ownerContext, { subscriptionId });

    const [row] = await db
      .select({ startsAt: academySubscriptions.startsAt })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId));
    expect(row.startsAt.getTime()).toBe(startsAt.getTime());
  });

  it("early renewal (before expiry) extends from the current ends_at, not from now", async () => {
    const currentEndsAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscription({ status: "active", endsAt: currentEndsAt });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = new Date(currentEndsAt);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(result.subscription.endsAt.getTime()).toBe(expected.getTime());
  });

  it("late renewal (after a lapse) extends from now, not retroactively from the old ends_at", async () => {
    const lapsedEndsAt = new Date(Date.now() - 60 * DAY_MS);
    const subscriptionId = await createSubscription({ status: "expired", endsAt: lapsedEndsAt });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);

    const before = Date.now();
    const result = await renewSubscription(ownerContext, { subscriptionId });
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedMin = new Date(before);
    expectedMin.setUTCMonth(expectedMin.getUTCMonth() + 1);
    const expectedMax = new Date(after);
    expectedMax.setUTCMonth(expectedMax.getUTCMonth() + 1);
    expect(result.subscription.endsAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(result.subscription.endsAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("consumes the oldest eligible verified payment first (FIFO) when more than one exists", async () => {
    const subscriptionId = await createSubscription({
      status: "active",
      endsAt: new Date(Date.now() + 5 * DAY_MS),
    });
    const olderPaymentId = await createPayment({
      subscriptionId,
      status: "verified",
      receivedAt: new Date(Date.now() - 10 * DAY_MS),
    });
    await createPayment({
      subscriptionId,
      status: "verified",
      receivedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.consumedPaymentId).toBe(olderPaymentId);
    }
  });
});

describe("renewSubscription — audit trail", () => {
  it("writes an audit row with before/after status, before/after ends_at, and the consumed payment reference", async () => {
    const originalEndsAt = new Date(Date.now() - 2 * DAY_MS);
    const subscriptionId = await createSubscription({ status: "past_due", endsAt: originalEndsAt });
    const paymentId = await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId });
    expect(result.ok).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, subscriptionId));
    expect(audit?.action).toBe("renewSubscription");
    expect(audit?.entityType).toBe("academy_subscription");
    expect(audit?.actorUserId).toBe(ownerUserId);
    expect((audit?.before as { status: string })?.status).toBe("past_due");
    expect((audit?.after as { status: string })?.status).toBe("active");
    expect((audit?.context as { consumedSubscriptionPaymentId: string })?.consumedSubscriptionPaymentId).toBe(
      paymentId,
    );
  });
});

describe("renewSubscription — not found / validation", () => {
  it("rejects a subscription id that doesn't exist", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId: randomUUID() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects a malformed subscription id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await renewSubscription(ownerContext, { subscriptionId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("renewSubscription — concurrent double-spend race", () => {
  it("lets exactly one of two simultaneous renewals against the same verified payment succeed", async () => {
    const subscriptionId = await createSubscription({
      status: "active",
      endsAt: new Date(Date.now() + 5 * DAY_MS),
    });
    await createPayment({ subscriptionId, status: "verified" });
    const ownerContext = await resolveAuthContext(ownerUserId);

    const [resultA, resultB] = await Promise.all([
      renewSubscription(ownerContext, { subscriptionId }),
      renewSubscription(ownerContext, { subscriptionId }),
    ]);

    const outcomes = [resultA, resultB];
    const successes = outcomes.filter((r) => r.ok);
    const failures = outcomes.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (!failures[0].ok) {
      expect(failures[0].error.code).toBe("no_verified_payment");
    }

    // The database-level invariant PLAN.md's algorithm exists to
    // guarantee: exactly one consumption row for this subscription, ever,
    // regardless of which of the two racing calls "won."
    const consumptions = await db
      .select()
      .from(subscriptionPaymentConsumptions)
      .where(eq(subscriptionPaymentConsumptions.academySubscriptionId, subscriptionId));
    expect(consumptions).toHaveLength(1);

    // ends_at must have moved by exactly one billing period, not two —
    // proof the "loser" never partially applied its own update.
    const [row] = await db
      .select({ endsAt: academySubscriptions.endsAt })
      .from(academySubscriptions)
      .where(eq(academySubscriptions.id, subscriptionId));
    if (successes[0].ok) {
      expect(row.endsAt?.getTime()).toBe(successes[0].subscription.endsAt.getTime());
    }
  });
});

describe("listPlatformSubscriptions", () => {
  it("flags a still-Active subscription ending within the expiring-soon window", async () => {
    const subscriptionId = await createSubscription({
      status: "active",
      endsAt: new Date(Date.now() + 3 * DAY_MS),
    });
    const rows = await listPlatformSubscriptions();
    const row = rows.find((r) => r.subscriptionId === subscriptionId);
    expect(row).toBeDefined();
    expect(row?.expiringSoon).toBe(true);
    expect(EXPIRING_SOON_WINDOW_DAYS).toBe(14);
  });

  it("does not flag an Active subscription ending well beyond the window", async () => {
    const subscriptionId = await createSubscription({
      status: "active",
      endsAt: new Date(Date.now() + 90 * DAY_MS),
    });
    const rows = await listPlatformSubscriptions();
    const row = rows.find((r) => r.subscriptionId === subscriptionId);
    expect(row?.expiringSoon).toBe(false);
  });

  it("marks canRenew false with a Cancelled-specific reason for a Cancelled subscription", async () => {
    const subscriptionId = await createSubscription({ status: "cancelled", endsAt: new Date() });
    const rows = await listPlatformSubscriptions();
    const row = rows.find((r) => r.subscriptionId === subscriptionId);
    expect(row?.canRenew).toBe(false);
    expect(row?.renewDisabledReason).toMatch(/can't be renewed/i);
  });

  it("marks canRenew false with a no-payment reason for an eligible-status subscription with no verified payment", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    const rows = await listPlatformSubscriptions();
    const row = rows.find((r) => r.subscriptionId === subscriptionId);
    expect(row?.canRenew).toBe(false);
    expect(row?.renewDisabledReason).toMatch(/no verified payment/i);
  });

  it("marks canRenew true once a verified, unconsumed payment exists", async () => {
    const subscriptionId = await createSubscription({ status: "active", endsAt: new Date() });
    await createPayment({ subscriptionId, status: "verified" });
    const rows = await listPlatformSubscriptions();
    const row = rows.find((r) => r.subscriptionId === subscriptionId);
    expect(row?.canRenew).toBe(true);
    expect(row?.renewDisabledReason).toBeNull();
  });
});
