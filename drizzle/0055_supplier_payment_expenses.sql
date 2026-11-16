-- =========================================================================
-- 0055 — Link each supplier payment to its expense record
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0054. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- book_purchase_payments + expense_record_id (nullable FK to expense_records)
--   + a partial UNIQUE index: one supplier payment can never be linked to
--   (or create) two expenses.
--
-- New supplier payments create their expense (status pending_approval, with
-- an approval request) in the same transaction as the payment. Payments
-- recorded before this migration keep expense_record_id NULL — nothing is
-- back-filled automatically, so no expense is created without a person
-- deciding to.
--
-- Additive only. Rollback (manual):
--   DROP INDEX book_purchase_payments_expense_record_unique;
--   ALTER TABLE book_purchase_payments DROP COLUMN expense_record_id;
-- =========================================================================

ALTER TABLE "book_purchase_payments" ADD COLUMN "expense_record_id" uuid;--> statement-breakpoint
ALTER TABLE "book_purchase_payments" ADD CONSTRAINT "book_purchase_payments_expense_record_id_expense_records_id_fk" FOREIGN KEY ("expense_record_id") REFERENCES "public"."expense_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_purchase_payments_expense_record_unique" ON "book_purchase_payments" USING btree ("expense_record_id") WHERE "book_purchase_payments"."expense_record_id" IS NOT NULL;
