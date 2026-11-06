/**
 * Keeps an outage from flooding the logs: the same (key, message) pair is
 * let through at most once per window; repeats are counted and reported with
 * the next line that gets through.
 */
export function createLogThrottle(windowMs: number, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return {
    /** Returns null to drop, or the number of identical lines dropped since the last one. */
    admit(key: string, message: string): number | null {
      const id = `${key}\u0000${message}`;
      const entry = seen.get(id);
      const t = now();
      if (entry && t - entry.at < windowMs) {
        entry.suppressed += 1;
        return null;
      }
      const suppressed = entry?.suppressed ?? 0;
      seen.set(id, { at: t, suppressed: 0 });
      if (seen.size > 500) seen.delete(seen.keys().next().value as string);
      return suppressed;
    },
  };
}

/** First line of an error message, capped — e.g. drops the SQL text Drizzle appends. */
export function errorSummary(err: unknown, max = 200): string {
  let message = err instanceof Error ? err.message : String(err);
  // Drizzle wraps driver errors as "Failed query: <sql> params: ..."; the cause is what matters.
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (message.startsWith("Failed query") && cause instanceof Error) message = `database query failed: ${cause.message}`;
  const firstLine = message.split("\n", 1)[0];
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}
