# Dardar SM

Dardar SM (Dardar School System) is a multi-tenant web application for running training academies: students, admissions, courses and batches, timetables, exams and results, certificates, fees and payments, books, staff and branches. Each academy works in its own isolated space, and a separate platform console lets the platform team manage academies, plans and subscriptions.

> **Status:** under active development. It is not yet deployed to production. See [Deployment](#deployment).

## Features

**Academy console** (`/academy`)

| Area | What it covers |
|---|---|
| Students & admissions | Student records and photos, registration, admission candidates, ID cards |
| Programs, courses & batches | Programs and courses, batches, trainer assignment, enrollment |
| Timetable | Weekly timetable entries per batch, printable view |
| Exams & results | Exams, mark entry, grade configurations, result approval and corrections |
| Certificates | Certificate issuance and a public verification page (`/verify/[code]`) |
| Finance | Student charges and payments, fee periods, receipts, income, expenses with approval, reversals and adjustments, refunds, finance reports |
| Books | Book catalogue and stock, direct sales, pre-order campaigns, orders, payments, receiving and distribution |
| Staff & branches | Staff accounts and invitations, roles, branch assignments, multiple branches per academy |
| Reports & audit | Student, academic and finance reports, data export, academy audit log |
| Settings & notifications | Academy profile and logo, in-app notifications |

**Platform console** (`/platform`): academies, subscription plans, subscriptions and payments, usage, platform staff, reports, audit logs, website messages and platform settings.

**Account** (`/account`): profile, email change with verification, password, active sessions, two-step verification and recovery codes, activity.

## Roles and access

Access is enforced on the server for every action. The browser never decides which academy or branch a user may reach.

| Scope | Role | Summary |
|---|---|---|
| Platform | Platform Owner | Full control of the platform console |
| Platform | Platform Admin | Platform console access, limited to granted capabilities |
| Academy | Academy Owner | Full control of their academy |
| Academy | Academy Administrator | Broad management of the academy |
| Academy | Manager | Day-to-day operations, including finance and staff below Manager |
| Academy | Trainer | Teaching work (batches, timetable, marks), limited to assigned branches |

Each academy role has a permission level per area (for example view, manage or approve). Staff can be limited to specific branches or given all-branch access. Platform staff confirm every sign-in with a code sent to their email, or with a recovery code.

## Technology stack

| Layer | Technology |
|---|---|
| Framework | [Next.js](https://nextjs.org/) 16 (App Router, Server Actions), React 19, TypeScript |
| UI | Tailwind CSS 4, Radix UI primitives, lucide-react, Sonner |
| Database | PostgreSQL with [Drizzle ORM](https://orm.drizzle.team/) and SQL migrations |
| Cache, rate limiting, queues | Redis (ioredis) and BullMQ |
| Email | Resend |
| File storage | S3-compatible object storage (Cloudflare R2) via the AWS SDK |
| Documents | @react-pdf/renderer, qrcode |
| Validation & security | Zod, Argon2 |
| Testing | Vitest (unit and integration), Playwright (end-to-end) |

## Architecture

```
Browser
  │
  ▼
Next.js app (App Router)
  ├─ app/            pages and layouts (academy, platform, account, auth, public verify)
  ├─ Server Actions  every mutation; each resolves the signed-in user's access server-side
  └─ lib/            domain logic, auth, permissions, database access
        │
        ├─ PostgreSQL   all application data (Drizzle ORM)
        ├─ Redis        rate limits and the notification queue
        ├─ Object store photos, logos, documents (presigned uploads)
        └─ Resend       transactional email

Notification worker (scripts/worker.ts)
  └─ consumes the BullMQ queue in Redis and sends notifications
```

- **Multi-tenancy:** every academy-scoped table carries an `academy_id`. Queries are always filtered by the academy resolved from the user's session, never by an ID sent from the client.
- **Configuration:** `lib/env.ts` validates environment variables at startup with Zod and fails fast if a required one is missing.
- **Audit:** sensitive actions write an audit log entry.

## Requirements

- **Node.js** 24 (the version used in CI) and npm
- **PostgreSQL**: a local install or a hosted database
- **Redis**: any Redis-compatible server. On Windows, [Memurai](https://www.memurai.com/) works.
- Optional, for features that need them:
  - a **Resend** account (email, including sign-in codes for platform staff)
  - an **S3-compatible bucket** such as Cloudflare R2 (file uploads)

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in your own values
npm run migrate              # apply database migrations
npm run seed                 # optional: platform owner plus demo data
npm run dev                  # http://localhost:3000
```

The seed script refuses to run when `NODE_ENV=production`. It prints the seeded platform owner's sign-in details and one-time recovery codes. Signing in as that owner asks for a code sent by email; if email isn't configured locally, use one of the recovery codes.

### Environment variables

All variables are documented in [`.env.example`](.env.example). Copy it to `.env.local`, which is git-ignored, and never commit real values.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `REDIS_URL` | Redis connection string (required) |
| `MFA_ENCRYPTION_KEY` | 32-byte base64 key (required) |
| `TEST_DATABASE_URL` | Separate database for tests; must differ from `DATABASE_URL` |
| `APP_URL` | Base URL used in links inside emails |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery. The sender must be on a domain verified in Resend. |
| `R2_*`, `CLOUDFLARE_ACCOUNT_ID` | Object storage for uploads |
| `TRUSTED_PROXY_HOP_COUNT` | Number of reverse proxies in front of the app (production) |

Rate-limit, token-lifetime and seed-account settings are optional and have defaults; see `.env.example`.

## Database

The schema lives in `lib/db/schema.ts`. Migrations are SQL files in `drizzle/` and are committed to the repository.

```bash
npm run db:generate   # create a new migration from schema changes
npm run migrate       # apply pending migrations (reads .env.local)
npm run migrate:prod  # apply migrations using DATABASE_URL from the environment
```

Back up the database before applying migrations to any shared environment.

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Production build (also type-checks) |
| `npm start` | Run the production build |
| `npm run lint` | ESLint |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright, starts its own server on port 3100) |
| `npm run audit:prod` | Audit production dependencies for high or critical advisories |
| `npm run worker` | Run the notification worker in development |
| `npm run build:worker` | Bundle the worker to `dist/worker.mjs` |
| `npm run start:worker` | Run the bundled worker |
| `npm run db:generate` / `migrate` / `migrate:prod` / `seed` | See [Database](#database) and [Local development](#local-development) |

### Tests

Integration tests write to a real database, so `npm test` and `npm run test:e2e` refuse to run unless `TEST_DATABASE_URL` is set to a database different from `DATABASE_URL`. See [`docs/testing-database.md`](docs/testing-database.md). Email and other external services are mocked in tests.

### Background worker

Notifications are queued in Redis (BullMQ) and sent by a separate worker process. Run `npm run worker` alongside `npm run dev` when you need notifications delivered locally. In production, run `npm run build:worker` and then `npm run start:worker`.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every pull request. It installs PostgreSQL and Redis on the runner and then runs, in order:

1. production dependency audit
2. lint
3. build
4. worker bundle
5. migrations on a fresh database
6. tests
7. seed smoke test
8. Playwright

The workflow needs one repository secret, `CI_MFA_ENCRYPTION_KEY`.

## Deployment

**In place today:**

- production build (`npm run build`, then `npm start`)
- standalone migration runner (`npm run migrate:prod`)
- bundled worker (`npm run build:worker`, then `npm run start:worker`)
- health endpoints: `/api/health`, `/api/health/live`, `/api/health/ready`
- CI that runs on every push to `main` and on every pull request

**Not yet in place:**

- automated deployment
- a chosen production host
- production monitoring and backup schedules

The CI workflow does not deploy.

A production deployment needs:
- HTTPS in front of the app
- `TRUSTED_PROXY_HOP_COUNT` set to match the proxy setup
- the web app and the worker both running
- `npm run migrate:prod` run once per release, after a backup

## Security

- Passwords are hashed with Argon2. Session tokens are stored only as hashes.
- Platform staff must pass two-step verification: an emailed one-time code, or a single-use recovery code.
- Sign-in, verification and password-reset endpoints are rate-limited per IP and per account. They fail closed if Redis is unavailable.
- Security headers (Content Security Policy, frame protection, `nosniff`, Referrer-Policy and Permissions-Policy) are set in `next.config.ts`. HSTS and `upgrade-insecure-requests` are added only when the build runs with `APP_HTTPS_ENABLED=true` (see `deploy/README.md`).
- Tenant isolation is enforced server-side on every query. Permissions are checked in Server Actions, not in the UI.
- Finance submissions use idempotency keys so a repeated submit is not recorded twice.
- Secrets come only from environment variables, and logs are redacted.

Please report security issues privately to the maintainers rather than opening a public issue.

## Project structure

```
app/              Next.js routes: academy/, platform/, account/, auth pages, verify/, api/health
components/       Shared UI components
lib/              Domain logic (academies/, platform/), auth/, db/ (schema), email/, notifications/, ui/
drizzle/          SQL migrations and migration metadata
e2e/              Playwright end-to-end tests and fixtures
scripts/          migrate, seed, worker and worker build scripts
docs/             Testing database, backup drill, release checklist, dependency advisories, brand assets
public/           Static assets
PLAN.md           Product and implementation specification
DESIGN.md         UI/UX specification
PRODUCT.md        Product overview
```

## License

This repository does not include a license file.
