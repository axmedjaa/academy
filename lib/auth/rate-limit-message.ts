import type { RateLimitResult } from "@/lib/rate-limit";
import { formatRetryAfter } from "@/lib/ui/duration";

/**
 * The user-facing text for a denied rate-limit check. A denial caused by
 * Redis being unavailable (fail-closed auth limiters, SEC-M-03) gets a
 * neutral "try again shortly" instead of a misleading "too many attempts".
 */
export function rateLimitMessage(result: RateLimitResult, prefix: string): string {
  if (result.unavailable) {
    return "This is temporarily unavailable. Please try again in a moment.";
  }
  return `${prefix} Please try again in ${formatRetryAfter(result.retryAfterSeconds ?? 0)}.`;
}
