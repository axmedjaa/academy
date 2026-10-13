import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Security audit finding (Priority 1 — "verify production proxy trust").
 *
 * Every IP-keyed rate limit in this app (/login, /mfa/challenge, the public
 * /verify/[certificateCode]) previously read `request.headers.get(
 * "x-forwarded-for")?.split(",")[0]` directly, in three separate copies
 * (lib/auth/actions.ts, lib/auth/mfa-actions.ts,
 * app/verify/[certificateCode]/page.tsx), each with a comment asserting
 * "production deployment assumes a trusted reverse proxy ... overwrites,
 * never appends" — but:
 *
 * 1. This project has explicitly NOT chosen a hosting provider yet
 *    (docs/release-checklist.md's "Deployment & Ops Decisions" table:
 *    "Production hosting provider | Deferred"; PLAN.md: "Deployment target
 *    is undecided"). There is no reverse-proxy/CDN configuration anywhere
 *    in this repository to verify that assumption against — confirmed by
 *    searching for Dockerfile/vercel.json/fly.toml/render.yaml and finding
 *    none. This is a real, open gap, not something this change can close
 *    by itself; see TRUSTED_PROXY_HOP_COUNT's own doc comment in
 *    lib/env.ts for exactly what must be checked once a host is chosen.
 * 2. Even granting a trusted proxy, "take the FIRST entry" is only correct
 *    if that proxy *overwrites* the header rather than the far more common
 *    *append* behavior (nginx's own documented `$proxy_add_x_forwarded_for`,
 *    AWS ALB, and most CDNs all append). Under append behavior, the first
 *    entry is whatever the client itself originally claimed — fully
 *    attacker-controlled — and the real client IP is instead the entry
 *    appended by the *first* trusted hop, which is `hopCount` positions
 *    from the *right* end of the list, not the left. The three previous
 *    copies would have silently done the wrong thing under that (common)
 *    append configuration, independent of whether a proxy exists at all.
 *
 * This single implementation fixes both: it trusts nothing by default
 * (`TRUSTED_PROXY_HOP_COUNT` defaults to 0, see lib/env.ts), and once a
 * real hop count is configured, reads from the right end of the list —
 * the only direction a trusted hop's own append can't be spoofed by the
 * original client, since each trusted hop appends the peer IP it actually
 * observed rather than copying/trusting whatever was already in the header.
 */
const UNKNOWN_CLIENT_IP = "unknown";

interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Pure logic, deliberately taking `hopCount` as a plain argument (not
 * reading `env` itself) so it's directly unit-testable with no env
 * mocking — `getClientIp` below is the thin, env-aware wrapper real call
 * sites use. Returns the real client IP only if `hopCount` is positive
 * and the header actually has at least that many entries; otherwise
 * `"unknown"` — a single shared bucket for every untrusted caller rather
 * than trusting a value the caller could set to anything. A shared
 * bucket under-protects (one attacker's traffic can count against other
 * callers sharing it) but never *over*-trusts a spoofable header — the
 * safer failure direction for a security control.
 */
export function resolveClientIp(rawHeader: string | null, hopCount: number): string {
  if (hopCount <= 0 || !rawHeader) return UNKNOWN_CLIENT_IP;

  const entries = rawHeader
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const index = entries.length - hopCount;
  if (index < 0 || index >= entries.length) {
    // Configured hop count doesn't match what actually arrived — never
    // guess which entry might be real; fail to the same shared bucket as
    // "no trust configured at all."
    return UNKNOWN_CLIENT_IP;
  }

  return entries[index] || UNKNOWN_CLIENT_IP;
}

let warnedAboutUntrustedHeader = false;

/** Real call sites' entry point: reads the configured hop count from
 * `env` and the header from a real `headers()` result, and (only in
 * production, only once per process) warns when no hop count is
 * configured — see this module's own top comment for the full rationale. */
export function getClientIp(headerList: HeaderLike): string {
  const hopCount = env.TRUSTED_PROXY_HOP_COUNT ?? 0;

  if (hopCount <= 0 && env.NODE_ENV === "production" && !warnedAboutUntrustedHeader) {
    warnedAboutUntrustedHeader = true;
    logger.warn("rate_limit.untrusted_client_ip", {
      detail:
        "TRUSTED_PROXY_HOP_COUNT is unset in production — every IP-based rate limit (login, MFA challenge, certificate verification) is sharing one bucket across all clients instead of limiting per real client IP, because no X-Forwarded-For value can be trusted without a verified trusted-proxy hop count. Confirm the production reverse-proxy/CDN topology and set TRUSTED_PROXY_HOP_COUNT once it is known.",
    });
  }

  return resolveClientIp(headerList.get("x-forwarded-for"), hopCount);
}
