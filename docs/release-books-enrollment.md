# Release preparation — Books, supplier expenses, program enrollment

Status: **prepared, not executed.** No production command in this file has
been run. Follow `docs/production-migrations.md`; this file fills in the
release-specific values.

Important: CI deploys **every push to `main` automatically**. Migrations
must be applied to production **before** the release commit reaches
`main`. Pushing is deploying.

## 1. Environment

Server (`/srv/myapp/env/app.env`, checked by `deploy/myapp-deploy`):
`DATABASE_URL`, `REDIS_URL`, `MFA_ENCRYPTION_KEY`, `TRUSTED_PROXY_HOP_COUNT`
(required); optional ones per `.env.example`. **This release adds no new
environment variable.**

Build (GitHub repository variables, fixed at build time):
`NEXT_PUBLIC_SITE_URL=https://hirgal.dardar.cc` (set), `APP_HTTPS_ENABLED`
(unset/"false" until HTTPS works).

Migration step: the same `DATABASE_URL` from `app.env`, or a migration-only
role file (runbook step 6 note).

## 2. Migrations in this release

Expected production state before: last applied `0047`
(`created_at = 1794000000000`). Pending, applied in one transaction by
`scripts/migrate.mjs`, in this order:

| # | Tag | `when` | Change |
|---|---|---|---|
| 0048 | batch_course_dates | 1794100000000 | `batch_courses.start_date/end_date` (nullable) + check |
| 0049 | program_enrollments | 1794200000000 | new `program_enrollments`; nullable owner links on fee periods/payments/refunds + CHECKs |
| 0050 | batch_dates_optional | 1794300000000 | `batches.start_date` DROP NOT NULL |
| 0051 | book_orders | 1794400000000 | new book order tables |
| 0052 | book_order_buyers | 1794500000000 | buyer columns on the 0051 tables |
| 0053 | book_purchase_orders | 1794600000000 | new supplier purchase tables |
| 0054 | book_order_receiving | 1794700000000 | `quantity_received`, `book_order_receipts` (UPDATE touches 0 rows in prod) |
| 0055 | supplier_payment_expenses | 1794800000000 | `book_purchase_payments.expense_record_id` + FK + partial unique index (supplier tables stay empty; supplier purchasing was removed from the app) |
| 0056 | book_order_numbers | 1794900000000 | `book_orders.order_number` (per academy, unique, existing rows numbered) + `buyer_email` |

All additive (expand-only); no DROP, rename or delete of existing data.
Historical supplier payments without an expense: none possible in
production (0053 and 0055 arrive together); dev 0/1, test 0/7.

## 3. Procedure (runbook step numbers)

1. **CI** — open the PR with the release commit(s); CI applies every
   migration to an empty database and runs the full suite. Green only.
   Do **not** run `npm run db:generate` (see §6).
2–3. **Fetch and unpack** the PR run's `release` artifact on the VPS.
4. **Preview** (runbook step 4 command, unchanged). Expected output:
   `pending: 0048_batch_course_dates, 0049_program_enrollments,
   0050_batch_dates_optional, 0051_book_orders, 0052_book_order_buyers,
   0053_book_purchase_orders, 0054_book_order_receiving,
   0055_supplier_payment_expenses, 0056_book_order_numbers`.
   Anything else → stop.
5. **Backup** — Neon branch of production right before migrating, plus
   the runbook `pg_dump` and `pg_restore --list` check.
6. **Apply** — runbook step 6 (`node scripts/migrate.mjs` via
   `systemd-run`). Expect `Migrations complete.` Run step 4 again →
   `pending: none`.
7. **Verify** (read-only, same `systemd-run` wrapper as step 4):

   ```sql
   select max(created_at) from drizzle.__drizzle_migrations;          -- 1794900000000
   select count(*) from drizzle.__drizzle_migrations
     where created_at > 1794000000000;                                -- 9
   select to_regclass('public.program_enrollments'), to_regclass('public.book_orders'),
          to_regclass('public.book_purchase_payments'), to_regclass('public.book_order_receipts');  -- all non-null
   select column_name from information_schema.columns
     where table_name = 'book_purchase_payments' and column_name = 'expense_record_id';  -- 1 row
   select indexname from pg_indexes where indexname = 'book_purchase_payments_expense_record_unique';  -- 1 row
   ```

   The running (old) release keeps serving during and after this.
8. **Deploy** — merge to `main`. CI builds with `NEXT_PUBLIC_SITE_URL`,
   then `myapp-deploy` does: switch release → restart **app** → health gate
   (`/api/health`) → restart **worker** → worker stability check. On a
   failed gate it restores the previous release automatically.
9. **Smoke test** — `curl -s http://127.0.0.1:3000/api/health`, then the
   browser checklist (`docs/browser-testing-checklist.md`) on production
   with a test academy.
10. **Clean up** per runbook step 8. Keep the backup.

## 4. Rollback considerations

- **Migration fails** → its single transaction rolls back; nothing applied.
  Do not merge.
- **Deploy fails after migrating** → `myapp-deploy` restores the previous
  release, which runs on the expanded schema. Safe while no new-shape data
  exists.
- **Rolling code back after the new release was used** is *not* fully
  safe: rows the new code creates are valid in the new schema but unknown
  to the old code — batches with no `start_date` (0050), fee periods /
  payments owned by a program enrollment with `enrollment_id` NULL (0049).
  Old pages that format a batch start date or join on `enrollment_id` may
  show wrong or broken values. Prefer **fix-forward**.
- **Schema rollback** → only by restoring the pre-migration Neon branch /
  dump, which discards every write since (deliberate, manual decision;
  stop app and worker first). The SQL files' "Rollback (manual)" notes drop
  the new tables and their data — never run them on production without a
  separate decision.

## 5. Release scope decision still open

The Books/enrollment release and the Academy Owner/Administrator + Trainer
permission work are separable as patches (see
`C:\acad\academy-release-split-2026-11-15\README.md`), but the release's
behaviour and tests assume the Owner/Admin "manage" levels on Books and
student payments. Decide: ship together, or ship release-only with its
tests moved to a Manager.

## 6. Migration timestamps — rules for the next migration

- `drizzle-orm` 0.45.2 migrator: reads the **single latest**
  `created_at` from `drizzle.__drizzle_migrations`, then applies, in
  journal order, every entry whose `when` is **greater**. It never checks
  for gaps, and it does not compare hashes of already-applied files.
- 0048–0055 use synthetic `when` values (+100,000,000 ms each). 0055 is
  `2026-11-16T03:33:20Z`, ahead of real time on 2026-11-15.
- `drizzle-kit generate` (0.31.11) stamps a new entry with `Date.now()`.
  Generated before 2026-11-16 03:33:20 UTC it would get a **smaller**
  `when` than 0055: CI (empty DB) would apply it and pass, but every
  database already at 0055 (dev, test, production after this release)
  would **skip it silently, permanently**.
- Separately, `drizzle/meta` snapshots stop at `0030`; 0031–0055 were
  written by hand. `npm run db:generate` would diff against the 0030
  snapshot and re-emit everything since (duplicate CREATE TABLE etc.).
  Runbook step 1's "(`npm run db:generate`)" does not match how
  migrations are actually made.

**Recommendation:** keep writing migrations by hand until the snapshots
are rebuilt deliberately. For each new one: next `idx`, tag
`00NN_name`, and `when` = `max(Date.now(), previous when + 1)`; following
the existing pattern, `0057` → `1795000000000` is safe (0056 used `1794900000000`). Never edit or
re-date 0048–0055. Worth adding later (not done): a unit test that the
journal `when` values strictly increase and every `.sql` has exactly one
journal entry; and a runbook fix for step 1.
