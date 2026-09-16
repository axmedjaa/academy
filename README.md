# Academy Management SaaS

Multi-tenant academy management platform. See `PLAN.md` (implementation authority) and `DESIGN.md` (UI/UX authority) for the full specification.

## Local development setup

This project runs entirely on native Windows — **no Docker, containers, or WSL are used anywhere in local dev.**

### Prerequisites

1. **Node.js** (v20+) and npm.
2. **PostgreSQL** — install via the [official Windows installer](https://www.postgresql.org/download/windows/) and ensure the service is running (default port `5432`).
3. **Memurai** — install the [Memurai](https://www.memurai.com/) Windows service. Memurai is a Redis-protocol-compatible in-memory store with a native Windows installer, used here in place of Redis (default port `6379`).

### Setup

```
npm install
```

Copy `.env.example` to `.env.local` and adjust `DATABASE_URL`/`REDIS_URL` if your local Postgres/Memurai credentials or ports differ from the defaults:

```
cp .env.example .env.local
```

Create the database referenced by `DATABASE_URL` (e.g. via `psql` or pgAdmin) with your real local PostgreSQL credentials, then apply migrations:

```
npm run migrate
```

Seed one MFA-enrolled `platform_owner` account for local sign-in (safe to re-run — skips if it already exists; refuses to run at all if `NODE_ENV=production`):

```
npm run seed
```

The seed script prints the account's email/password, TOTP secret (add to an authenticator app to sign in), and one-time recovery codes. Override the credentials via `SEED_PLATFORM_OWNER_EMAIL`/`SEED_PLATFORM_OWNER_PASSWORD` (see `.env.example`) — never commit real credentials here or in `.env.local`.

```
npm run dev
```

Visit `http://localhost:3000`.

### Database

Schema lives in `lib/db/schema.ts` (Drizzle ORM). To change it:

```
npm run db:generate   # generates a new SQL migration from schema.ts into drizzle/
npm run migrate       # applies pending migrations in drizzle/ to DATABASE_URL
```

Migration SQL files under `drizzle/` are checked into version control.

### Environment variables

Required variables are validated at startup by `lib/env.ts` (Zod-based) — the app fails immediately with a clear error if a required variable is missing or invalid, rather than degrading silently. See `.env.example` for the current full list.

### CI

`.github/workflows/ci.yml` runs lint, build (which typechecks), migrations against a fresh database, and the test suite on every push/PR — using natively `apt-get`-installed PostgreSQL and Redis on the Linux runner (no Docker/`services:` containers, consistent with local dev's no-Docker policy). Requires a repository secret `CI_MFA_ENCRYPTION_KEY` (a 32-byte base64 key, generated the same way as the local `.env.local` value) to be configured before it can run.

## Status

Phase 0 complete (Items 1–18): repo scaffold, database schema through Item 17, custom auth (password + session-based sign-in/out, password reset, mandatory TOTP MFA with recovery codes for `platform_owner`), Redis-backed rate limiting, the permission engine, audit logging, suspicious-login detection, account security page (session management), CI pipeline, and a seed script. No academy/subscription features exist yet — that begins in Phase 1.
