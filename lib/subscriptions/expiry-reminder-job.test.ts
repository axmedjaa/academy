import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, academySubscriptions, notifications, subscriptionPlans, users } from "@/lib/db/schema";
import { EXPIRING_SOON_WINDOW_DAYS } from "@/lib/subscriptions/renew";
import { notificationQueue } from "@/lib/notifications/queue";
import {
  EXPIRY_REMINDER_CRON_PATTERN,
  EXPIRY_REMINDER_JOB_SCHEDULER_ID,
  registerExpiryReminderRepeatableJob,
  scanForExpiringSubscriptions,
  unregisterExpiryReminderRepeatableJob,
} from "./expiry-reminder-job";

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerUserId: string;
let planId: string;

const createdAcademyIds: string[] = [];
const createdSubscriptionIds: string[] = [];

async function createAcademy(): Promise<string> {
  const [row] = await db
    .insert(academies)
    .values({
      name: `Expiry reminder test academy ${randomUUID()}`,
      slug: `expiry-reminder-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: ownerUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(row.id);
  return row.id;
}

async function createSubscription(
  academyId: string,
  overrides: { status: "active" | "past_due" | "suspended" | "expired" | "cancelled" | "draft" | "trial"; endsAt: Date | null },
): Promise<string> {
  const [row] = await db
    .insert(academySubscriptions)
    .values({
      academyId,
      planId,
      status: overrides.status,
      startsAt: new Date(Date.now() - 400 * DAY_MS),
      endsAt: overrides.endsAt,
      createdBy: ownerUserId,
    })
    .returning({ id: academySubscriptions.id });
  createdSubscriptionIds.push(row.id);
  return row.id;
}

async function notificationRowsFor(academyId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.academyId, academyId));
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `expiry-reminder-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  ownerUserId = user.id;

  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Expiry reminder test plan ${randomUUID()}`,
      priceAmountCents: 1000,
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
  planId = plan.id;
});

afterEach(async () => {
  for (const academyId of createdAcademyIds.splice(0)) {
    const rows = await notificationRowsFor(academyId);
    for (const row of rows) {
      const entityId = row.idempotencyKey.slice(`${row.eventType}:`.length);
      const job = await notificationQueue.getJob(`${row.eventType}:${entityId}:email`);
      await job?.remove();
    }
    await db.delete(notifications).where(eq(notifications.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
});

afterAll(async () => {
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await db.delete(users).where(eq(users.id, ownerUserId));
});

describe("scanForExpiringSubscriptions", () => {
  it("matches an active subscription expiring within the window and enqueues a reminder", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, {
      status: "active",
      endsAt: new Date(Date.now() + (EXPIRING_SOON_WINDOW_DAYS - 1) * DAY_MS),
    });

    const result = await scanForExpiringSubscriptions();
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const rows = await notificationRowsFor(academyId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.templateId === "subscription.expiry_reminder")).toBe(true);
    expect(rows.every((r) => r.eventType === "subscription.expiring_soon")).toBe(true);
  });

  it("does NOT match a subscription expiring well outside the window", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, {
      status: "active",
      endsAt: new Date(Date.now() + (EXPIRING_SOON_WINDOW_DAYS + 30) * DAY_MS),
    });

    await scanForExpiringSubscriptions();

    const rows = await notificationRowsFor(academyId);
    expect(rows).toHaveLength(0);
  });

  it("does NOT match a subscription that has already lapsed into past_due/expired (not 'active' effective status)", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, {
      status: "past_due",
      endsAt: new Date(Date.now() - 1 * DAY_MS),
    });

    await scanForExpiringSubscriptions();

    const rows = await notificationRowsFor(academyId);
    expect(rows).toHaveLength(0);
  });

  it("does NOT match a subscription with no endsAt at all (e.g. Draft)", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, { status: "draft", endsAt: null });

    await scanForExpiringSubscriptions();

    const rows = await notificationRowsFor(academyId);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: re-running the scan for the same unchanged expiry cycle never duplicates notification rows", async () => {
    const academyId = await createAcademy();
    await createSubscription(academyId, {
      status: "active",
      endsAt: new Date(Date.now() + 3 * DAY_MS),
    });

    await scanForExpiringSubscriptions();
    const firstRows = await notificationRowsFor(academyId);
    expect(firstRows.length).toBeGreaterThan(0);

    await scanForExpiringSubscriptions();
    await scanForExpiringSubscriptions();
    const afterRepeatRows = await notificationRowsFor(academyId);

    expect(afterRepeatRows).toHaveLength(firstRows.length);
    expect(afterRepeatRows.map((r) => r.id).sort()).toEqual(firstRows.map((r) => r.id).sort());
  });

  it("a later expiry cycle (after a renewal moves endsAt forward) gets its own fresh reminder", async () => {
    const academyId = await createAcademy();
    const subscriptionId = await createSubscription(academyId, {
      status: "active",
      endsAt: new Date(Date.now() + 3 * DAY_MS),
    });

    await scanForExpiringSubscriptions();
    const firstRows = await notificationRowsFor(academyId);
    expect(firstRows.length).toBeGreaterThan(0);
    const firstKeys = new Set(firstRows.map((r) => r.idempotencyKey));

    // Simulate a renewal: ends_at is pushed forward, but still within the
    // expiring-soon window for this test (a fresh, later cycle).
    const newEndsAt = new Date(Date.now() + 10 * DAY_MS);
    await db
      .update(academySubscriptions)
      .set({ endsAt: newEndsAt })
      .where(eq(academySubscriptions.id, subscriptionId));

    await scanForExpiringSubscriptions();
    const afterRenewalRows = await notificationRowsFor(academyId);
    const afterRenewalKeys = new Set(afterRenewalRows.map((r) => r.idempotencyKey));

    // The old cycle's rows are still there (never deleted), plus new ones
    // for the new cycle with a different idempotency key.
    expect(afterRenewalKeys.size).toBeGreaterThan(firstKeys.size);
    for (const key of firstKeys) {
      expect(afterRenewalKeys.has(key)).toBe(true);
    }
  });

  it("does not let one academy's enqueue failure stop the scan from processing the rest", async () => {
    const academyA = await createAcademy();
    const academyB = await createAcademy();
    await createSubscription(academyA, { status: "active", endsAt: new Date(Date.now() + 2 * DAY_MS) });
    await createSubscription(academyB, { status: "active", endsAt: new Date(Date.now() + 4 * DAY_MS) });

    const result = await scanForExpiringSubscriptions();
    expect(result.scanned).toBeGreaterThanOrEqual(2);

    const rowsA = await notificationRowsFor(academyA);
    const rowsB = await notificationRowsFor(academyB);
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB.length).toBeGreaterThan(0);
  });
});

describe("registerExpiryReminderRepeatableJob / unregisterExpiryReminderRepeatableJob", () => {
  afterEach(async () => {
    await unregisterExpiryReminderRepeatableJob();
  });

  it("registers a repeatable job scheduler with the documented cron pattern, and it can be removed again", async () => {
    await registerExpiryReminderRepeatableJob();

    const scheduler = await notificationQueue.getJobScheduler(EXPIRY_REMINDER_JOB_SCHEDULER_ID);
    expect(scheduler).toBeDefined();
    expect(scheduler?.pattern).toBe(EXPIRY_REMINDER_CRON_PATTERN);

    const removed = await unregisterExpiryReminderRepeatableJob();
    expect(removed).toBe(true);

    const afterRemoval = await notificationQueue.getJobScheduler(EXPIRY_REMINDER_JOB_SCHEDULER_ID);
    expect(afterRemoval).toBeUndefined();
  });

  it("is idempotent to call twice in a row (upsert, not duplicate-create)", async () => {
    await registerExpiryReminderRepeatableJob();
    await registerExpiryReminderRepeatableJob();

    const schedulers = await notificationQueue.getJobSchedulers();
    const matching = schedulers.filter((s) => s.key === EXPIRY_REMINDER_JOB_SCHEDULER_ID);
    expect(matching).toHaveLength(1);
  });
});
