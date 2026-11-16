-- =========================================================================
-- 0056 — Book orders get a per-academy order number and an optional buyer
-- email (unified Create Order for a Student or an Other Buyer)
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0055. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- book_orders
--   + order_number: 1, 2, 3 ... per academy, shown to staff (unique per
--     academy). Existing rows are numbered in creation order, so every row
--     has one before the column becomes NOT NULL. New orders get the next
--     number from the server, under a per-academy transaction lock.
--   + buyer_email: optional contact for an Other Buyer.
--
-- Additive only: no row is deleted, no existing value is changed. Supplier
-- tables from 0053-0055 are left exactly as they are (history).
--
-- Rollback (manual):
--   DROP INDEX book_orders_academy_order_number_unique;
--   ALTER TABLE book_orders DROP COLUMN order_number, DROP COLUMN buyer_email;
-- =========================================================================

ALTER TABLE "book_orders" ADD COLUMN "order_number" integer;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "buyer_email" text;--> statement-breakpoint
UPDATE "book_orders" AS o SET "order_number" = n.rn FROM (SELECT "id", row_number() OVER (PARTITION BY "academy_id" ORDER BY "created_at", "id") AS rn FROM "book_orders") AS n WHERE n."id" = o."id";--> statement-breakpoint
ALTER TABLE "book_orders" ALTER COLUMN "order_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_order_number_positive" CHECK ("book_orders"."order_number" > 0);--> statement-breakpoint
CREATE UNIQUE INDEX "book_orders_academy_order_number_unique" ON "book_orders" USING btree ("academy_id","order_number");
