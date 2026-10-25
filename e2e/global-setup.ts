import { seedE2EFixtures } from "./fixtures/seed-e2e";

/**
 * Playwright's `globalSetup` (playwright.config.ts) — runs once, in the
 * main test-runner process, before any spec file. Loads .env.local the
 * same way vitest.config.ts does (Playwright is a standalone process too;
 * .env.local is only auto-loaded for the Next.js CLI itself) and then
 * seeds the two-academy fixture data every spec in e2e/ depends on.
 *
 * Perf investigation (Afoogy slow-dashboard task, test-isolation step):
 * `seedE2EFixtures()` imports `lib/db`, which reads `env.DATABASE_URL` —
 * already overridden to TEST_DATABASE_URL by playwright.config.ts's own
 * top-level `requireTestDatabaseUrl()` call, which always runs before
 * globalSetup. Deliberately NOT re-reading/re-assigning DATABASE_URL here
 * too: this function can run inside a worker process that inherited an
 * already-overridden `process.env.DATABASE_URL` from the main process,
 * and `requireTestDatabaseUrl()`'s own "identical to DATABASE_URL" guard
 * would then (correctly, but uselessly) compare the override against
 * itself and throw. One override point (the config file) is sufficient.
 */
export default async function globalSetup(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local not present (e.g. CI supplies required vars directly).
  }

  await seedE2EFixtures();
}
