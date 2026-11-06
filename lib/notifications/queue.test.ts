/**
 * Deployment readiness R1: the notification producer must never block a
 * request on Redis. Uses real ioredis/BullMQ against deliberately broken
 * local endpoints (a closed port; a socket that accepts but never answers)
 * and, for recovery, the configured REDIS_URL (the same Redis the existing
 * queue tests use). No database access in the producer cases.
 */
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import {
  NotificationQueueUnavailableError,
  PRODUCER_REBUILD_COOLDOWN_MS,
  addNotificationJob,
  closeQueueProducers,
  getNotificationQueue,
  producerRedisOptions,
  resetQueueProducersForTests,
  setProducerRedisFactoryForTests,
  workerRedisOptions,
} from "./queue";
import { enqueueNotification } from "./notifications";

const created: Redis[] = [];
let factoryCalls = 0;

function useRedisAt(url: string) {
  setProducerRedisFactoryForTests((_url: string, options: RedisOptions) => {
    factoryCalls += 1;
    const connection = new Redis(url, options);
    created.push(connection);
    return connection;
  });
}

const jobData = (id = randomUUID()) => ({
  notificationId: id,
  academyId: null,
  userId: null,
  eventType: "test.r1",
  templateId: "result.published",
  payload: null,
});

// A TCP endpoint that accepts connections and never replies (a hung Redis).
let blackhole: Server;
const blackholeSockets: Socket[] = [];
let blackholePort = 0;

beforeAll(async () => {
  blackhole = createServer((socket) => void blackholeSockets.push(socket));
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  blackholePort = (blackhole.address() as { port: number }).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeQueueProducers();
  for (const c of created.splice(0)) c.disconnect();
  setProducerRedisFactoryForTests(null);
  resetQueueProducersForTests();
  factoryCalls = 0;
});

afterAll(async () => {
  for (const s of blackholeSockets) s.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  await db.delete(notifications).where(like(notifications.idempotencyKey, "test.r1.enqueue:%"));
});

describe("connection options", () => {
  it("producer connections fail fast; worker connections are BullMQ-blocking-safe", () => {
    expect(producerRedisOptions()).toMatchObject({ enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
    expect(producerRedisOptions().connectTimeout).toBeGreaterThan(0);
    expect(producerRedisOptions().commandTimeout).toBeGreaterThan(0);
    expect(workerRedisOptions().maxRetriesPerRequest).toBeNull();
  });
});

describe("addNotificationJob when Redis is unavailable", () => {
  it("rejects quickly with NotificationQueueUnavailableError when nothing is listening", async () => {
    useRedisAt("redis://127.0.0.1:1");
    const started = Date.now();
    const error = await addNotificationJob("sendEmail", jobData(), { jobId: `r1-${randomUUID()}` }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationQueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("rejects within the bound when Redis accepts the connection but never answers", async () => {
    useRedisAt(`redis://127.0.0.1:${blackholePort}`);
    const started = Date.now();
    const error = await addNotificationJob("sendEmail", jobData(), { jobId: `r1-${randomUUID()}` }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationQueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);

  it("during the cooldown after a failure, fails immediately without opening another connection", async () => {
    useRedisAt("redis://127.0.0.1:1");
    await addNotificationJob("sendEmail", jobData(), { jobId: `r1-${randomUUID()}` }).catch(() => undefined);
    const callsAfterFirst = factoryCalls;
    const started = Date.now();
    const error = await addNotificationJob("sendEmail", jobData(), { jobId: `r1-${randomUUID()}` }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationQueueUnavailableError);
    expect((error as Error).message).toContain("cooling down");
    expect(Date.now() - started).toBeLessThan(100);
    expect(factoryCalls).toBe(callsAfterFirst);
  });
});

describe("recovery", () => {
  it("after the cooldown, a reachable Redis is used again and jobs are queued", async () => {
    useRedisAt("redis://127.0.0.1:1");
    await addNotificationJob("sendEmail", jobData(), { jobId: `r1-${randomUUID()}` }).catch(() => undefined);

    // Redis is back and the cooldown has passed.
    useRedisAt(process.env.REDIS_URL!);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + PRODUCER_REBUILD_COOLDOWN_MS + 1);

    const jobId = `r1-recovery-${randomUUID()}`;
    await addNotificationJob("sendEmail", jobData(), { jobId });
    const job = await getNotificationQueue().getJob(jobId);
    expect(job?.id).toBe(jobId);
    await job?.remove();
  }, 20_000);
});

describe("enqueueNotification when Redis is down", () => {
  it("returns promptly, never throws, and leaves the email row pending for the recovery pass", async () => {
    useRedisAt("redis://127.0.0.1:1");
    const entityId = randomUUID();
    const started = Date.now();
    const results = await enqueueNotification({ eventType: "test.r1.enqueue", entityId, templateId: "security.new_device_signin", academyId: null, userId: null });
    expect(Date.now() - started).toBeLessThan(5_000);

    const email = results.find((r) => r.channel === "email");
    expect(email?.queued).toBe(false);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, email!.notificationId));
    expect(row.status).toBe("pending");
    // The in-app row is unaffected by the queue.
    expect(results.find((r) => r.channel === "in_app")).toBeDefined();
  });
});
