import { defineConfig } from "vitest/config";

// Vitest runs as a standalone process, so .env.local isn't auto-loaded the
// way Next.js loads it for the app itself (same reasoning as drizzle.config.ts).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present (e.g. CI supplies required vars directly).
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    // Every test hits the real local Postgres instance (this project's own
    // convention — no mocking layer). The previous Vitest defaults (5s test,
    // 10s hook) are tight enough that running the suite under concurrent DB
    // load (another test run, a build, a dev server) can cause an `afterAll`
    // cleanup hook to time out — and a timed-out hook never runs its
    // `db.delete(...)` cleanup at all, silently leaking rows (this is how
    // ~275 orphaned test-created `subscription_plans` rows accumulated in
    // the dev database). Raising both thresholds doesn't fix a genuine bug —
    // it removes a false-failure/leak mode that only appears under load,
    // which is the actual root cause here.
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
