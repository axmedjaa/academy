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
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1000)),
});

