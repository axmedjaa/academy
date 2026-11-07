-- =========================================================================
-- 0046 — Duplicate-submission protection for finance records (SEC-M-06)
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0045. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- What it does
--   Adds an optional `idempotency_key` (uuid) to the four tables that record
--   money taken in or paid out from a staff form:
--     student_payments  (charge payments, fee-period and enrollment payments)
--     income_records    (manual income)
--     expense_records   (manual expenses)
--     book_sales        (direct book sales)
--   and a per-academy unique index on (academy_id, idempotency_key).
--
--   The form generates one key per submission and resends the same key on a
--   retry (double click, network retry, resubmitted form). The application
--   looks the key up first and returns the original record; if two identical
--   requests race, the unique index lets exactly one insert commit and the
--   other's whole transaction (audit rows, stock change, linked income,
--   charge recalculation) rolls back, after which it returns the winner.
--
-- Existing data
--   No existing row is changed. The new column is nullable with no default,
--   so every existing row keeps NULL, and ADD COLUMN is a catalog-only change
--   (no table rewrite). The indexes are partial (WHERE idempotency_key IS NOT
--   NULL): rows without a key are not indexed and never conflict. Rows that
--   the application writes without a key (reversals, pre-order income,
--   internal callers) keep NULL as before.
--
-- Locking
--   CREATE UNIQUE INDEX (not CONCURRENTLY, because migrations run inside a
--   transaction) blocks writes to each table while its index is built. The
--   partial index only covers new keyed rows, so on existing data the build
--   is a quick scan.
--
-- Rollback (manual)
--   DROP INDEX the four indexes, then ALTER TABLE ... DROP COLUMN
--   idempotency_key on the four tables. The application tolerates the
--   column being absent only if the code from the same release is also
--   rolled back.
-- =========================================================================
ALTER TABLE "student_payments" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "student_payments_academy_idempotency_unique" ON "student_payments" USING btree ("academy_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "income_records" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "income_records_academy_idempotency_unique" ON "income_records" USING btree ("academy_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_records" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_records_academy_idempotency_unique" ON "expense_records" USING btree ("academy_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "book_sales" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "book_sales_academy_idempotency_unique" ON "book_sales" USING btree ("academy_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
