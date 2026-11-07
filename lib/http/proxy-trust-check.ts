/**
 * Security audit SEC-M-02: in production the app must know how many
 * trusted proxy hops sit in front of it, or every IP-based rate limit
 * collapses into one shared bucket (five bad logins from anyone would lock
 * everyone out). Checked once at server start from instrumentation.ts.
 *
 * Reads the raw environment value rather than lib/env.ts, so the check
 * runs before (and independently of) the full settings validation.
 * Development and test runs are never affected.
 */
export type ProxyTrustCheck = { ok: true } | { ok: false; reason: string };

export function checkProxyTrustConfig(environment: { NODE_ENV?: string; TRUSTED_PROXY_HOP_COUNT?: string }): ProxyTrustCheck {
  if (environment.NODE_ENV !== "production") return { ok: true };

  const raw = environment.TRUSTED_PROXY_HOP_COUNT?.trim();
  if (!raw) {
    return {
      ok: false,
      reason:
        "TRUSTED_PROXY_HOP_COUNT is not set. Set it to the number of trusted reverse proxies in front of the app (1 behind Caddy alone, 2 with Cloudflare's proxy in front of Caddy).",
    };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      reason: "TRUSTED_PROXY_HOP_COUNT must be a whole number of at least 1 in production (the app always runs behind a reverse proxy).",
    };
  }
  return { ok: true };
}
