import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

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
 * Fixed-window rate limiter backed by Redis (Memurai locally). Generic and
 * reusable — PLAN.md names three endpoints for this (/login, /forgot-password,
 * /mfa/challenge); each caller supplies its own key namespace and thresholds.
 */
export async function checkRateLimit(
  key: string,
  { maxAttempts, windowSeconds }: RateLimitOptions,
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${key}`;

  // Fails open: if Redis itself is unreachable, this deliberately allows
  // the request rather than taking down signIn entirely over an unrelated
  // dependency outage (PLAN.md doesn't specify open vs. closed here).
  try {
    const count = await redis.incr(redisKey);

    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }

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
    logger.warn("rate limit check failed, failing open", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true, remaining: maxAttempts };
  }
}
