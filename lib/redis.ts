import Redis from "ioredis";
import { env } from "@/lib/env";

// lazyConnect: importing this module (e.g. transitively, at build time via
// static page generation) must not itself open a connection — only the
// first actual command should.
//
// ioredis's defaults retry a failed connection forever, which would hang
// any caller (e.g. signIn's rate-limit check) indefinitely during a Redis
// outage. Bounding retries here means a command fails fast with a normal
// error instead — callers (lib/rate-limit.ts) decide how to handle that.
//
// Performance pass — same `next dev` hot-reload leak as lib/db/index.ts's
// own Pool (see that file's comment for the full explanation): without a
// `globalThis` guard, every file edit during development re-evaluates this
// module and opens a brand new client instead of reusing one.
declare global {
  var __redisClient: Redis | undefined;
}

export const redis =
  globalThis.__redisClient ??
  new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1000)),
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__redisClient = redis;
}

