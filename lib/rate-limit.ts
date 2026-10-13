import { redis } from "@/lib/redis";
import { checkThreshold, logSink, type MonitoringSink } from "@/lib/monitoring/monitor";

export interface RateLimitOptions {
  maxAttempts: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

/**
 * Security audit finding (Priority 2 — "Redis rate-limit failure"). Still
 * fails open on a Redis error — the policy itself is unchanged, and
 * deliberately so: flipping every rate-limited endpoint to fail closed
 * would turn any Redis blip (a brief timeout, a failover, a deploy) into
 * a total outage of /login, /mfa/challenge, and every other rate-limited
 * flow for every legitimate user, over an unrelated dependency hiccup.
 * That is a worse outcome for a transient problem than briefly running
 * without brute-force throttling.
 *
 * What changed is observability, per this finding's own "do not silently
 * disable critical protections" instruction — a single warn-level log
 * line buried among normal logs, never routed through this codebase's own
 * alerting abstraction, was the actual gap, not the fail-open choice
 * itself:
 *
 * - every failure now reports through `MonitoringSink`/`checkThreshold`
 *   (lib/monitoring/monitor.ts) — the exact same mechanism
 *   lib/monitoring/queue-health.ts already uses for its own "3 consecutive
 *   failures" alert threshold, not a one-off raw logger call. Swapping in
 *   a real provider later (per that module's own "provider deferred,
 *   requirement fixed now" doc comment) means every alert in this codebase,
 *   this one included, starts firing through it with no call-site changes;
 * - `consecutiveFailures` and `outageDurationMs` (time since the *first*
 *   failure in the current streak) are included on every occurrence, and
 *   `checkThreshold` emits a distinct "alert"-level event once the streak
 *   crosses `SUSTAINED_OUTAGE_THRESHOLD` — a single blip stays at the
 *   quieter "warn"-equivalent level, while a real, ongoing outage becomes
 *   an actual alert;
 * - the counter resets to 0 the moment a check succeeds again, so
 *   recovery is immediate and doesn't require a deploy or manual reset.
 *
 * This state is process-local (module-level, not Redis-backed — Redis is
 * exactly what's unavailable) and per-instance by design: in a
 * multi-instance deployment each instance tracks and reports its own view
 * of the outage, which is the correct input for per-instance alerting
 * rather than a single shared counter that itself depends on the thing
 * that's down.
 *
 * `/api/health`'s own `checkRedis` is the primary, authoritative signal
 * for "is Redis reachable at all" (it fails the whole health check,
 * independent of whether any rate limit happened to run recently) — this
 * module's reporting is the secondary signal that specifically correlates
 * "rate limiting is currently running open" with that outage, for
 * whoever is debugging a brute-force incident during/after one.
 */
const SUSTAINED_OUTAGE_THRESHOLD = 3;

let consecutiveFailures = 0;
let outageStartedAt: number | null = null;

/**
 * Fixed-window rate limiter backed by Redis (Memurai locally). Generic and
 * reusable — PLAN.md names three endpoints for this (/login, /forgot-password,
 * /mfa/challenge); each caller supplies its own key namespace and thresholds.
 *
 * `sink` defaults to the shared `logSink` (same default-parameter pattern
 * as `checkThreshold`/`checkQueueHealth` in lib/monitoring/) — overridden
 * only by this module's own tests, to assert on emitted events without
 * depending on log output.
 */
export async function checkRateLimit(
  key: string,
  { maxAttempts, windowSeconds }: RateLimitOptions,
  sink: MonitoringSink = logSink,
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${key}`;

  // Fails open: see this module's own top comment for the full outage
  // policy and why fail-open (with loud, escalating observability) is the
  // deliberate choice here, not an oversight.
  try {
    const count = await redis.incr(redisKey);

    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }

    consecutiveFailures = 0;
    outageStartedAt = null;

    if (count > maxAttempts) {
      const ttl = await redis.ttl(redisKey);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    }

    return { allowed: true, remaining: maxAttempts - count };
  } catch (error) {
    consecutiveFailures += 1;
    outageStartedAt ??= Date.now();

    const context = {
      key,
      error: error instanceof Error ? error.message : String(error),
      consecutiveFailures,
      outageDurationMs: Date.now() - outageStartedAt,
      failingOpen: true,
    };

    // Always visible (an "info"-level event is still a structured,
    // greppable log line via the default sink) — and additionally
    // escalated to a real "alert" event by checkThreshold once the
    // streak is sustained, exactly like queue-health.ts's own thresholds.
    sink.recordEvent({
      name: "rate_limit.redis_unavailable",
      level: "info",
      message: `Redis unreachable for rate limit check on "${key}" — failing open`,
      context,
    });
    checkThreshold({
      name: "rate_limit.redis_consecutive_failures",
      value: consecutiveFailures,
      threshold: SUSTAINED_OUTAGE_THRESHOLD - 1,
      context,
      sink,
    });

    return { allowed: true, remaining: maxAttempts };
  }
}
