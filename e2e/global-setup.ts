import { seedE2EFixtures } from "./fixtures/seed-e2e";

/**
 * Playwright's `globalSetup` (playwright.config.ts) — runs once, in the
 * main test-runner process, before any spec file. Loads .env.local the
 * same way vitest.config.ts does (Playwright is a standalone process too;
 * .env.local is only auto-loaded for the Next.js CLI itself) and then
 * seeds the two-academy fixture data every spec in e2e/ depends on.
 */
export default async function globalSetup(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local not present (e.g. CI supplies required vars directly).
  }

  await seedE2EFixtures();
}
