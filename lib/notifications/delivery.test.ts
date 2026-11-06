/**
 * Notification delivery in the worker (deployment readiness Step 2). Runs
 * against TEST_DATABASE_URL with an injected email sender — the real
 * provider is never called. Every row created here is removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, notificationPreferences, notifications, users } from "@/lib/db/schema";
import type { SendEmailInput, SendEmailOptions, SendEmailResult } from "@/lib/email/client";
import { TimeoutError } from "@/lib/with-timeout";
import { processNotificationJob, type MinimalNotificationJob, type NotificationDeliveryDeps } from "./worker";

const userIds: string[] = [];
const academyIds: string[] = [];
const notificationIds: string[] = [];

async function createUser(status: "active" | "disabled" = "active") {
  const email = `delivery-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: "fixture", status }).returning({ id: users.id });
  userIds.push(user.id);
  return { id: user.id, email };
}

async function createAcademy(name: string, creatorId: string) {
  const [academy] = await db
    .insert(academies)
    .values({ name, slug: `delivery-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorId })
    .returning({ id: academies.id });
  academyIds.push(academy.id);
  return academy.id;
}

async function createRow(values: { userId: string | null; academyId: string | null; templateId?: string; channel?: "email" | "sms"; status?: "pending" | "sent"; payload?: unknown }) {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: values.userId,
      academyId: values.academyId,
      eventType: "delivery.test",
      channel: values.channel ?? "email",
      templateId: values.templateId ?? "result.published",
      payload: values.payload ?? null,
      status: values.status ?? "pending",
      idempotencyKey: `delivery-test:${randomUUID()}`,
    })
    .returning();
  notificationIds.push(row.id);
  return row;
}

const rowById = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0];

function job(row: { id: string; academyId: string | null; userId: string | null; templateId: string }, overrides: Partial<MinimalNotificationJob> = {}): MinimalNotificationJob {
  return {
    name: "sendEmail",
    data: { notificationId: row.id, academyId: row.academyId, userId: row.userId, eventType: "delivery.test", templateId: row.templateId, payload: null },
    attemptsMade: 0,
    opts: { attempts: 6 },
    ...overrides,
  };
}

function sender(result: SendEmailResult | (() => Promise<SendEmailResult>) = { ok: true }) {
  const calls: { input: SendEmailInput; options: SendEmailOptions }[] = [];
  const deps: NotificationDeliveryDeps = {
    appUrl: "https://app.example.test",
    deliveryTimeoutMs: 5_000,
    sendEmail: async (input, options) => {
      calls.push({ input, options });
      return typeof result === "function" ? result() : result;
    },
  };
  return { deps, calls };
}

afterAll(async () => {
  if (notificationIds.length) await db.delete(notifications).where(inArray(notifications.id, notificationIds));
  if (userIds.length) await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
  if (academyIds.length) await db.delete(academies).where(inArray(academies.id, academyIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

describe("email delivery", () => {
  it("sends once to the row's user with a per-row idempotency key, marks it sent, and never includes payload data", async () => {
    const user = await createUser();
    const academyId = await createAcademy("<b>Hilltop</b> Academy", user.id);
    const row = await createRow({ userId: user.id, academyId, payload: { studentName: "SECRET-STUDENT-NAME", amountCents: 98765 } });
    const { deps, calls } = sender();

    await processNotificationJob(job(row), db, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].input.to).toBe(user.email);
    expect(calls[0].options.idempotencyKey).toBe(`notification-${row.id}`);
    const all = JSON.stringify(calls[0].input);
    expect(all).not.toContain("SECRET-STUDENT-NAME");
    expect(all).not.toContain("98765");
    expect(calls[0].input.html).not.toContain("<b>Hilltop</b>");
    const updated = await rowById(row.id);
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).not.toBeNull();
  });

  it("a duplicate job for a row already sent does not send again", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, status: "sent", templateId: "security.new_device_signin" });
    const { deps, calls } = sender();
    await processNotificationJob(job(row), db, deps);
    expect(calls).toHaveLength(0);
  });

  it("a provider failure is retried: the job throws and the row stays pending with the attempt recorded", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, templateId: "security.new_device_signin" });
    const { deps } = sender({ ok: false, error: "Failed to send email." });
    await expect(processNotificationJob(job(row), db, deps)).rejects.toThrow("email_delivery_failed");
    const updated = await rowById(row.id);
    expect(updated).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  it("the final failed attempt marks the row failed", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, templateId: "security.new_device_signin" });
    const { deps } = sender({ ok: false, error: "Failed to send email." });
    await expect(processNotificationJob(job(row, { attemptsMade: 5 }), db, deps)).rejects.toThrow();
    expect((await rowById(row.id)).status).toBe("failed");
  });

  it("a hung provider call times out and is retried", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, templateId: "security.new_device_signin" });
    const { deps } = sender(() => new Promise<SendEmailResult>(() => undefined));
    deps.deliveryTimeoutMs = 50;
    const error = await processNotificationJob(job(row), db, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((await rowById(row.id)).status).toBe("pending");
  });

  it("without an injected sender, test runs never reach the provider", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, templateId: "security.new_device_signin" });
    await expect(processNotificationJob(job(row))).rejects.toThrow("disabled in tests");
  });
});

describe("not deliverable by design — completed without retries, recorded on the row", () => {
  it("SMS is recorded as unsupported (no provider configured) and nothing is sent", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, channel: "sms", templateId: "security.new_device_signin" });
    const { deps, calls } = sender();
    await expect(processNotificationJob(job(row, { name: "sendSms" }), db, deps)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await rowById(row.id)).toMatchObject({ status: "failed", lastError: "skipped: sms_not_configured" });
  });

  it("shared academy-wide rows (no user) are not emailed", async () => {
    const user = await createUser();
    const academyId = await createAcademy("Shared", user.id);
    const row = await createRow({ userId: null, academyId });
    const { deps, calls } = sender();
    await processNotificationJob(job(row), db, deps);
    expect(calls).toHaveLength(0);
    expect((await rowById(row.id)).lastError).toBe("skipped: no_individual_recipient");
  });

  it("a disabled account is not emailed", async () => {
    const user = await createUser("disabled");
    const row = await createRow({ userId: user.id, academyId: null, templateId: "security.new_device_signin" });
    const { deps, calls } = sender();
    await processNotificationJob(job(row), db, deps);
    expect(calls).toHaveLength(0);
    expect((await rowById(row.id)).lastError).toBe("skipped: recipient_inactive");
  });

  it("respects an opt-out for an optional template, but never for a mandatory one", async () => {
    const user = await createUser();
    const academyId = await createAcademy("Prefs", user.id);
    await db.insert(notificationPreferences).values([
      { userId: user.id, academyId, templateId: "result.published", enabled: false },
      { userId: user.id, academyId, templateId: "academy.suspension", enabled: false },
    ]);

    const optional = await createRow({ userId: user.id, academyId, templateId: "result.published" });
    const mandatory = await createRow({ userId: user.id, academyId, templateId: "academy.suspension" });
    const { deps, calls } = sender();
    await processNotificationJob(job(optional), db, deps);
    await processNotificationJob(job(mandatory), db, deps);

    expect((await rowById(optional.id)).lastError).toBe("skipped: recipient_opted_out");
    expect((await rowById(mandatory.id)).status).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("an unknown template fails permanently (programming error), without sending", async () => {
    const user = await createUser();
    const row = await createRow({ userId: user.id, academyId: null, templateId: "no.such.template" });
    const { deps, calls } = sender();
    const error = await processNotificationJob(job(row), db, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(calls).toHaveLength(0);
    expect((await rowById(row.id)).status).toBe("failed");
  });
});
