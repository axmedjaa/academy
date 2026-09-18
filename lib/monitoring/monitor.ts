import { logger } from "@/lib/logger";

/**
 * PLAN.md Phase 5, Item 62/67 — "Operational monitoring/alerting: queue
 * health, storage/email/SMS provider health, alert thresholds."
 *
 * ---------------------------------------------------------------------
 * "Provider deferred, requirement fixed now" — same pattern as
 * lib/notifications/worker.ts's sendEmail/sendSms stubs
 * ---------------------------------------------------------------------
 * PLAN.md's Priority table is explicit: "Monitoring provider | Deferred —
 * non-blocking (requirement fixed now: Sentry-class tool required)." No
 * real error-tracking SDK (Sentry or otherwise) is installed anywhere in
 * this repo, and this item must not add one — no provider decision has
 * been made yet, and adding a new npm dependency is out of scope for this
 * item regardless.
 *
 * What PLAN.md fixes *now*, independent of which provider is eventually
 * chosen, is the shape of the integration: a small sink interface that
 * every call site in this codebase reports through, so that plugging in a
 * real Sentry (or other) SDK later is a matter of implementing
 * `MonitoringSink` once and swapping the default export at the app's
 * entry point — never rewriting every call site that reports an event.
 * `logSink` below is the default, "provider" for now: it reuses
 * lib/logger.ts's existing structured-logging + redaction (never
 * reimplemented here) so every monitoring event is at minimum a
 * structured, greppable log line even before a real provider exists.
 * This exactly mirrors lib/notifications/worker.ts's own
 * sendEmail/sendSms stubs, built for the identical "provider deferred,
 * requirement fixed" reason.
 */

export type MonitoringLevel = "info" | "warn" | "alert";

export interface MonitoringEvent {
  /** Short, stable, dot-namespaced event name, e.g. "queue.failed_jobs". */
  name: string;
  level: MonitoringLevel;
  message: string;
  context?: Record<string, unknown>;
}

export interface MonitoringMetric {
  /** Short, stable, dot-namespaced metric name, e.g. "queue.depth". */
  name: string;
  value: number;
  tags?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * The abstraction a real monitoring provider (Sentry-class or otherwise)
 * would implement. Every monitoring call site in this codebase goes
 * through a `MonitoringSink`, never directly through `lib/logger.ts` or a
 * provider SDK — so wiring in a real provider later means writing one
 * implementation of this interface and passing it in (or changing the
 * `logSink` default export), not touching every caller.
 */
export interface MonitoringSink {
  recordEvent(event: MonitoringEvent): void;
  recordMetric(metric: MonitoringMetric): void;
}

function levelToLogMethod(level: MonitoringLevel): "info" | "warn" | "error" {
  if (level === "alert") return "error";
  if (level === "warn") return "warn";
  return "info";
}

/**
 * Default, log-based `MonitoringSink` — the stand-in "provider" for now.
 * Fulfills PLAN.md's fixed requirement (a Sentry-class tool must exist)
 * without committing to any specific vendor: every event/metric becomes a
 * structured log line via lib/logger.ts (which already redacts
 * secrets/PII), so nothing reported through this sink is silently
 * dropped even before a real provider is chosen.
 */
export const logSink: MonitoringSink = {
  recordEvent(event) {
    const method = levelToLogMethod(event.level);
    logger[method](`monitoring.${event.name}`, {
      monitoringLevel: event.level,
      ...event.context,
    });
  },
  recordMetric(metric) {
    logger.info(`monitoring.metric.${metric.name}`, {
      value: metric.value,
      ...metric.tags,
    });
  },
};

export interface ThresholdCheckOptions {
  /** Short, stable, dot-namespaced name for the checked value, e.g. "queue.failed_jobs". */
  name: string;
  value: number;
  threshold: number;
  context?: Record<string, unknown>;
  sink?: MonitoringSink;
  /**
   * How `value` is compared against `threshold` to decide a breach.
   * Defaults to "value strictly greater than threshold" (e.g. "more than
   * 100" rather than "100 or more"), matching PLAN.md's own thresholds
   * ("queue depth exceeding 100", "3 consecutive... failures" read as
   * "more than the healthy baseline").
   */
  comparator?: (value: number, threshold: number) => boolean;
}

export interface ThresholdCheckResult {
  breached: boolean;
  value: number;
  threshold: number;
}

/**
 * Generic alert-threshold helper: emits a distinct "alert"-level event
 * through the sink whenever `value` crosses `threshold`, per PLAN.md's
 * Observability Requirements ("Alert thresholds, stated concretely...").
 * Deliberately simple and generic — one comparison, one event shape — so
 * every concrete threshold in this codebase (queue depth, failed-job
 * count, and any future one) reuses this instead of hand-rolling its own
 * alert logic.
 */
export function checkThreshold(options: ThresholdCheckOptions): ThresholdCheckResult {
  const { name, value, threshold, context, sink = logSink, comparator = (v, t) => v > t } = options;
  const breached = comparator(value, threshold);
  if (breached) {
    sink.recordEvent({
      name,
      level: "alert",
      message: `${name} crossed threshold: ${value} (threshold ${threshold})`,
      context: { value, threshold, ...context },
    });
  }
  return { breached, value, threshold };
}
