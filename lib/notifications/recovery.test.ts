/**
 * Outbox recovery (deployment readiness R1). Runs against TEST_DATABASE_URL
 * with a fake job adder — no Redis. Rows are dated in 2001 and `now` is
 * pinned beside them, so the pass only ever sees this file's own rows.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { NotificationQueueUnavailableError } from "./queue";
import { requeuePendingNotifications, type JobAdder } from "./recovery";

const ids: string[] = [];
const MINUTE = 60_000;
// A unique instant in 2001 for this run.
const base = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 300 * 24 * 60) * MINUTE);
const now = new Date(base.getTime() + 10 * MINUTE);
const options = { olderThanMs: 2 * MINUTE, maxAgeMs: 60 * MINUTE, batchSize: 50 };

async function row(values: { channel: "email" | "sms" | "in_app"; status: "pending" | "sent" | "failed"; ageMinutes: number }) {
  const key = `recovery-test:${randomUUID()}`;
  const [r] = await db
    .insert(notifications)
    .values({
      academyId: null,
      userId: null,
      eventType: "recovery.test",
      channel: values.channel,
      templateId: "security.new_device_signin",
      status: values.status,
      idempotencyKey: key,
      createdAt: new Date(now.getTime() - values.ageMinutes * MINUTE),
    })
    .returning();
  ids.push(r.id);
  return r;
}

function recordingAdder() {
  const calls: { name: string; notificationId: string; jobId: string }[] = [];
  const add: JobAdder = async (name, data, opts) => {
    calls.push({ name, notificationId: data.notificationId, jobId: opts.jobId });
  };
  return { add, calls };
}

afterAll(async () => {
  if (ids.length) await db.delete(notifications).where(inArray(notifications.id, ids));
});

describe("requeuePendingNotifications", () => {
  it("queues only old-enough pending email/SMS rows, under their original job ids", async () => {
    const stuckEmail = await row({ channel: "email", status: "pending", ageMinutes: 5 });
    const stuckSms = await row({ channel: "sms", status: "pending", ageMinutes: 6 });
    const tooFresh = await row({ channel: "email", status: "pending", ageMinutes: 1 });
    const tooOld = await row({ channel: "email", status: "pending", ageMinutes: 90 });
    const alreadySent = await row({ channel: "email", status: "sent", ageMinutes: 5 });
    const terminal = await row({ channel: "email", status: "failed", ageMinutes: 5 });
    const inApp = await row({ channel: "in_app", status: "pending", ageMinutes: 5 });

    const { add, calls } = recordingAdder();
    const result = await requeuePendingNotifications(options, { add, executor: db, now });

    const queued = calls.map((c) => c.notificationId).sort();
    expect(queued).toEqual([stuckEmail.id, stuckSms.id].sort());
    for (const skipped of [tooFresh, tooOld, alreadySent, terminal, inApp]) expect(queued).not.toContain(skipped.id);
    expect(calls.find((c) => c.notificationId === stuckEmail.id)).toMatchObject({ name: "sendEmail", jobId: `${stuckEmail.idempotencyKey}:email` });
    expect(calls.find((c) => c.notificationId === stuckSms.id)).toMatchObject({ name: "sendSms", jobId: `${stuckSms.idempotencyKey}:sms` });
    expect(result).toMatchObject({ found: 2, requeued: 2, stoppedEarly: false });
  });

  it("is safe to repeat: the same job ids are produced again (BullMQ ignores duplicates)", async () => {
    const { add: first, calls: a } = recordingAdder();
    const { add: second, calls: b } = recordingAdder();
    await requeuePendingNotifications(options, { add: first, executor: db, now });
    await requeuePendingNotifications(options, { add: second, executor: db, now });
    expect(b.map((c) => c.jobId).sort()).toEqual(a.map((c) => c.jobId).sort());
  });

  it("stops early, without throwing, while Redis is still unavailable", async () => {
    const add: JobAdder = async () => {
      throw new NotificationQueueUnavailableError("connect ECONNREFUSED");
    };
    const result = await requeuePendingNotifications(options, { add, executor: db, now });
    expect(result).toMatchObject({ requeued: 0, stoppedEarly: true });
  });

  it("skips a single bad row and carries on with the rest", async () => {
    let calls = 0;
    const add: JobAdder = async () => {
      calls += 1;
      if (calls === 1) throw new Error("unexpected");
    };
    const result = await requeuePendingNotifications(options, { add, executor: db, now });
    expect(result.found).toBeGreaterThanOrEqual(2);
    expect(result.requeued).toBe(result.found - 1);
    expect(result.stoppedEarly).toBe(false);
  });
});
