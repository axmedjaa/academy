# Test database (Neon branch)

Integration tests (`npm test`) insert and delete real rows — see e.g.
`lib/academies/book-sales.test.ts`'s `afterAll`. They must never run
against the same database `next dev` uses. `vitest.config.ts` enforces
this: it refuses to run any test unless `TEST_DATABASE_URL` is set to a
value different from `DATABASE_URL`.

This project intentionally uses Neon (not a local Postgres install) for
development — see `.env.local`. Neon branches are a cheap, instant,
copy-on-write clone of a database, which makes them the natural fit for
an isolated test database: create one, point tests at it, and anything a
test run leaves behind only ever lands on that branch, never on `main`
(the branch dev actually uses).

## One-time setup

1. **Create a dedicated branch**, via the Neon console (console.neon.tech
   → your project → Branches → "Create branch"). Branch from `main` (or
   whichever branch `DATABASE_URL` currently points at), and name it
   something unmistakable, e.g. `test`.

   Equivalent via the Neon CLI, if you'd rather not use the console:

   ```sh
   npx neonctl branches create --project-id <your-project-id> --name test
   ```

   (`neonctl auth` first, if you haven't authenticated the CLI before.)

2. **Get that branch's own connection string** — console: Branches →
   `test` → Connection Details → copy the connection string shown there
   (make sure the branch selector at the top says `test`, not `main`).
   CLI equivalent:

   ```sh
   npx neonctl connection-string test --project-id <your-project-id>
   ```

3. **Add it to `.env.local`** (never commit this file — it already
   contains `DATABASE_URL`'s own real credentials) as a new line:

   ```
   TEST_DATABASE_URL=<the test branch's connection string>
   ```

   Do not paste it anywhere else (chat, a committed file, a shell
   history you intend to share) — treat it with the same care as
   `DATABASE_URL`.

4. Run `npm test`. If `TEST_DATABASE_URL` is missing, or identical to
   `DATABASE_URL`, Vitest now refuses to start and tells you why instead
   of silently running against dev data.

## Running E2E (Playwright) tests

`npm run test:e2e` uses the same `TEST_DATABASE_URL` — `playwright.config.ts`
fails the same way Vitest does if it's missing or identical to
`DATABASE_URL`. It never touches your running dev server: it boots its own
`next dev` instance on **port 3100** (your own dev server stays on 3000,
untouched), with that instance's own `DATABASE_URL` set to
`TEST_DATABASE_URL` and its own build cache (`.next-e2e/`, separate from
your dev server's `.next/`) so the two can run at the same time without
fighting over files. `e2e/global-setup.ts`'s seed script, the app instance
the browser drives, and the browser's own requests all resolve to that one
test-branch connection — nothing in the e2e path can reach dev data.

You can keep your own `next dev` running on 3000 the whole time; `npm run
test:e2e` neither needs it nor reuses it (`reuseExistingServer: false`).

## Keeping the test branch clean

Neon branches can be reset to match their parent again at any time
(console: Branches → `test` → "Reset from parent", or
`npx neonctl branches reset test --project-id <your-project-id>`) if the
test branch itself ever accumulates its own leaked rows from an
interrupted run. This is safe specifically because the test branch is
never read by anything except test runs — resetting it can't affect
`next dev` or any real data.
