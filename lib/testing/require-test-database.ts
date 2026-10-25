/**
 * Perf investigation (Afoogy slow-dashboard task, test-isolation step):
 * shared by vitest.config.ts and playwright.config.ts. Every integration
 * test — Vitest's own suite, and Playwright's e2e seed script + the
 * Next.js server it drives — must run against a dedicated Neon test
 * branch, never the same DATABASE_URL `next dev` uses. A run that never
 * reaches its own cleanup (a crashed process, a plain Ctrl-C) leaves
 * inserted rows permanently orphaned on whatever database it was pointed
 * at — the mechanism behind the thousands of leaked `<Suite> Test <Noun>
 * <uuid>` rows this task's dry-run report found in the dev database, back
 * when nothing enforced this separation.
 *
 * Fails fast and loud instead of silently falling back to dev. Both
 * callers import this from a plain relative path (not `@/...`) since
 * config files evaluate outside Next's own module resolver. See
 * docs/testing-database.md for how to create the branch this expects.
 */
// Set only by this function, right after it has already validated and
// applied the override once in this process tree — see the doc comment
// below for why that matters.
const OVERRIDE_SENTINEL = "__TEST_DATABASE_URL_APPLIED__";

/**
 * Validates TEST_DATABASE_URL and points `process.env.DATABASE_URL` at it
 * for the rest of this process — every later `lib/db` import (Vitest
 * test files, Playwright's globalSetup) then resolves to the test branch
 * with no further wiring.
 *
 * Idempotent by design, not just by accident: Playwright re-evaluates
 * `playwright.config.ts` once in its main process and again, independently,
 * in each worker process it spawns — and a worker inherits whatever
 * `process.env` the main process already has at fork time, which (by
 * then) already has `DATABASE_URL` correctly pointed at the test branch
 * by this same function's own first call. Without the sentinel, a
 * worker's re-evaluation would compare `TEST_DATABASE_URL` against the
 * *already-overridden* `DATABASE_URL`, see them equal, and throw the
 * "identical to dev" error against its own prior success rather than
 * catching a real misconfiguration. The sentinel can only be set by this
 * function immediately after a genuine, successful validation, so a
 * later call in the same process tree short-circuits instead of
 * re-deriving a false positive; a process that never ran this function
 * first still gets the full missing/identical checks.
 */
export function requireTestDatabaseUrl(): string {
  if (process.env[OVERRIDE_SENTINEL] === "1" && process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests insert and delete real rows and must run " +
        "against a dedicated Neon test branch — never the shared development database. See " +
        "docs/testing-database.md to create one, then set TEST_DATABASE_URL and re-run.",
    );
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is identical to DATABASE_URL (the development database). Point " +
        "TEST_DATABASE_URL at a separate Neon branch — see docs/testing-database.md — so tests " +
        "never write to dev data.",
    );
  }

  process.env.DATABASE_URL = testUrl;
  process.env[OVERRIDE_SENTINEL] = "1";
  return testUrl;
}
