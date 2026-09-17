import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  notifications,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { enqueueNotification } from "./notifications";
import { notificationQueue } from "./queue";
import { processNotificationJob, sendEmail, sendSms, type MinimalNotificationJob } from "./worker";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `notifications-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(smsEnabled = false): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Notifications Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
      smsEnabled,
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

async function createAcademy(creatorUserId: string, smsEnabled = false): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Notifications Test Academy ${randomUUID()}`,
      slug: `notifications-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);

  const planId = await createPlan(smsEnabled);
  await db.insert(academySubscriptions).values({
    academyId: academy.id,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: creatorUserId,
  });

  return academy.id;
}

afterEach(async () => {
  if (createdAcademyIds.length > 0) {
    await db.delete(notifications).where(or(...createdAcademyIds.map((id) => eq(notifications.academyId, id))));
  }
});

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await db.delete(notifications).where(eq(notifications.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await notificationQueue.close();
});

describe("enqueueNotification", () => {
  it("always creates in_app and email rows, and skips sms when the plan has it disabled", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const entityId = randomUUID();

    const results = await enqueueNotification({
      eventType: "result.published",
      entityId,
      templateId: "result.published",
      academyId,
      userId: creatorUserId,
    });

    const channels = results.map((r) => r.channel).sort();
    expect(channels).toEqual(["email", "in_app"]);
    expect(results.every((r) => r.alreadyEnqueued === false)).toBe(true);

    const rows = await db.select().from(notifications).where(eq(notifications.academyId, academyId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.eventType === "result.published")).toBe(true);
    expect(rows.every((r) => r.templateId === "result.published")).toBe(true);
  });

  it("also creates an sms row when the academy's current plan has sms_enabled", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, true);
    const entityId = randomUUID();

    const results = await enqueueNotification({
      eventType: "certificate.issued",
      entityId,
      templateId: "certificate.issued",
      academyId,
      userId: creatorUserId,
    });

    const channels = results.map((r) => r.channel).sort();
    expect(channels).toEqual(["email", "in_app", "sms"]);
  });

  it("never enqueues sms for a platform-level notification with no academyId", async () => {
    const entityId = randomUUID();
    const results = await enqueueNotification({
      eventType: "security.new_device_signin",
      entityId,
      templateId: "security.new_device_signin",
      academyId: null,
      userId: null,
    });

    expect(results.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);

    await db.delete(notifications).where(
      and(eq(notifications.eventType, "security.new_device_signin"), eq(notifications.idempotencyKey, `security.new_device_signin:${entityId}`)),
    );
  });

  it("is idempotent: re-enqueuing the same (eventType, entityId) never duplicates a channel row", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const entityId = randomUUID();
    const input = {
      eventType: "payment.receipt_issued",
      entityId,
      templateId: "payment.receipt_issued" as const,
      academyId,
      userId: creatorUserId,
    };

    const first = await enqueueNotification(input);
    const second = await enqueueNotification(input);

    expect(first.every((r) => r.alreadyEnqueued === false)).toBe(true);
    expect(second.every((r) => r.alreadyEnqueued === true)).toBe(true);
    expect(second.map((r) => r.notificationId).sort()).toEqual(first.map((r) => r.notificationId).sort());

    const rows = await db.select().from(notifications).where(eq(notifications.academyId, academyId));
    expect(rows).toHaveLength(2); // still just in_app + email, never 4
  });

  it("redacts sensitive payload fields the same way lib/redact.ts / audit logs do", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const entityId = randomUUID();

    await enqueueNotification({
      eventType: "academy.suspension",
      entityId,
      templateId: "academy.suspension",
      academyId,
      userId: creatorUserId,
      payload: { reason: "non-payment", token: "super-secret-token", nested: { password: "hunter2" } },
    });

    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.academyId, academyId), eq(notifications.channel, "in_app")));

    const payload = row.payload as Record<string, unknown>;
    expect(payload.reason).toBe("non-payment");
    expect(payload.token).toBe("[REDACTED]");
    expect((payload.nested as Record<string, unknown>).password).toBe("[REDACTED]");
  });

  it("puts academyId explicitly on the enqueued BullMQ job payload (never inferred by the worker)", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const entityId = randomUUID();

    await enqueueNotification({
      eventType: "finance.approval_requested",
      entityId,
      templateId: "finance.approval_requested",
      academyId,
      userId: creatorUserId,
    });

    const job = await notificationQueue.getJob(`finance.approval_requested:${entityId}:email`);
    expect(job).toBeDefined();
    expect(job?.data.academyId).toBe(academyId);
    expect(job?.data.eventType).toBe("finance.approval_requested");
    await job?.remove();
  });

  it("does not enqueue a BullMQ job for a channel that was already enqueued by a prior call", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const entityId = randomUUID();
    const input = {
      eventType: "result.approval_decided",
      entityId,
      templateId: "result.approval_decided" as const,
      academyId,
      userId: creatorUserId,
    };

    await enqueueNotification(input);
    await enqueueNotification(input);

    const job = await notificationQueue.getJob(`result.approval_decided:${entityId}:email`);
    expect(job).toBeDefined();
    await job?.remove();
  });
});

describe("worker — processNotificationJob", () => {
  it("marks a notification 'sent' with sent_at set on a successful send", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const [row] = await db
      .insert(notifications)
      .values({
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        channel: "email",
        templateId: "result.published",
        idempotencyKey: `worker-test:${randomUUID()}`,
      })
      .returning();

    const job: MinimalNotificationJob = {
      name: "sendEmail",
      data: {
        notificationId: row.id,
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        templateId: "result.published",
        payload: null,
      },
      attemptsMade: 0,
    };

    await processNotificationJob(job);

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).not.toBeNull();
  });

  it("leaves status 'pending' with attempt_count recorded on a non-final failed attempt", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const [row] = await db
      .insert(notifications)
      .values({
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        channel: "email",
        templateId: "result.published",
        idempotencyKey: `worker-test:${randomUUID()}`,
      })
      .returning();

    const job: MinimalNotificationJob = {
      name: "unknown-job-name" as never,
      data: {
        notificationId: row.id,
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        templateId: "result.published",
        payload: null,
      },
      attemptsMade: 0,
      opts: { attempts: 6 },
    };

    await expect(processNotificationJob(job)).rejects.toThrow();

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(updated.status).toBe("pending");
    expect(updated.attemptCount).toBe(1);
    expect(updated.lastError).toBeTruthy();
  });

  it("marks status 'failed' permanently once the final allowed attempt fails", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId, false);
    const [row] = await db
      .insert(notifications)
      .values({
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        channel: "email",
        templateId: "result.published",
        idempotencyKey: `worker-test:${randomUUID()}`,
      })
      .returning();

    const job: MinimalNotificationJob = {
      name: "unknown-job-name" as never,
      data: {
        notificationId: row.id,
        academyId,
        userId: creatorUserId,
        eventType: "result.published",
        templateId: "result.published",
        payload: null,
      },
      attemptsMade: 5,
      opts: { attempts: 6 },
    };

    await expect(processNotificationJob(job)).rejects.toThrow();

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(updated.status).toBe("failed");
    expect(updated.attemptCount).toBe(6);
  });

  it("sendEmail/sendSms stubs resolve without throwing", async () => {
    const data = {
      notificationId: randomUUID(),
      academyId: null,
      userId: null,
      eventType: "result.published",
      templateId: "result.published",
      payload: null,
    };
    await expect(sendEmail(data)).resolves.toBeUndefined();
    await expect(sendSms(data)).resolves.toBeUndefined();
  });
});
