import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  securityHeaderRules,
  TOKEN_IN_URL_PATHS,
  type SecurityHeaderOptions,
} from "./security-headers";

const HTTP_PROD: SecurityHeaderOptions = { isDev: false, isHttps: false };
const HTTPS_PROD: SecurityHeaderOptions = { isDev: false, isHttps: true };
const DEV: SecurityHeaderOptions = { isDev: true, isHttps: false };
const HSTS = "max-age=31536000; includeSubDomains";
const R2 = "https://*.r2.cloudflarestorage.com";

function headersFor(path: string, options: SecurityHeaderOptions): Record<string, string> {
  // Mirrors Next.js: rules apply in order, a later rule overrides the same key.
  const out: Record<string, string> = {};
  for (const rule of securityHeaderRules(options)) {
    const pattern = new RegExp(`^${rule.source.replace("/:path*", "(?:/.*)?")}$`);
    if (pattern.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(" ")] as const;
    }),
  );
}

describe("security headers (SEC-M-01)", () => {
  describe.each([
    ["HTTP production", HTTP_PROD],
    ["HTTPS production", HTTPS_PROD],
  ])("%s keeps every protection that does not depend on HTTPS", (_label, options) => {
    it("framing denied, nosniff, referrer, permissions and opener policies on every page", () => {
      for (const path of ["/", "/login", "/academy/dashboard", "/platform"]) {
        const h = headersFor(path, options);
        expect(h["X-Frame-Options"]).toBe("DENY");
        expect(h["X-Content-Type-Options"]).toBe("nosniff");
        expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
        expect(h["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
        expect(h["Content-Security-Policy"]).toBe(contentSecurityPolicy(options));
      }
    });

    it("CSP blocks eval, plugins, base hijacking, off-site forms and framing; allows R2", () => {
      const d = directives(contentSecurityPolicy(options));
      expect(d.get("default-src")).toBe("'self'");
      expect(d.get("script-src")).toBe("'self' 'unsafe-inline'");
      expect(d.get("style-src")).toBe("'self' 'unsafe-inline'");
      expect(d.get("img-src")).toBe(`'self' blob: data: ${R2}`);
      expect(d.get("font-src")).toBe("'self' data:");
      expect(d.get("connect-src")).toBe(`'self' ${R2}`);
      expect(d.get("object-src")).toBe("'none'");
      expect(d.get("base-uri")).toBe("'self'");
      expect(d.get("form-action")).toBe("'self'");
      expect(d.get("frame-ancestors")).toBe("'none'");
      expect(d.get("manifest-src")).toBe("'self'");
      expect(d.get("worker-src")).toBe("'self' blob:");
    });

    it("pages with a token in the URL never send a Referer", () => {
      for (const path of TOKEN_IN_URL_PATHS) {
        expect(headersFor(path, options)["Referrer-Policy"]).toBe("no-referrer");
        expect(headersFor(`${path}/some-token`, options)["Referrer-Policy"]).toBe("no-referrer");
      }
      expect(headersFor("/staff-invitation/anything", options)["Referrer-Policy"]).toBe("no-referrer");
    });
  });

  it("HTTP production (APP_HTTPS_ENABLED unset): no upgrade-insecure-requests, no HSTS", () => {
    expect(contentSecurityPolicy(HTTP_PROD)).not.toContain("upgrade-insecure-requests");
    for (const path of ["/", "/login", ...TOKEN_IN_URL_PATHS]) {
      expect(headersFor(path, HTTP_PROD)["Strict-Transport-Security"]).toBeUndefined();
    }
  });

  it("HTTPS production: upgrade-insecure-requests and HSTS are both sent", () => {
    expect(directives(contentSecurityPolicy(HTTPS_PROD)).has("upgrade-insecure-requests")).toBe(true);
    for (const path of ["/", "/login", ...TOKEN_IN_URL_PATHS]) {
      expect(headersFor(path, HTTPS_PROD)["Strict-Transport-Security"]).toBe(HSTS);
    }
  });

  it("HTTPS production differs from HTTP production only by the two HTTPS policies", () => {
    expect(contentSecurityPolicy(HTTPS_PROD)).toBe(`${contentSecurityPolicy(HTTP_PROD)}; upgrade-insecure-requests`);
    const https = headersFor("/login", HTTPS_PROD);
    delete https["Strict-Transport-Security"];
    https["Content-Security-Policy"] = contentSecurityPolicy(HTTP_PROD);
    expect(https).toEqual(headersFor("/login", HTTP_PROD));
  });

  it("no obsolete interest-cohort entry in Permissions-Policy", () => {
    for (const options of [HTTP_PROD, HTTPS_PROD, DEV]) {
      expect(headersFor("/", options)["Permissions-Policy"]).not.toContain("interest-cohort");
    }
  });

  it("development keeps what the dev server needs and skips HSTS / https upgrade", () => {
    const d = directives(contentSecurityPolicy(DEV));
    expect(d.get("script-src")).toBe("'self' 'unsafe-inline' 'unsafe-eval'");
    expect(d.get("connect-src")).toBe(`'self' ${R2} ws: wss:`);
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.has("upgrade-insecure-requests")).toBe(false);
    expect(headersFor("/login", DEV)["Strict-Transport-Security"]).toBeUndefined();
    expect(headersFor("/login", DEV)["X-Frame-Options"]).toBe("DENY");
    expect(headersFor("/reset-password", DEV)["Referrer-Policy"]).toBe("no-referrer");
  });
});
