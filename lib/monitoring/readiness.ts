import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { withTimeout } from "@/lib/with-timeout";

/**
 * Readiness (deployment readiness Step 2): can this app instance serve
 * requests right now?
 *
 * - Database: REQUIRED. Every page and action needs Postgres; without it
 *   the instance is not ready.
 * - Redis: REPORTED, NOT REQUIRED. The app is designed to keep serving
 *   when Redis is down (notifications are queued later from the outbox;
 *   rate limits currently fail open). Failing readiness on Redis would turn
 *   a degraded service into a full outage behind the proxy.
 *   Revisit when SEC-M-03 makes authentication rate limits fail closed —
 *   sign-in will then depend on Redis.
 *
 * Each check is bounded by a timeout so the endpoint itself can't hang.
 * Results are plain "ok"/"error": no connection strings, hosts or error
 * text ever leave the server (details go to the server log only).
 */

export type CheckStatus = "ok" | "error";

export const READINESS_CHECK_TIMEOUT_MS = 2_000;

export interface ReadinessDeps {
  pingDatabase: () => Promise<unknown>;
  pingRedis: () => Promise<unknown>;
  timeoutMs: number;
}

const defaultDeps: ReadinessDeps = {
  pingDatabase: () => db.execute(sql`select 1`),
  pingRedis: () => redis.ping(),
  timeoutMs: READINESS_CHECK_TIMEOUT_MS,
};

async function check(name: string, run: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
  try {
    await withTimeout(run(), timeoutMs, `readiness ${name}`);
    return "ok";
  } catch (err) {
    logger.warn("health.readiness_check_failed", { check: name, error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckStatus; redis: CheckStatus };
}

export async function readinessReport(deps: ReadinessDeps = defaultDeps): Promise<ReadinessReport> {
  const [database, redisStatus] = await Promise.all([
    check("database", deps.pingDatabase, deps.timeoutMs),
    check("redis", deps.pingRedis, deps.timeoutMs),
  ]);
  return { ready: database === "ok", checks: { database, redis: redisStatus } };
}

export function readinessResponse(report: ReadinessReport): Response {
  return Response.json(
    { status: report.ready ? "ready" : "not_ready", checks: report.checks },
    { status: report.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
