import Redis, { type RedisOptions } from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createLogThrottle, errorSummary } from "@/lib/workers/log-throttle";

// The application's Redis client: rate limits (lib/rate-limit.ts) and the
// health check. Two requirements pull in opposite directions:
//
// 1. A request must never hang on Redis. Every command is bounded by
//    `commandTimeout`, which ioredis arms when the command is issued, so it
//    also covers time spent queued while the client is (re)connecting. The
//    sign-in limiters fail closed (SEC-M-03), so during an outage a sign-in
//    is refused within a few seconds instead of waiting.
//
// 2. The client must come back on its own. It used to stop reconnecting
//    after 3 attempts (`retryStrategy` returning null), which left it closed
//    for the life of the process after any blip, and with fail-closed sign-in
//    that meant no one could sign in until the app was restarted. It now
//    retries forever with a capped backoff.
//
// The offline queue stays enabled on purpose: with `lazyConnect`, the first
// command after start-up is issued while the connection is still being
// opened, and disabling the queue would reject it outright. Queued commands
// are still bounded by `commandTimeout`, and `maxRetriesPerRequest` flushes
// the queue with an error every other reconnect attempt, so nothing piles up
// during a long outage.
//
// lazyConnect: importing this module (e.g. transitively, at build time via
// static page generation) must not itself open a connection — only the
// first actual command should.
//
// Performance pass — same `next dev` hot-reload leak as lib/db/index.ts's
// own Pool (see that file's comment for the full explanation): without a
// `globalThis` guard, every file edit during development re-evaluates this
// module and opens a brand new client instead of reusing one.
declare global {
  var __redisClient: Redis | undefined;
}

/** Longest wait between reconnect attempts. */
export const REDIS_MAX_RECONNECT_DELAY_MS = 5_000;

/** Reconnect backoff: 200 ms, 400 ms, ... capped at 5 s. Never gives up. */
export function appRedisRetryDelay(attempt: number): number {
  return Math.min(Math.max(1, attempt) * 200, REDIS_MAX_RECONNECT_DELAY_MS);
}

export function appRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    // Remote TLS Redis (e.g. Upstash) can take ~2 s to connect; a request
    // doesn't wait this long anyway, because commandTimeout fires first.
    connectTimeout: 5_000,
    commandTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: appRedisRetryDelay,
  };
}

const errorLogThrottle = createLogThrottle(60_000);

/** Builds a client with the application's settings. Exported for tests. */
export function createAppRedisClient(url: string): Redis {
  const client = new Redis(url, appRedisOptions());
  // Without a listener, ioredis prints "Unhandled error event" on every
  // failed reconnect attempt. Log it once a minute per message instead.
  client.on("error", (err: unknown) => {
    const message = errorSummary(err);
    const suppressed = errorLogThrottle.admit("redis", message);
    if (suppressed !== null) logger.warn("redis.connection_error", { error: message, suppressedRepeats: suppressed });
  });
  return client;
}

export const redis = globalThis.__redisClient ?? createAppRedisClient(env.REDIS_URL);

if (process.env.NODE_ENV !== "production") {
  globalThis.__redisClient = redis;
}
