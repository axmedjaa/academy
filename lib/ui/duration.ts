/**
 * The one centralized "how long until you can retry" formatter for every
 * rate-limited flow in this app (login, MFA challenge, MFA enrollment,
 * forgot-password, email-change verification, MFA email-OTP resend).
 * Previously each of those six call sites hand-built its own message —
 * `` `Too many attempts. Try again in ${rateLimit.retryAfterSeconds}s.` ``
 * — showing a raw second count (e.g. "570s") instead of a wording a
 * person actually reads naturally ("9 minutes and 30 seconds"). This file
 * is the one place that turns a `retryAfterSeconds` number into that
 * wording; the six call sites only change their template's tail, never
 * re-implement the pluralization/unit logic themselves.
 *
 * Deliberately takes only a plain number — never a rate-limit key, an
 * error object, or anything else internal — so there is no way for a
 * caller to accidentally thread a Redis error, a stack trace, or a key
 * name through this into a user-facing string.
 */

/** `"second"`/`"seconds"`, `"minute"`/`"minutes"`, `"hour"`/`"hours"` — singular only for exactly 1. */
function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/**
 * Formats a retry-after duration in whole seconds as natural English —
 * at most the two largest non-zero units (hours+minutes, or
 * minutes+seconds, or seconds alone), matching how a person actually
 * reads out a wait time rather than enumerating every unit down to
 * zero-second precision.
 *
 * - Non-finite, negative, or zero input -> `"a moment"` (never "0
 *   seconds" — a rate limit whose window has already elapsed, or an
 *   unexpected non-positive value, should never read as "wait zero
 *   seconds," which looks like a bug rather than "basically now").
 * - Fractional input is rounded UP (`Math.ceil`) — this is a wait-time
 *   floor, not a countdown clock; the UI should never imply a retry is
 *   allowed even one second before the server will actually accept it.
 * - 1-59s -> `"N second(s)"`.
 * - 60s-3599s -> `"N minute(s)"`, plus `" and M second(s)"` only when
 *   a remainder exists.
 * - >=3600s -> `"N hour(s)"`, plus `" and M minute(s)"` only when a
 *   remainder exists (leftover seconds are dropped at this scale — the
 *   same "don't over-specify" reasoning DESIGN.md's own money/date
 *   formatting already applies elsewhere in this app).
 *
 * Examples: `0` -> "a moment", `1` -> "1 second", `45` -> "45 seconds",
 * `60` -> "1 minute", `90` -> "1 minute and 30 seconds",
 * `570` -> "9 minutes and 30 seconds", `3600` -> "1 hour",
 * `3661` -> "1 hour and 1 minute".
 */
export function formatRetryAfter(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "a moment";
  }

  const seconds = Math.ceil(totalSeconds);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${pluralize(hours, "hour")} and ${pluralize(minutes, "minute")}` : pluralize(hours, "hour");
  }

  if (minutes > 0) {
    return remainderSeconds > 0
      ? `${pluralize(minutes, "minute")} and ${pluralize(remainderSeconds, "second")}`
      : pluralize(minutes, "minute");
  }

  return pluralize(seconds, "second");
}
