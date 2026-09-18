# Production Release Checklist Sign-Off (Phase 5, Item 67)

This document reviews the actual repository state against PLAN.md's "Final
Documentation & Release Checklist" section, item by item. It is a
sign-off review, not new implementation — every decision below either
points at code/tests that already exist, or names an explicit,
PLAN.md-sanctioned deferral.

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
| Object storage provider | Deferred | ⚠️ See "Known limitation" below — no interface exists yet, not even a stub |
| Email provider | Deferred | ⚠️ See "Known limitation" below — log-only stub, no interface |
| SMS provider | Deferred | ⚠️ See "Known limitation" below — log-only stub, no interface |
| Domain / DNS / TLS management | Deferred | N/A — provider choice only |
| Secrets-management approach | Deferred (fixed requirement: env-injected, never committed/logged) | ✅ Met — every credential in this codebase is read via `lib/env.ts` from environment variables; `.env.local` is gitignored; `lib/redact.ts` strips password/token/secret fields from logs and audit rows |
| Monitoring provider | Deferred (fixed requirement: Sentry-class tool required) | ✅ Requirement met via `lib/monitoring/` (Item 62) — a real, working `MonitoringSink` interface with a log-based default sink; the *provider* (an actual Sentry account, etc.) remains a deployment-time choice, exactly as PLAN.md frames it |
| Backup schedule / retention / RPO / RTO | Deferred (fixed requirement: the drill itself is required) | ✅ Met — see `docs/backup-restore-drill.md`: a real `pg_dump`/`pg_restore` cycle was executed and verified (43/43 tables, 923/923 rows matched exactly) |

## Checklist bullets

- **Environment variables** — ✅ Complete. `.env.example` inventories every required/optional var (DB, Redis, session/MFA encryption keys, every rate-limit threshold, seed credentials). `lib/env.ts` fails loudly at startup (Zod-validated) if a required var is missing.
- **Local development setup** — ✅ Complete. `README.md` documents the native-Windows PostgreSQL + Memurai setup (no Docker/containers anywhere), `npm install && npm run migrate && npm run seed`.
- **Seed & Demonstration Data** — ✅ Complete as of this Item 67 pass. `scripts/seed.ts` now seeds, in addition to the one MFA-enrolled `platform_owner`: one demo academy, 2 branches, one account per academy role (owner/admin/manager/admissions officer/finance officer/trainer), 10 students, 2 courses/batches with a fully published result set, 4 student charges with a mix of paid/partially-paid/open payments, 2 income records, 2 expense records, and 1 issued certificate. Idempotent (verified: running it twice produces zero duplicate rows) and guarded against `NODE_ENV=production`, same as the original platform_owner seed.
- **Database migrations** — ✅ Complete. Drizzle Kit-generated, checked into `drizzle/`, applied in CI on every run (`npm run migrate`); `drizzle-kit check` reports no drift as of this review.
- **Deployment** — ⚠️ Deployment-dependent. Provider-agnostic steps are implied by the existing scripts (`npm run build`, `npm run migrate`, start the app + a separate BullMQ worker process), but no specific hosting target has been chosen, consistent with PLAN.md's own "Deployment target is undecided" stance.
- **Secrets management** — ✅ Requirement met (see table above).
- **Health checks** — ✅ Complete as of this Item 67 pass. `GET /api/health` (new) checks database connectivity (`select 1`), Redis connectivity (`PING`), and notification-queue health (reusing `lib/monitoring/queue-health.ts`'s existing thresholds) — returns `200`/`{"status":"ok",...}` when healthy, `503`/`{"status":"degraded",...}` otherwise, with per-check `"ok"`/`"error"` verdicts only (no connection strings, stack traces, or raw internal counts ever included in the response).
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
| Student-payment reversal does not recalculate the linked charge's status | `lib/academies/student-payments.ts` (~line 925) |
| Subscription-expiry-reminder BullMQ job is built but has no live consumer wired at process startup | `lib/subscriptions/expiry-reminder-job.ts` |
| Rate limiting (login, MFA, certificate verification) trusts the first `X-Forwarded-For` header value; production deployment must terminate behind a trusted reverse proxy that sets it | `lib/auth/actions.ts`, `lib/auth/mfa-actions.ts`, `lib/academies/certificate-verify-rate-limit.ts`, `app/verify/[certificateCode]/page.tsx` |
| Notification preferences are stored but not yet consulted by `enqueueNotification` — every event currently sends regardless of a user's toggle | `lib/notifications/preferences.ts` |
| A notification addressed to "any current member of an academy" (null `user_id`) is a single shared row — one viewer marking it read does not, and cannot yet, hide it individually for others | `lib/notifications/list-notifications.ts` |
| `/academy/finance-reports` and `/academy/reports`'s Finance tab both exist and both work, rendering the same component — not yet consolidated into one route | `app/academy/reports/page.tsx` |
| `npm audit` reports 4 moderate-severity vulnerabilities, entirely from `drizzle-kit`'s transitive `esbuild` dependency (dev-tooling only, never reaches production); the only available fix is a breaking downgrade, intentionally not applied | `docs/npm-audit-findings.md` |

## Documentation inaccuracy in PLAN.md

PLAN.md states, in two places (line 16 and line 740), that
**`lib/storage`, `lib/email`, and `lib/sms` "are already built behind
provider-agnostic interfaces."** This is not accurate as of this review:

- No `lib/storage`, `lib/email`, or `lib/sms` directory or file exists
  anywhere in this repository.
- Email/SMS "sending" (`lib/notifications/worker.ts`'s `sendEmail`/
  `sendSms`) is two `logger.info(...)` calls — a log statement, not an
  interface, adapter, or even a stub class implementing a defined
  contract.
- File-upload handling does not exist at all: `staffDocuments`/
  `studentDocuments`'s `file_ref` columns have no attached storage
  adapter, and no multipart/upload code exists anywhere in the codebase.

This does not block release — every provider each of these would back is
independently listed "Deferred — non-blocking" in the table above — but
the specific claim that they are "already built" should be corrected in
PLAN.md itself so a future reader does not mistake this for a completed
deliverable. Not corrected as part of this document, per this task's own
instruction to report rather than fix it.

## Sign-off

All items in PLAN.md's Final Documentation & Release Checklist are either
complete, or explicitly and correctly deferred to a future hosting
decision per PLAN.md's own stated posture. Phase 5, Item 67 is complete.
