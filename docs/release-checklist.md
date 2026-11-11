# Production Release Checklist Sign-Off (Phase 5, Item 67)

This document reviews the actual repository state against PLAN.md's "Final
Documentation & Release Checklist" section, item by item. It is a
sign-off review, not new implementation — every decision below either
points at code/tests that already exist, or names an explicit,
PLAN.md-sanctioned deferral.

**Last reviewed:** 2026-11-08 (updated from the original Item 67 sign-off to
reflect email, file storage, worker and security work completed since).

## Deployment & Ops Decisions

PLAN.md's own table marks every row below **"Deferred — non-blocking"** —
the specific hosting provider is not this project's decision to make before
release; only the *requirement* each row implies is fixed now. Status
below reflects whether that fixed requirement is actually met today.

| Decision | PLAN.md status | Fixed requirement met? |
|---|---|---|
| Production hosting provider | Deferred | N/A — provider choice only |
| PostgreSQL hosting | Deferred | N/A — provider choice only |
| Redis hosting | Deferred | N/A — provider choice only |
| Object storage provider | Deferred | ✅ Implemented behind `lib/storage/`: an S3-compatible client (Cloudflare R2 via the AWS SDK) with presigned uploads, a shared upload policy (`lib/storage/upload-policy.ts`) and server-side verification of each upload (`lib/storage/verify-upload.ts`). Used for academy logos, book covers, course images and student photos. Production needs its own private bucket and credentials. |
| Email provider | Deferred | ✅ Implemented behind `lib/email/client.ts` (Resend). Used for password reset, email-change verification, sign-in verification codes for platform staff, and queued notifications. Production needs a sending domain verified in Resend (plus SPF/DKIM/DMARC); with Resend's test sender, mail only reaches the Resend account owner. |
| SMS provider | Deferred | ⚠️ Not implemented. There is no SMS provider and no `lib/sms`; the notification worker marks SMS jobs as skipped (`sms_not_configured`). |
| Domain / DNS / TLS management | Deferred | N/A — provider choice only |
| Secrets-management approach | Deferred (fixed requirement: env-injected, never committed/logged) | ✅ Met — every credential in this codebase is read via `lib/env.ts` from environment variables; `.env.local` is gitignored; `lib/redact.ts` strips password/token/secret fields from logs and audit rows |
| Monitoring provider | Deferred (fixed requirement: Sentry-class tool required) | ✅ Requirement met via `lib/monitoring/` (Item 62) — a real, working `MonitoringSink` interface with a log-based default sink; the *provider* (an actual Sentry account, etc.) remains a deployment-time choice, exactly as PLAN.md frames it |
| Backup schedule / retention / RPO / RTO | Deferred (fixed requirement: the drill itself is required) | ✅ Met — see `docs/backup-restore-drill.md`: a real `pg_dump`/`pg_restore` cycle was executed and verified (43/43 tables, 923/923 rows matched exactly) |

## Checklist bullets

- **Environment variables** — ✅ Complete. `.env.example` inventories every required/optional var (DB, Redis, MFA encryption key, email, object storage, every rate-limit threshold, trusted-proxy hop count, seed credentials). `lib/env.ts` fails loudly at startup (Zod-validated) if a required var is missing, and a production server refuses to start without `TRUSTED_PROXY_HOP_COUNT`.
- **Local development setup** — ✅ Complete. `README.md` documents the requirements (Node.js, PostgreSQL, a Redis-compatible server such as Memurai on Windows), `.env.local` setup, and `npm install`, `npm run migrate`, `npm run seed`, `npm run dev`.
- **Seed & Demonstration Data** — ✅ Complete. `scripts/seed.ts` seeds one `platform_owner` (with one-time recovery codes; sign-in verification is by emailed code) plus one demo academy, 2 branches, one account per assignable academy role (owner/admin/manager/trainer), 10 students, 2 courses/batches with a fully published result set, 4 student charges with a mix of paid/partially-paid/open payments, 2 income records, 2 expense records, and 1 issued certificate. Idempotent and guarded against `NODE_ENV=production`. CI runs it as a smoke test on every push.
- **Database migrations** — ✅ Complete. Drizzle Kit-generated and checked into `drizzle/`. `npm run migrate` (development, reads `.env.local`) and `npm run migrate:prod` (production, `DATABASE_URL` only) both run `scripts/migrate.mjs`; CI applies every migration to fresh databases on every run.
- **Deployment** — Hostinger VPS (Ubuntu 24.04), no Docker. CI deploys every green push to `main` over a restricted SSH key to `/usr/local/bin/myapp-deploy`, which switches releases behind a health gate and rolls back on failure; the web app and the BullMQ worker run as `myapp.service` and `myapp-worker.service`. Server files and install steps: `deploy/README.md`. Migrations are never automatic: `docs/production-migrations.md`.
- **Secrets management** — ✅ Requirement met (see table above).
- **Health checks** — ✅ Complete. `GET /api/health/live` (process liveness), `GET /api/health/ready` (readiness), and `GET /api/health`, which checks database connectivity (`select 1`), Redis connectivity (`PING`), and notification-queue health (reusing `lib/monitoring/queue-health.ts`'s existing thresholds) — returns `200`/`{"status":"ok",...}` when healthy, `503`/`{"status":"degraded",...}` otherwise, with per-check `"ok"`/`"error"` verdicts only (no connection strings, stack traces, or raw internal counts ever included in the response).
- **Monitoring** — ✅ Requirement met (see table above); provider choice deferred.
- **Backup / restore** — ✅ Complete — see `docs/backup-restore-drill.md`.
- **Incident response** — ✅ Requirement met by design. `platform_owner` is the incident-response owner for MVP; no on-call rotation is in scope, consistent with PLAN.md's "single-operator SaaS at MVP stage" framing.
- **External support process** — ✅ Requirement met by design. Support is handled outside the product (Decision #14) — no in-app ticketing exists or is planned. Confirming the out-of-band contact channel itself is documented is an operator task at actual launch time, not a code deliverable.

## Known accepted/deferred limitations

These were found and documented during Phase 5's own security re-audit
(Item 63) and later waves. None block release; each is either a narrow,
non-security functional gap or an explicit, deployment-dependent
assumption. None are part of Item 67's own scope.

| Limitation | Documented at |
|---|---|
| Per-IP rate limits (login, MFA, certificate verification) derive the client IP via `lib/http/client-ip.ts`'s `TRUSTED_PROXY_HOP_COUNT`-aware extraction. The production deployment must sit behind a verified trusted reverse proxy/CDN with `TRUSTED_PROXY_HOP_COUNT` set to match it; a production server refuses to start if it is unset. The per-account login and per-user MFA limits do not depend on the IP. | `lib/http/client-ip.ts`, `lib/http/proxy-trust-check.ts`, `lib/auth/login-rate-limit.ts` |
| Notification preferences are stored but not yet consulted by `enqueueNotification` — every event currently sends regardless of a user's toggle | `lib/notifications/preferences.ts` |
| A notification addressed to "any current member of an academy" (null `user_id`) is a single shared row — one viewer marking it read does not, and cannot yet, hide it individually for others | `lib/notifications/list-notifications.ts` |
| `/academy/finance-reports` and `/academy/reports`'s Finance tab both exist and both work, rendering the same component — not yet consolidated into one route | `app/academy/reports/page.tsx` |
| `npm audit` (2026-11-08) reports 0 vulnerabilities in production dependencies and 12 moderate findings in development-only tooling. CI fails on any high or critical advisory in production dependencies (`npm run audit:prod`). | `docs/dependency-advisories.md`, `docs/npm-audit-findings.md` |

## PLAN.md accuracy note

PLAN.md states that `lib/storage`, `lib/email` and `lib/sms` "are already
built behind provider-agnostic interfaces." As of this review that is true
for `lib/storage` (S3-compatible object storage) and `lib/email` (Resend),
but not for SMS: there is no `lib/sms`, and SMS notification jobs are
skipped. PLAN.md itself has not been edited.

## Sign-off

All items in PLAN.md's Final Documentation & Release Checklist are either
complete, or explicitly deferred to a future hosting decision per PLAN.md's
own stated posture. Before a production launch, the remaining work is the
deployment itself: choosing a host, TLS and the trusted proxy setup, a
verified email sending domain, a private storage bucket, a monitoring
provider, scheduled backups, and running the web app and worker together.
