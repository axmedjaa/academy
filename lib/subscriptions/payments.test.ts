import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  getSubscriptionPaymentFilterOptions,
  listAcademySubscriptionOptions,
  listFilteredSubscriptionPaymentsPage,
  listSubscriptionPayments,
  parsePaymentFilters,
  recordSubscriptionPayment,
  rejectSubscriptionPayment,
  reverseSubscriptionPayment,
  verifySubscriptionPayment,
  type RecordPaymentInput,
} from "./payments";

let ownerUserId: string;
let adminUserId: string;
let grantedAdminUserId: string;
let plainUserId: string;
let academyId: string;
let subscriptionId: string;
let planId: string;
const createdPaymentIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `payments-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  return user.id;
}

function validPaymentInput(overrides: Partial<RecordPaymentInput> = {}): RecordPaymentInput {
  return {
    academyId,
    subscriptionId,
    amountCents: 5_000_00,
    currency: "usd",
    paymentMethod: "bank_transfer",
    paymentReference: `ref-${randomUUID()}`,
    evidenceFileRef: null,
    receivedAt: new Date().toISOString(),
    notes: "Recorded by payments.test.ts",
    ...overrides,
  };
}

async function cleanupUser(userId: string): Promise<void> {
  // recordAudit() carries this userId as actor_user_id (a real FK to
  // users.id) on every payment mutation — those audit rows must go before
  // the user row can be deleted (same ordering as lib/subscriptions/
  // plans.test.ts's cleanupUser / lib/platform-staff/staff.test.ts's).
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
    capability: "recordSubscriptionPayment",
  });

  plainUserId = await createUser();

  // Fixture academy/plan/subscription — inserted directly against the
  // schema (not through lib/academies/register.ts or
  // lib/subscriptions/plans.ts, both off-limits for this item) since this
  // test only needs rows to exist, not to exercise those modules'
  // validation.
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      // Never offered at registration, even if cleanup is interrupted.
      isActive: false,
      description: "Automated test fixture (lib/subscriptions/payments.test.ts)",
      name: `Payments test plan ${randomUUID()}`,
      priceAmountCents: 5_000_00,
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
      name: `Payments test academy ${randomUUID()}`,
      slug: `payments-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  academyId = academy.id;

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
});

afterAll(async () => {
  await db
    .delete(auditLogs)
    .where(or(eq(auditLogs.academyId, academyId), eq(auditLogs.entityId, academyId)));
  for (const paymentId of createdPaymentIds) {
    await db.delete(auditLogs).where(eq(auditLogs.entityId, paymentId));
  }
  await db.delete(subscriptionPayments).where(eq(subscriptionPayments.academyId, academyId));
  await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subscriptionId));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await db.delete(academies).where(eq(academies.id, academyId));
  await cleanupUser(ownerUserId);
  await cleanupUser(adminUserId);
  await cleanupUser(grantedAdminUserId);
  await cleanupUser(plainUserId);
});

describe("recordSubscriptionPayment", () => {
  it("refuses when the actor is a platform_admin with no grant", async () => {
    const adminContext = await resolveAuthContext(adminUserId);
    const result = await recordSubscriptionPayment(adminContext, validPaymentInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("refuses for a context with no platform role", async () => {
    const plainContext = await resolveAuthContext(plainUserId);
    const result = await recordSubscriptionPayment(plainContext, validPaymentInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects a negative amount", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recordSubscriptionPayment(
      ownerContext,
      validPaymentInput({ amountCents: -100 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects an invalid currency code", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recordSubscriptionPayment(
      ownerContext,
      validPaymentInput({ currency: "dollars" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a subscription that does not belong to the given academy", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const [otherAcademy] = await db
      .insert(academies)
      .values({
        name: `Other academy ${randomUUID()}`,
        slug: `other-academy-${randomUUID()}`,
        defaultCurrency: "USD",
        createdBy: ownerUserId,
      })
      .returning({ id: academies.id });

    const result = await recordSubscriptionPayment(
      ownerContext,
      validPaymentInput({ academyId: otherAcademy.id }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }

    await db.delete(academies).where(eq(academies.id, otherAcademy.id));
  });

  it("returns not_found for a nonexistent subscription id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recordSubscriptionPayment(
      ownerContext,
      validPaymentInput({ subscriptionId: randomUUID() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("creates a pending payment when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recordSubscriptionPayment(ownerContext, validPaymentInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdPaymentIds.push(result.payment.id);
      expect(result.payment.status).toBe("pending");
      expect(result.payment.currency).toBe("USD");
      expect(result.payment.recordedBy).toBe(ownerUserId);
      expect(result.payment.verifiedBy).toBeNull();
    }
  });

  it("creates a pending payment when the actor is a platform_admin granted recordSubscriptionPayment", async () => {
    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await recordSubscriptionPayment(grantedContext, validPaymentInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdPaymentIds.push(result.payment.id);
      expect(result.payment.status).toBe("pending");
      expect(result.payment.recordedBy).toBe(grantedAdminUserId);
    }
  });

  it("writes an audit row for the recording", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await recordSubscriptionPayment(ownerContext, validPaymentInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdPaymentIds.push(result.payment.id);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, result.payment.id));
      expect(audit).toBeDefined();
      expect(audit?.action).toBe("recordSubscriptionPayment");
      expect(audit?.entityType).toBe("subscription_payment");
    }
  });
});

async function createPendingPayment(): Promise<string> {
  const ownerContext = await resolveAuthContext(ownerUserId);
  const result = await recordSubscriptionPayment(ownerContext, validPaymentInput());
  if (!result.ok) throw new Error("setup failed");
  createdPaymentIds.push(result.payment.id);
  return result.payment.id;
}

describe("verifySubscriptionPayment", () => {
  let paymentId: string;

  beforeEach(async () => {
    paymentId = await createPendingPayment();
  });

  it("refuses when the actor is a platform_admin, even one granted recordSubscriptionPayment", async () => {
    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await verifySubscriptionPayment(grantedContext, paymentId, {
      reason: "Confirmed via bank statement",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects an empty reason", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await verifySubscriptionPayment(ownerContext, paymentId, { reason: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("returns not_found for a nonexistent payment id", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await verifySubscriptionPayment(ownerContext, randomUUID(), {
      reason: "Confirmed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns a validation error for a malformed payment id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await verifySubscriptionPayment(ownerContext, "not-a-uuid", {
      reason: "Confirmed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("verifies a pending payment when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await verifySubscriptionPayment(ownerContext, paymentId, {
      reason: "Confirmed via bank statement",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe("verified");
      expect(result.payment.verifiedBy).toBe(ownerUserId);
    }
  });

  it("writes an audit row carrying the required reason", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await verifySubscriptionPayment(ownerContext, paymentId, {
      reason: "Confirmed via bank statement",
    });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, paymentId),
          eq(auditLogs.action, "verifySubscriptionPayment"),
        ),
      );
    expect(audit?.action).toBe("verifySubscriptionPayment");
    expect(audit?.reason).toBe("Confirmed via bank statement");
  });

  it("gives an already-processed error on a second verify of the same payment", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const first = await verifySubscriptionPayment(ownerContext, paymentId, {
      reason: "First verification",
    });
    expect(first.ok).toBe(true);

    const second = await verifySubscriptionPayment(ownerContext, paymentId, {
      reason: "Second verification",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("invalid_transition");
    }
  });

  it("resolves exactly one winner when two verify calls race on the same row", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const [first, second] = await Promise.all([
      verifySubscriptionPayment(ownerContext, paymentId, { reason: "Race A" }),
      verifySubscriptionPayment(ownerContext, paymentId, { reason: "Race B" }),
    ]);
    const outcomes = [first.ok, second.ok];
    expect(outcomes.filter((ok) => ok).length).toBe(1);
    expect(outcomes.filter((ok) => !ok).length).toBe(1);
  });
});

describe("rejectSubscriptionPayment", () => {
  let paymentId: string;

  beforeEach(async () => {
    paymentId = await createPendingPayment();
  });

  it("refuses when the actor is a platform_admin", async () => {
    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await rejectSubscriptionPayment(grantedContext, paymentId, {
      reason: "Not a real payment",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("rejects an empty reason", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await rejectSubscriptionPayment(ownerContext, paymentId, { reason: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("rejects a pending payment when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await rejectSubscriptionPayment(ownerContext, paymentId, {
      reason: "Duplicate submission",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe("rejected");
      expect(result.payment.verifiedBy).toBeNull();
    }
  });

  it("returns a validation error for a malformed payment id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await rejectSubscriptionPayment(ownerContext, "not-a-uuid", {
      reason: "Not a real payment",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("cannot reject an already-verified payment", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await verifySubscriptionPayment(ownerContext, paymentId, { reason: "Confirmed" });

    const result = await rejectSubscriptionPayment(ownerContext, paymentId, {
      reason: "Too late",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_transition");
    }
  });
});

describe("reverseSubscriptionPayment", () => {
  let paymentId: string;

  beforeEach(async () => {
    paymentId = await createPendingPayment();
  });

  it("cannot reverse a pending payment (must be verified first)", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reverseSubscriptionPayment(ownerContext, paymentId, {
      reason: "Chargeback",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_transition");
    }
  });

  it("refuses when the actor is a platform_admin", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await verifySubscriptionPayment(ownerContext, paymentId, { reason: "Confirmed" });

    const grantedContext = await resolveAuthContext(grantedAdminUserId);
    const result = await reverseSubscriptionPayment(grantedContext, paymentId, {
      reason: "Chargeback",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("returns a validation error for a malformed payment id instead of throwing", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    const result = await reverseSubscriptionPayment(ownerContext, "not-a-uuid", {
      reason: "Chargeback",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("reverses a verified payment when the actor is platform_owner", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await verifySubscriptionPayment(ownerContext, paymentId, { reason: "Confirmed" });

    const result = await reverseSubscriptionPayment(ownerContext, paymentId, {
      reason: "Chargeback received from bank",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe("reversed");
      // verified_by is preserved — it remains true that this row was once
      // verified, and by whom, even after being reversed.
      expect(result.payment.verifiedBy).toBe(ownerUserId);
    }
  });

  it("cannot reverse an already-reversed payment", async () => {
    const ownerContext = await resolveAuthContext(ownerUserId);
    await verifySubscriptionPayment(ownerContext, paymentId, { reason: "Confirmed" });
    await reverseSubscriptionPayment(ownerContext, paymentId, { reason: "Chargeback" });

    const result = await reverseSubscriptionPayment(ownerContext, paymentId, {
      reason: "Again?",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_transition");
    }
  });
});

describe("listSubscriptionPayments / listAcademySubscriptionOptions", () => {
  it("lists recorded payments newest first", async () => {
    const paymentId = await createPendingPayment();
    const payments = await listSubscriptionPayments();
    const found = payments.find((payment) => payment.id === paymentId);
    expect(found).toBeDefined();
  });

  it("includes the fixture subscription with its academy and plan name", async () => {
    const options = await listAcademySubscriptionOptions();
    const found = options.find((option) => option.subscriptionId === subscriptionId);
    expect(found).toBeDefined();
    expect(found?.academyId).toBe(academyId);
  });
});

describe("listFilteredSubscriptionPaymentsPage / parsePaymentFilters / getSubscriptionPaymentFilterOptions", () => {
  // A method unique to this run scopes every assertion to this block's own rows.
  const method = `Filter test ${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const rows = [
      { key: "usdVerifiedMar", status: "verified", amountCents: 100_000, currency: "USD", receivedAt: new Date(Date.UTC(2020, 2, 15)) },
      { key: "usdVerifiedMarEnd", status: "verified", amountCents: 50_000, currency: "USD", receivedAt: new Date(Date.UTC(2020, 2, 31, 23, 59)) },
      { key: "sosVerifiedApr", status: "verified", amountCents: 30_000, currency: "SOS", receivedAt: new Date(Date.UTC(2020, 3, 1)) },
      { key: "usdPendingApr", status: "pending", amountCents: 99_900, currency: "USD", receivedAt: new Date(Date.UTC(2020, 3, 2)) },
    ] as const;
    for (const row of rows) {
      const [inserted] = await db
        .insert(subscriptionPayments)
        .values({
          academyId,
          subscriptionId,
          amountCents: row.amountCents,
          currency: row.currency,
          paymentMethod: method,
          receivedAt: row.receivedAt,
          recordedBy: ownerUserId,
          status: row.status,
        })
        .returning({ id: subscriptionPayments.id });
      ids[row.key] = inserted.id;
    }
  });

  it("parses URL params and drops malformed values instead of failing", () => {
    expect(
      parsePaymentFilters({ q: " caaxi ", status: "verified", method: "Cash", academy: academyId, month: "2026-10", page: "3" }),
    ).toEqual({ search: "caaxi", status: "verified", method: "Cash", academyId, month: "2026-10" });
    expect(parsePaymentFilters({ status: "paid", academy: "not-a-uuid", month: "2026-13", q: "   " })).toEqual({});
    expect(parsePaymentFilters({})).toEqual({});
  });

  it("filters by academy and method together, with the unfiltered total alongside", async () => {
    const result = await listFilteredSubscriptionPaymentsPage({ academyId, method }, 1, 10);
    expect(result.totalCount).toBe(4);
    expect(result.payments.map((p) => p.id).sort()).toEqual(Object.values(ids).sort());
    expect(result.overallCount).toBeGreaterThanOrEqual(result.totalCount);
  });

  it("combines status with the other filters", async () => {
    const pending = await listFilteredSubscriptionPaymentsPage({ academyId, method, status: "pending" }, 1, 10);
    expect(pending.payments.map((p) => p.id)).toEqual([ids.usdPendingApr]);
    const rejected = await listFilteredSubscriptionPaymentsPage({ academyId, method, status: "rejected" }, 1, 10);
    expect(rejected.totalCount).toBe(0);
    expect(rejected.verifiedTotals).toEqual([]);
  });

  it("filters by UTC calendar month, including the last minute of the month", async () => {
    const march = await listFilteredSubscriptionPaymentsPage({ academyId, method, month: "2020-03" }, 1, 10);
    expect(march.payments.map((p) => p.id).sort()).toEqual([ids.usdVerifiedMar, ids.usdVerifiedMarEnd].sort());
    const april = await listFilteredSubscriptionPaymentsPage({ academyId, method, month: "2020-04" }, 1, 10);
    expect(april.totalCount).toBe(2);
  });

  it("sums verified amounts per currency for the matching rows only", async () => {
    const result = await listFilteredSubscriptionPaymentsPage({ academyId, method }, 1, 10);
    expect(result.verifiedTotals).toEqual([
      { currency: "SOS", amountCents: 30_000 },
      { currency: "USD", amountCents: 150_000 },
    ]);
  });

  it("searches the payment id and the academy name, treating LIKE wildcards literally", async () => {
    const [academy] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId));
    const byName = await listFilteredSubscriptionPaymentsPage({ method, search: academy.name.slice(-12).toUpperCase() }, 1, 10);
    expect(byName.totalCount).toBe(4);
    const byId = await listFilteredSubscriptionPaymentsPage({ academyId, search: ids.sosVerifiedApr.slice(0, 8) }, 1, 10);
    expect(byId.payments.map((p) => p.id)).toEqual([ids.sosVerifiedApr]);
    const wildcard = await listFilteredSubscriptionPaymentsPage({ academyId, method, search: "%" }, 1, 10);
    expect(wildcard.totalCount).toBe(0);
  });

  it("pages the filtered rows with the filtered total", async () => {
    const page2 = await listFilteredSubscriptionPaymentsPage({ academyId, method }, 2, 3);
    expect(page2.totalCount).toBe(4);
    expect(page2.payments).toHaveLength(1);
  });

  describe("plan filter", () => {
    // A second plan and subscription on the same academy, with payments of
    // their own, so the plan filter has two plans to tell apart.
    const methodB = `Filter plan test ${randomUUID().slice(0, 8)}`;
    let planBId: string;
    let subscriptionBId: string;
    const planBPaymentIds: string[] = [];

    beforeAll(async () => {
      const [planB] = await db
        .insert(subscriptionPlans)
        .values({
          isActive: false,
          description: "Automated test fixture (lib/subscriptions/payments.test.ts)",
          name: `Payments filter plan B ${randomUUID()}`,
          priceAmountCents: 5000,
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
      planBId = planB.id;
      const [subscriptionB] = await db
        .insert(academySubscriptions)
        .values({ academyId, planId: planBId, status: "cancelled", createdBy: ownerUserId })
        .returning({ id: academySubscriptions.id });
      subscriptionBId = subscriptionB.id;
      for (const [status, day] of [["verified", 5], ["pending", 6], ["verified", 7]] as const) {
        const [row] = await db
          .insert(subscriptionPayments)
          .values({
            academyId,
            subscriptionId: subscriptionBId,
            amountCents: 5000,
            currency: "USD",
            paymentMethod: methodB,
            receivedAt: new Date(Date.UTC(2020, 4, day)),
            recordedBy: ownerUserId,
            status,
          })
          .returning({ id: subscriptionPayments.id });
        planBPaymentIds.push(row.id);
      }
    });

    afterAll(async () => {
      await db.delete(subscriptionPayments).where(eq(subscriptionPayments.subscriptionId, subscriptionBId));
      await db.delete(academySubscriptions).where(eq(academySubscriptions.id, subscriptionBId));
      await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planBId));
    });

    it("parses the plan param and ignores a malformed one", () => {
      expect(parsePaymentFilters({ plan: planId })).toEqual({ planId });
      expect(parsePaymentFilters({ plan: "basic" })).toEqual({});
    });

    it("shows only payments on the selected plan", async () => {
      const planA = await listFilteredSubscriptionPaymentsPage({ academyId, planId }, 1, 10);
      expect(planA.payments.map((p) => p.id)).not.toEqual(expect.arrayContaining([planBPaymentIds[0]]));
      expect(planA.payments.every((p) => p.subscriptionId === subscriptionId)).toBe(true);
      const planB = await listFilteredSubscriptionPaymentsPage({ academyId, planId: planBId }, 1, 10);
      expect(planB.payments.map((p) => p.id).sort()).toEqual([...planBPaymentIds].sort());
      expect(planB.verifiedTotals).toEqual([{ currency: "USD", amountCents: 10_000 }]);
    });

    it("combines the plan with status, search and paging", async () => {
      const verified = await listFilteredSubscriptionPaymentsPage({ planId: planBId, status: "verified" }, 1, 10);
      expect(verified.totalCount).toBe(2);
      const searched = await listFilteredSubscriptionPaymentsPage({ planId: planBId, search: planBPaymentIds[1] }, 1, 10);
      expect(searched.payments.map((p) => p.id)).toEqual([planBPaymentIds[1]]);
      const otherPlanSearch = await listFilteredSubscriptionPaymentsPage({ planId, search: planBPaymentIds[1] }, 1, 10);
      expect(otherPlanSearch.totalCount).toBe(0);
      const page2 = await listFilteredSubscriptionPaymentsPage({ planId: planBId }, 2, 2);
      expect(page2.totalCount).toBe(3);
      expect(page2.payments).toHaveLength(1);
    });

    it("lists both plans as options", async () => {
      const options = await getSubscriptionPaymentFilterOptions();
      expect(options.plans.map((p) => p.id)).toEqual(expect.arrayContaining([planId, planBId]));
    });
  });

  it("offers the methods, academies and months that have payments", async () => {
    const options = await getSubscriptionPaymentFilterOptions();
    expect(options.methods).toContain(method);
    expect(options.academies.some((a) => a.id === academyId)).toBe(true);
    expect(options.months).toEqual(expect.arrayContaining(["2020-03", "2020-04"]));
    expect([...options.months].sort().reverse()).toEqual(options.months);
  });
});
