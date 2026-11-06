import Redis, { type RedisOptions } from "ioredis";
import { Queue, type JobsOptions } from "bullmq";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { withTimeout } from "@/lib/with-timeout";
import { createLogThrottle } from "@/lib/workers/log-throttle";

/**
 * PLAN.md Phase 5, Item 58a — BullMQ queues for notifications (and, since
 * Step 2 of deployment readiness, scheduled maintenance jobs).
 *
 * ---------------------------------------------------------------------
 * Connections (deployment-readiness R1)
 * ---------------------------------------------------------------------
 * Two kinds of ioredis connection, never shared with lib/redis.ts's
 * rate-limit client:
 *
 * 1. PRODUCER (this module's lazily-created queues — used by request
 *    handlers to add jobs, and by monitoring to read counts). BullMQ's
 *    `Queue` is non-blocking, so it may use a finite `maxRetriesPerRequest`.
 *    It fails fast: `enableOfflineQueue: false` (no unbounded in-memory
 *    buffering while Redis is down), connect and command timeouts, and every
 *    `add` is additionally bounded by `withTimeout`. A request that triggers
 *    a notification therefore never waits on Redis for more than a few
 *    seconds; the notification row is already in Postgres (the outbox) and
 *    the worker's recovery pass re-queues it once Redis is back.
 *
 *    BullMQ initializes a queue's connection exactly once; if Redis was
 *    unreachable at that moment the queue stays unusable for the life of the
 *    process. So the producer queue is discarded after a failed
 *    initialization and rebuilt on the next use (after a short cooldown that
 *    keeps an outage from turning into a reconnect storm).
 *
 * 2. WORKER (`createWorkerRedisConnection`) — only for BullMQ `Worker`s in
 *    the dedicated worker process (scripts/worker.ts). BullMQ *requires*
 *    `maxRetriesPerRequest: null` there, because its blocking commands must
 *    not time out mid-block. Request handlers never use this connection.
 */

export const NOTIFICATION_QUEUE_NAME = "notifications";
/** Scheduled maintenance jobs (e.g. the daily subscription-expiry scan). */
export const MAINTENANCE_QUEUE_NAME = "maintenance";

/**
 * PLAN.md Phase 5 security considerations: "Retry policy: 5 attempts,
 * exponential backoff (1m, 5m, 15m, 1h, 6h), then marked failed." Read as
 * five retries after the initial try (6 total BullMQ `attempts`), so every
 * listed delay is used: initial try -> 1m -> 5m -> 15m -> 1h -> 6h -> failed.
 */
export const RETRY_BACKOFF_DELAYS_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  21_600_000, // 6h
] as const;

export const NOTIFICATION_JOB_ATTEMPTS = RETRY_BACKOFF_DELAYS_MS.length + 1;

/**
 * Custom backoff matching PLAN.md's literal 1m/5m/15m/1h/6h sequence (not a
 * constant ratio, so BullMQ's builtin exponential strategy can't produce it).
 * `attemptsMade` is 1-based: BullMQ passes the attempt number that just failed.
 */
export function notificationBackoffStrategy(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), RETRY_BACKOFF_DELAYS_MS.length) - 1;
  return RETRY_BACKOFF_DELAYS_MS[index];
}

export type NotificationJobName = "sendEmail" | "sendSms";

/**
 * Jobs carry academy_id explicitly — a worker never infers tenant context
 * from ambient state. `academyId` may be null for platform-level
 * notifications.
 */
export interface NotificationJobData {
  notificationId: string;
  academyId: string | null;
  userId: string | null;
  eventType: string;
  templateId: string;
  payload: unknown;
}

export const NOTIFICATION_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: NOTIFICATION_JOB_ATTEMPTS,
  backoff: { type: "custom" },
  removeOnFail: false,
  removeOnComplete: true,
};

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

export const PRODUCER_CONNECT_TIMEOUT_MS = 2_000;
export const PRODUCER_COMMAND_TIMEOUT_MS = 3_000;
/** How long the producer stays "unavailable" after a failed initialization. */
export const PRODUCER_REBUILD_COOLDOWN_MS = 5_000;

/** Capped reconnect backoff: keeps retrying (so recovery is automatic) without hammering Redis. */
function reconnectDelay(times: number): number {
  return Math.min(times * 500, 5_000);
}

export function producerRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: PRODUCER_CONNECT_TIMEOUT_MS,
    commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS,
    retryStrategy: reconnectDelay,
  };
}

/** For BullMQ Workers only (scripts/worker.ts). Never used by request handlers. */
export function workerRedisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    connectTimeout: 10_000,
    retryStrategy: reconnectDelay,
  };
}

export function createWorkerRedisConnection(url: string = env.REDIS_URL): Redis {
  const connection = new Redis(url, workerRedisOptions());
  // Reconnect attempts repeat the same error; log it at most once a minute.
  const throttle = createLogThrottle(60_000);
  connection.on("error", (err: Error) => {
    const suppressed = throttle.admit("redis", err.message);
    if (suppressed === null) return;
    logger.warn("worker.redis_error", { error: err.message, ...(suppressed ? { repeatsSuppressed: suppressed } : {}) });
  });
  return connection;
}

// ---------------------------------------------------------------------------
// Producer queues (lazy; rebuilt after a failed initialization)
// ---------------------------------------------------------------------------

export class NotificationQueueUnavailableError extends Error {
  constructor(reason: string) {
    super(`Notification queue unavailable: ${reason}`);
    this.name = "NotificationQueueUnavailableError";
  }
}

interface ProducerState<Q> {
  connection: Redis;
  queue: Q;
  ready: Promise<void>;
}

/** Test seam: how producer connections are created. */
export type RedisFactory = (url: string, options: RedisOptions) => Redis;
let redisFactory: RedisFactory = (url, options) => new Redis(url, options);

export function setProducerRedisFactoryForTests(factory: RedisFactory | null): void {
  redisFactory = factory ?? ((url, options) => new Redis(url, options));
}

class ProducerHolder<Q extends Queue> {
  private state: ProducerState<Q> | null = null;
  private rebuildNotBefore = 0;

  constructor(
    private readonly label: string,
    private readonly build: (connection: Redis) => Q,
  ) {}

  private create(): ProducerState<Q> {
    const connection = redisFactory(env.REDIS_URL, producerRedisOptions());
    let reportedError = false;
    connection.on("error", (err: Error) => {
      // One line per connection, not one per reconnect attempt.
      if (reportedError) return;
      reportedError = true;
      logger.warn("queue.producer_redis_error", { queue: this.label, error: err.message });
    });
    const queue = this.build(connection);
    queue.on("error", () => {
      // Surfaced through `ready`/`add` rejections; the listener prevents an
      // unhandled 'error' event from crashing the process.
    });
    const ready = queue.waitUntilReady().then(() => undefined);
    const state: ProducerState<Q> = { connection, queue, ready };
    ready.catch(() => {
      if (this.state === state) this.discard("initialization failed");
    });
    return state;
  }

  /** The live queue, created on first use. Never throws. */
  current(): ProducerState<Q> {
    if (!this.state) this.state = this.create();
    return this.state;
  }

  /** For producers: fails fast during the post-failure cooldown. */
  forProducer(): ProducerState<Q> {
    if (!this.state && Date.now() < this.rebuildNotBefore) {
      throw new NotificationQueueUnavailableError("cooling down after a connection failure");
    }
    return this.current();
  }

  discard(reason: string): void {
    const state = this.state;
    if (!state) return;
    this.state = null;
    this.rebuildNotBefore = Date.now() + PRODUCER_REBUILD_COOLDOWN_MS;
    logger.warn("queue.producer_discarded", { queue: this.label, reason });
    state.queue.close().catch(() => undefined);
    state.connection.disconnect();
  }

  async close(): Promise<void> {
    const state = this.state;
    this.state = null;
    this.rebuildNotBefore = 0;
    if (!state) return;
    await state.queue.close().catch(() => undefined);
    state.connection.disconnect();
  }

  /** Test-only: forget state without touching Redis. */
  resetForTests(): void {
    this.state = null;
    this.rebuildNotBefore = 0;
  }
}

const notificationProducer = new ProducerHolder<Queue<NotificationJobData, void, NotificationJobName>>(
  NOTIFICATION_QUEUE_NAME,
  (connection) =>
    new Queue<NotificationJobData, void, NotificationJobName>(NOTIFICATION_QUEUE_NAME, {
      connection,
      defaultJobOptions: NOTIFICATION_DEFAULT_JOB_OPTIONS,
    }),
);

const maintenanceProducer = new ProducerHolder<Queue>(MAINTENANCE_QUEUE_NAME, (connection) => new Queue(MAINTENANCE_QUEUE_NAME, { connection }));

export function getNotificationQueue(): Queue<NotificationJobData, void, NotificationJobName> {
  return notificationProducer.current().queue;
}

export function getNotificationQueueConnection(): Redis {
  return notificationProducer.current().connection;
}

export function getMaintenanceQueue(): Queue {
  return maintenanceProducer.current().queue;
}

/**
 * Adds a notification job without ever blocking the caller for long.
 * Throws `NotificationQueueUnavailableError` (or a `TimeoutError`) when
 * Redis is unavailable; callers treat that as "deliver later".
 */
export async function addNotificationJob(
  name: NotificationJobName,
  data: NotificationJobData,
  opts: { jobId: string },
): Promise<void> {
  const state = notificationProducer.forProducer();
  try {
    await withTimeout(state.ready, PRODUCER_CONNECT_TIMEOUT_MS + 500, "notification queue connect");
  } catch (err) {
    notificationProducer.discard("connect failed or timed out");
    throw new NotificationQueueUnavailableError(err instanceof Error ? err.message : String(err));
  }
  try {
    await withTimeout(state.queue.add(name, data, opts), PRODUCER_COMMAND_TIMEOUT_MS + 500, "notification queue add");
  } catch (err) {
    throw new NotificationQueueUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

/** Closes the producer queues (worker shutdown, tests). Safe to call repeatedly. */
export async function closeQueueProducers(): Promise<void> {
  await Promise.all([notificationProducer.close(), maintenanceProducer.close()]);
}

export function resetQueueProducersForTests(): void {
  notificationProducer.resetForTests();
  maintenanceProducer.resetForTests();
}

/**
 * Stable handles for existing callers (monitoring, tests): always delegate
 * to the current live producer, so a rebuilt queue is picked up
 * transparently. Importing this module opens no connection — the first
 * property access does.
 */
function liveHandle<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const target = resolve();
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    has(_target, prop) {
      return prop in resolve();
    },
  });
}

export const notificationQueue = liveHandle(getNotificationQueue);
export const notificationQueueConnection = liveHandle(getNotificationQueueConnection);
