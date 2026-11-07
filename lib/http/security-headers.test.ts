import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaderRules, TOKEN_IN_URL_PATHS } from "./security-headers";

function headersFor(path: string, isDev: boolean): Record<string, string> {
  // Mirrors Next.js: rules apply in order, a later rule overrides the same key.
  const out: Record<string, string> = {};
  for (const rule of securityHeaderRules({ isDev })) {
    const pattern = new RegExp(`^${rule.source.replace("/:path*", "(?:/.*)?")}$`);
    if (pattern.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

describe("security headers (SEC-M-01)", () => {
  it("production: framing denied, HSTS, nosniff, referrer and permissions policies on every page", () => {
    for (const path of ["/login", "/academy/dashboard", "/platform"]) {
      const h = headersFor(path, false);
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(h["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Permissions-Policy"]).toContain("camera=()");
    }
  });

  it("pages with a token in the URL never send a Referer", () => {
    for (const path of TOKEN_IN_URL_PATHS) {
      expect(headersFor(path, false)["Referrer-Policy"]).toBe("no-referrer");
    }
    expect(headersFor("/staff-invitation/anything", false)["Referrer-Policy"]).toBe("no-referrer");
  });

  it("production CSP blocks plugins, base hijacking, off-site form posts and eval; allows R2", () => {
    const csp = contentSecurityPolicy({ isDev: false });
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toMatch(/connect-src 'self' https:\/\/\*\.r2\.cloudflarestorage\.com/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/\*\.r2\.cloudflarestorage\.com/);
  });

  it("development keeps what the dev server needs and skips HSTS / https upgrade", () => {
    const csp = contentSecurityPolicy({ isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(headersFor("/login", true)["Strict-Transport-Security"]).toBeUndefined();
    expect(headersFor("/login", true)["X-Frame-Options"]).toBe("DENY");
  });
});
