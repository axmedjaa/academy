import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { checkQueueHealth } from "@/lib/monitoring/queue-health";
import { logger } from "@/lib/logger";

/**
 * PLAN.md Phase 5, Item 67 (Final Documentation & Release Checklist): "an
 * application health endpoint (DB reachable, Redis reachable) and a worker
 * health check (queue connection alive); both are provider-agnostic checks
 * a load balancer or process manager can poll regardless of host."
 *
 * The first Route Handler in this codebase — every other endpoint so far is
 * a Server Component page or a Server Action. Deliberately public/
 * unauthenticated (the same posture as `/verify/[certificateCode]`): a load
 * balancer or uptime monitor polling this has no session to present, and
 * "is the app up" carries no tenant data to protect.
 *
 * Never returns a connection string, a raw exception message/stack, or any
 * queue-internals count (failed-job count, queue depth) — only a per-check
 * "ok"/"error" verdict. Real error detail is logged server-side via
 * `logger.error`, never included in the response body, so an outage is
 * fully diagnosable from server logs without handing an unauthenticated
 * caller anything about internal infrastructure state.
 */

type CheckStatus = "ok" | "error";

async function checkDatabase(): Promise<CheckStatus> {
  try {
    await db.execute(sql`select 1`);
    return "ok";
  } catch (error) {
    logger.error("health.database_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

async function checkRedis(): Promise<CheckStatus> {
  try {
    await redis.ping();
    return "ok";
  } catch (error) {
    logger.error("health.redis_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

/**
 * Reuses `checkQueueHealth` (lib/monitoring/queue-health.ts, Item 62)
 * rather than re-deriving queue liveness — "healthy" means the queue's own
 * Redis connection is ready AND neither of its already-established alert
 * thresholds (failed-job count, queue depth) is currently breached. The
 * underlying counts themselves are intentionally not surfaced here.
 */
async function checkQueue(): Promise<CheckStatus> {
  try {
    const report = await checkQueueHealth();
    const healthy =
      report.redisConnectionStatus === "ready" &&
      !report.failedThresholdBreached &&
      !report.queueDepthThresholdBreached;
    return healthy ? "ok" : "error";
  } catch (error) {
    logger.error("health.queue_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

export async function GET(): Promise<Response> {
  const [database, redisCheck, queue] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
  ]);

  const checks = { database, redis: redisCheck, queue };
  const allHealthy = Object.values(checks).every((status) => status === "ok");

  return Response.json(
    { status: allHealthy ? "ok" : "degraded", checks },
    { status: allHealthy ? 200 : 503 },
  );
}
