/**
 * PLAN.md Phase 5, Item 62/67 — "storage/email/SMS provider health."
 *
 * ---------------------------------------------------------------------
 * Honest gap, not a fabricated signal
 * ---------------------------------------------------------------------
 * PLAN.md's Cross-Cutting Architecture Decisions name `lib/storage`,
 * `lib/email`, and `lib/sms` as the eventual provider-interface module
 * paths, but none of those directories exists anywhere in this repo as of
 * this item (confirmed by searching `lib/` before writing this file) —
 * no earlier phase built them, and building them is not this item's job.
 * lib/notifications/worker.ts's `sendEmail`/`sendSms` are themselves
 * still log-only stubs with no real provider behind them either.
 *
 * There is therefore nothing real to "check the health of" for storage,
 * email, or SMS yet. Rather than fabricate a fake healthy/unhealthy
 * result (which would be actively misleading — a green check for a
 * provider that doesn't exist), each function below honestly reports
 * `status: "unknown"` with a `reason` naming the missing module. This is
 * a documented, correctly-scoped gap: once a later item builds
 * `lib/storage`/`lib/email`/`lib/sms` behind their own interfaces, that
 * item should replace only the body of the matching function here (the
 * shape — `ProviderHealthResult`, the function name, how it's wired into
 * `runMonitoringSweep` in sweep.ts — is meant to stay put), exactly as
 * lib/notifications/worker.ts's own module comment describes for its
 * sendEmail/sendSms stubs.
 */

export type ProviderName = "storage" | "email" | "sms";

/**
 * "unknown" is the only status these stubs may ever report — there is no
 * real provider integration to derive "healthy"/"unhealthy" from yet.
 * The type is deliberately not widened to include those states here, so
 * a future real implementation replacing a function body is forced to
 * also widen this type consciously rather than silently inheriting an
 * unused "healthy"/"unhealthy" case.
 */
export type ProviderHealthStatus = "unknown";

export interface ProviderHealthResult {
  provider: ProviderName;
  status: ProviderHealthStatus;
  reason: string;
}

function notYetImplemented(provider: ProviderName, moduleName: string): ProviderHealthResult {
  return {
    provider,
    status: "unknown",
    reason:
      `lib/${moduleName} not yet implemented in this codebase — no real ${provider} provider ` +
      `exists to check the health of yet (PLAN.md's Deployment & Ops Decisions table: ` +
      `"${provider === "sms" ? "SMS" : provider[0].toUpperCase() + provider.slice(1)} provider | Deferred — non-blocking"). ` +
      `This is a placeholder result, not a real health signal — replace this function's body once lib/${moduleName} exists.`,
  };
}

/** Placeholder for object-storage provider health (no `lib/storage` module exists yet). */
export async function checkStorageHealth(): Promise<ProviderHealthResult> {
  return notYetImplemented("storage", "storage");
}

/** Placeholder for email provider health (no `lib/email` module exists yet — `sendEmail` in worker.ts is a log-only stub). */
export async function checkEmailHealth(): Promise<ProviderHealthResult> {
  return notYetImplemented("email", "email");
}

/** Placeholder for SMS provider health (no `lib/sms` module exists yet — `sendSms` in worker.ts is a log-only stub). */
export async function checkSmsHealth(): Promise<ProviderHealthResult> {
  return notYetImplemented("sms", "sms");
}
