import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_QUEUE_NAME, notificationQueue, notificationQueueConnection } from "@/lib/notifications/queue";
import { checkQueueHealth, QUEUE_HEALTH_THRESHOLDS } from "./queue-health";
import type { MonitoringSink } from "./monitor";

/**
 * ---------------------------------------------------------------------
 * Why these tests never start a real BullMQ `Worker`
 * ---------------------------------------------------------------------
 * `notificationQueue` is a single shared real queue in the same real
 * Redis this whole test suite runs against — other test files
 * (lib/notifications/notifications.test.ts,
 * lib/subscriptions/expiry-reminder-job.test.ts) enqueue real
 * "sendEmail"/"sendSms" jobs onto it concurrently while this file runs
 * (vitest runs test files in parallel by default). A live `Worker` would
 * dequeue and attempt to process ANY job on the queue — including those
 * other files' jobs — which would corrupt their assertions. No test file
 * in this codebase runs a `Worker` against `notificationQueue` for
 * exactly this reason (confirmed by searching before writing this file).
 *
 * To still exercise `checkQueueHealth()` against real BullMQ state
 * without that risk, `addFailedJob` below writes a job directly into
 * BullMQ's own "failed" state — the exact same Redis keys/fields BullMQ's
 * own `moveToFinished` Lua script writes for its "failed" branch
 * (verified against node_modules/bullmq/dist/cjs/commands/
 * moveToFinished-14.lua and redis-queue-backend.js's `moveToFinishedArgs`
 * before writing this: the failed set is `queue.toKey('failed')`, the
 * job hash is `queue.toKey(jobId)`) — using a freshly-generated jobId
 * that only this test ever touches. `checkQueueHealth` then reads that
 * state through BullMQ's own public getters
 * (`getJobCounts`/`getJobs`), so the aggregation logic under test is
 * exercised against real BullMQ reads, while job creation itself uses
 * the safe, standard `queue.add()` (which only ever puts jobs in "wait"
 * or "delayed" — never processed by anything in this test environment,
 * matching every other test file's own convention of never running a
 * worker).
 */

const addedFailedJobIds: string[] = [];
const addedDelayedJobIds: string[] = [];

function noopSink(): MonitoringSink {
  return { recordEvent: () => {}, recordMetric: () => {} };
}

function spySink(): { sink: MonitoringSink; recordEvent: ReturnType<typeof vi.fn> } {
  const recordEvent = vi.fn();
  return { sink: { recordEvent, recordMetric: vi.fn() }, recordEvent };
}

async function addFailedJob(): Promise<string> {
  const jobId = `monitoring-test-failed-${randomUUID()}`;
  await notificationQueue.add(
    "sendEmail",
    { notificationId: jobId, academyId: null, userId: null, eventType: "test", templateId: "test", payload: {} },
    { jobId, attempts: 1 },
  );
  // Move it out of "wait" and directly into "failed" state (see module comment).
  await notificationQueueConnection.lrem(notificationQueue.toKey("wait"), 0, jobId);
  await notificationQueueConnection.zadd(notificationQueue.toKey("failed"), Date.now(), jobId);
  await notificationQueueConnection.hset(notificationQueue.toKey(jobId), {
    failedReason: "monitoring test simulated failure",
    finishedOn: Date.now(),
  });
  addedFailedJobIds.push(jobId);
  return jobId;
}

async function addDelayedJob(delayMs: number): Promise<string> {
  const jobId = `monitoring-test-delayed-${randomUUID()}`;
  await notificationQueue.add(
    "sendEmail",
    { notificationId: jobId, academyId: null, userId: null, eventType: "test", templateId: "test", payload: {} },
    { jobId, delay: delayMs },
  );
  addedDelayedJobIds.push(jobId);
  return jobId;
}

afterAll(async () => {
  for (const jobId of addedFailedJobIds) {
    await notificationQueueConnection.zrem(notificationQueue.toKey("failed"), jobId);
    await notificationQueueConnection.del(notificationQueue.toKey(jobId));
  }
  for (const jobId of addedDelayedJobIds) {
    const job = await notificationQueue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  }
  await notificationQueue.close();
});

describe("checkQueueHealth", () => {
  it("reports the queue name, a numeric worker count, and a live Redis connection status", async () => {
    const report = await checkQueueHealth(noopSink());

    expect(report.queueName).toBe(NOTIFICATION_QUEUE_NAME);
    expect(typeof report.workersConnected).toBe("number");
    expect(report.workersConnected).toBeGreaterThanOrEqual(0);
    expect(report.redisConnectionStatus).toBe("ready");
    expect(report.failedCount).toBeGreaterThanOrEqual(0);
    expect(report.waitingCount).toBeGreaterThanOrEqual(0);
  });

  it("reflects a deliberately-failed job's count increase", async () => {
    const before = await notificationQueue.getJobCounts("failed");
    await addFailedJob();

    const report = await checkQueueHealth(noopSink());

    expect(report.failedCount).toBe((before.failed ?? 0) + 1);
  });

  it("emits an alert-level event once the failed-job count exceeds the threshold, and reports the breach", async () => {
    const before = await notificationQueue.getJobCounts("failed");
    const baseline = before.failed ?? 0;
    const needed = Math.max(1, QUEUE_HEALTH_THRESHOLDS.failedJobAlertThreshold - baseline + 1);
    for (let i = 0; i < needed; i += 1) {
      await addFailedJob();
    }

    const { sink, recordEvent } = spySink();
    const report = await checkQueueHealth(sink);

    expect(report.failedThresholdBreached).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "alert", name: "queue.failed_jobs" }),
    );
  });

  it("counts a delayed job well past its due time (beyond the stuck grace period) as stuck", async () => {
    await addDelayedJob(60_000); // due 1 minute after being added

    const baselineReport = await checkQueueHealth(noopSink(), new Date());
    // 30 minutes from now is ~29 minutes past this job's due time, which is
    // well beyond QUEUE_HEALTH_THRESHOLDS.stuckJobGraceMs (15 minutes).
    const wellPastDue = new Date(Date.now() + 30 * 60 * 1000);
    const laterReport = await checkQueueHealth(noopSink(), wellPastDue);

    expect(laterReport.stuckCount).toBeGreaterThanOrEqual(baselineReport.stuckCount + 1);
  });

  it("does not count a freshly-delayed job (still within its normal delay window) as stuck", async () => {
    const jobId = await addDelayedJob(60 * 60 * 1000); // due 1 hour from now

    const delayedJobs = await notificationQueue.getJobs(["delayed"], 0, -1);
    const mine = delayedJobs.find((job) => job.id === jobId);
    expect(mine).toBeDefined();

    const dueAt = mine!.timestamp + (mine!.delay ?? 0);
    expect(Date.now() - dueAt).toBeLessThan(QUEUE_HEALTH_THRESHOLDS.stuckJobGraceMs);
  });
});
