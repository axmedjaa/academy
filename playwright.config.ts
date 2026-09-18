import { defineConfig, devices } from "@playwright/test";

// Playwright runs as a standalone process, same reasoning as
// vitest.config.ts's own comment: .env.local is only auto-loaded for the
// Next.js CLI itself, not for arbitrary Node processes.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present (e.g. CI supplies required vars directly).
}

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

/**
 * PLAN.md Phase 5, Item 65 — full Playwright coverage.
 *
 * webServer: `next dev` vs. `next build && next start`
 * ---------------------------------------------------------------------
 * Chose `next dev` over a production build+start for this item, for one
 * concrete, security-relevant reason found while wiring this up:
 * lib/auth/session.ts's sessionCookieOptions() (and
 * lib/auth/mfa-pending.ts's pendingMfaCookieOptions()) set
 * `secure: env.NODE_ENV === "production"`, and `next build`/`next start`
 * force NODE_ENV=production internally. Most Chromium/Firefox versions
 * treat "http://localhost" as a secure context and still accept a
 * `Secure` cookie there, but that's a browser-specific exemption, not a
 * guarantee — relying on it would make every authenticated E2E test
 * (i.e. all of them except the public /verify page) depend on an
 * unverified edge case. `next dev` always runs with NODE_ENV=development,
 * so the session cookie is never marked Secure and login reliably works
 * over plain http://localhost regardless of that exemption. A production
 * build+start run remains worth revisiting once a real HTTPS deployment
 * target exists (session.ts's own comment already flags "Session cookie
 * Secure flag confirmed once a deployment target is chosen" as a known
 * open item — same one PLAN.md's Phase 5 security considerations name).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Every login attempt across the whole suite shares one
      // Redis-backed rate-limit bucket keyed by client IP
      // (lib/auth/login-rate-limit.ts) — raised well above the 5/900s
      // production default so a full E2E run (and repeated local runs
      // within the same window) never trips it. Test-only override, never
      // touches the production default in lib/env.ts.
      LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
    },
  },
});
