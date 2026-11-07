/**
 * HTTP security headers (security audit SEC-M-01). Applied to every route
 * from next.config.ts `headers()`. Kept here, free of app imports, so the
 * config can load it and tests can check it directly.
 *
 * CSP follows the Next.js "without nonces" pattern
 * (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md):
 * Next's own inline bootstrap scripts need 'unsafe-inline' unless every page
 * is rendered dynamically with a per-request nonce. The protections that
 * matter most here (framing, plugin/object injection, base-tag hijacking,
 * off-site form posts, third-party script hosts) are still enforced.
 *
 * Browser uploads go straight to Cloudflare R2 with a presigned PUT, and
 * images are read from presigned R2 URLs, so the R2 S3 endpoint is allowed
 * for `connect-src` and `img-src`.
 */
export interface SecurityHeaderOptions {
  isDev: boolean;
}

export interface HeaderEntry {
  key: string;
  value: string;
}

export interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

const R2_ORIGIN = "https://*.r2.cloudflarestorage.com";

/** Pages whose URL carries a one-time token: never send it in a Referer. */
export const TOKEN_IN_URL_PATHS = ["/reset-password", "/account/verify-email", "/staff-invitation"] as const;

export function contentSecurityPolicy({ isDev }: SecurityHeaderOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${R2_ORIGIN}`,
    "font-src 'self' data:",
    `connect-src 'self' ${R2_ORIGIN}${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];
  // Would break plain-http local runs (dev server, e2e on localhost).
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaderRules(options: SecurityHeaderOptions): HeaderRule[] {
  const common: HeaderEntry[] = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
  // HSTS only where the app is actually served over HTTPS. Browsers ignore
  // it on plain http anyway, but leaving it out of dev keeps localhost clean.
  if (!options.isDev) {
    common.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }

  return [
    { source: "/:path*", headers: common },
    // Later rules win for the same header key (Next.js applies them in order).
    ...TOKEN_IN_URL_PATHS.flatMap((path) => [
      { source: path, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: `${path}/:path*`, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ]),
  ];
}
