import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Per-requesting-user rate limit for email-change verification requests —
 * reuses lib/rate-limit.ts, the same shared utility every other rate limit
 * in this codebase uses (no second rate-limiting system). Keyed by the
 * authenticated userId (not the new email or IP): the abuse case here is
 * one account repeatedly re-triggering verification sends (to itself or to
 * whatever address it names), which a userId key stops regardless of which
 * new address is being verified.
 */
export async function checkEmailChangeRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit(`email-change:${userId}`, {
    maxAttempts: env.EMAIL_CHANGE_RATE_LIMIT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
    windowSeconds: env.EMAIL_CHANGE_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_WINDOW_SECONDS,
  });
}
