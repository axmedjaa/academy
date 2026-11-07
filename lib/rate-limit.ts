import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { checkThreshold, logSink, type MonitoringSink } from "@/lib/monitoring/monitor";

export interface RateLimitOptions {
  maxAttempts: number;
  windowSeconds: number;
  /**
   * Security audit SEC-M-03. When Redis can't be reached, deny instead of
   * allow. Set for the authentication limiters (login, MFA challenge, MFA
   * email OTP, MFA enrollment, password reset); low-risk limiters such as
   * the contact form keep the fail-open default.
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
  /** True when the check was denied because Redis was unavailable (failClosed). */
  unavailable?: boolean;
}

/** Suggested wait shown to the user while a fail-closed limiter can't reach Redis. */
export const RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS = 30;

/**
 * Outage policy. Superseded in part by security audit SEC-M-03: limiters
 * created with `failClosed: true` (every authentication limiter) now DENY
 * while Redis is unavailable, because brute-force protection must not
 * disappear exactly when infrastructure is degraded. The Redis client gives
 * up within a couple of seconds (lib/redis.ts), so a denial is quick, and
 * the user is told to try again shortly. The text below still describes the
 * default (fail-open) limiters and the observability shared by both.
 *
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
  { maxAttempts, windowSeconds, failClosed = false }: RateLimitOptions,
  sink: MonitoringSink = logSink,
): Promise<RateLimitResult> {
  // Fails open unless `failClosed`: see this module's own top comment for the full outage
  // policy and why fail-open (with loud, escalating observability) is the
  // deliberate choice here, not an oversight.
  try {
    // One atomic step (security audit SEC-L-06): increment, and set the
    // window's expiry whenever the key has none. The old INCR-then-EXPIRE
    // pair could leave a key without an expiry if the second call failed,
    // locking that bucket forever; this also repairs any such key.
    const [count, ttl] = (await redis.eval(INCREMENT_SCRIPT, 1, rateLimitRedisKey(key), String(windowSeconds))) as [number, number];

    consecutiveFailures = 0;
    outageStartedAt = null;

    if (count > maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    }

    return { allowed: true, remaining: maxAttempts - count };
  } catch (error) {
    return reportOutage(key, error, { maxAttempts, failClosed }, sink);
  }
}

/**
 * Hands back one attempt counted by `checkRateLimit`, for limits that should
 * only count failures (sign-in): the attempt is reserved up front, so
 * parallel requests can never slip past the limit, and returned once it
 * turns out to have succeeded. Never creates a key or a key without expiry.
 * Best effort: a Redis error is logged and ignored (it can only leave one
 * extra attempt counted).
 */
export async function refundRateLimit(key: string): Promise<void> {
  try {
    await redis.eval(REFUND_SCRIPT, 1, rateLimitRedisKey(key));
  } catch (error) {
    logSink.recordEvent({
      name: "rate_limit.refund_failed",
      level: "info",
      message: `Could not refund a rate-limit attempt on "${key}"`,
      context: { key, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Removes a limiter's counter entirely (e.g. an account's failures after a
 * correct password). Best effort, like `refundRateLimit`. */
export async function clearRateLimit(key: string): Promise<void> {
  try {
    await redis.del(rateLimitRedisKey(key));
  } catch (error) {
    logSink.recordEvent({
      name: "rate_limit.clear_failed",
      level: "info",
      message: `Could not clear the rate-limit counter on "${key}"`,
      context: { key, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * The Redis key for a limiter key. `RATE_LIMIT_NAMESPACE` (set only by the
 * test runners: "e2e" for Playwright's server, "vitest" for Vitest) keeps
 * test traffic out of the counters a developer's own server uses when both
 * share one Redis. Unset in development and production: keys are unchanged.
 */
export function rateLimitRedisKey(key: string): string {
  const namespace = env.RATE_LIMIT_NAMESPACE;
  return namespace ? `ratelimit:${namespace}:${key}` : `ratelimit:${key}`;
}

// KEYS[1] = counter, ARGV[1] = window in seconds. Returns { count, ttl }.
const INCREMENT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

// KEYS[1] = counter. Decrements an existing counter; deletes it at zero.
const REFUND_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local count = redis.call("DECR", KEYS[1])
if count <= 0 then redis.call("DEL", KEYS[1]) end
return count
`;

function reportOutage(
  key: string,
  error: unknown,
  { maxAttempts, failClosed }: { maxAttempts: number; failClosed: boolean },
  sink: MonitoringSink,
): RateLimitResult {
  consecutiveFailures += 1;
  outageStartedAt ??= Date.now();

  const context = {
    key,
    error: error instanceof Error ? error.message : String(error),
    consecutiveFailures,
    outageDurationMs: Date.now() - outageStartedAt,
    failingOpen: !failClosed,
  };

  // Always visible (an "info"-level event is still a structured,
  // greppable log line via the default sink) — and additionally
  // escalated to a real "alert" event by checkThreshold once the
  // streak is sustained, exactly like queue-health.ts's own thresholds.
  sink.recordEvent({
    name: "rate_limit.redis_unavailable",
    level: "info",
    message: `Redis unreachable for rate limit check on "${key}" — ${failClosed ? "failing closed (request denied)" : "failing open"}`,
    context,
  });
  checkThreshold({
    name: "rate_limit.redis_consecutive_failures",
    value: consecutiveFailures,
    threshold: SUSTAINED_OUTAGE_THRESHOLD - 1,
    context,
    sink,
  });

  if (failClosed) {
    return { allowed: false, remaining: 0, retryAfterSeconds: RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS, unavailable: true };
  }
  return { allowed: true, remaining: maxAttempts };
}
