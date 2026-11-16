-- =========================================================================
-- 0054 — Receive Stock on a book order (partial deliveries, history)
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0053. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- book_order_items   + quantity_received (default 0; 0 <= received <= ordered)
-- book_order_receipts  new: each delivery per line (date, note, who) — only
--                      these quantities are added to stock
--
-- Safe for existing data: additive. Existing lines get quantity_received = 0,
-- except lines of an order already marked "received" before this change,
-- which are set to their full quantity (that stock was already added then),
-- so they don't show as still due.
--
-- Rollback (manual): DROP TABLE book_order_receipts;
--   ALTER TABLE book_order_items DROP COLUMN quantity_received;
-- =========================================================================

ALTER TABLE "book_order_items" ADD COLUMN "quantity_received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "book_order_items" SET "quantity_received" = "quantity" WHERE "order_id" IN (SELECT "id" FROM "book_orders" WHERE "status" = 'received');--> statement-breakpoint
ALTER TABLE "book_order_items" ADD CONSTRAINT "book_order_items_received_range" CHECK ("book_order_items"."quantity_received" >= 0 AND "book_order_items"."quantity_received" <= "book_order_items"."quantity");--> statement-breakpoint
CREATE TABLE "book_order_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"received_on" date NOT NULL,
	"note" text,
	"idempotency_key" uuid NOT NULL,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_order_receipts_quantity_positive" CHECK ("book_order_receipts"."quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "book_order_receipts" ADD CONSTRAINT "book_order_receipts_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_receipts" ADD CONSTRAINT "book_order_receipts_order_id_book_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_receipts" ADD CONSTRAINT "book_order_receipts_item_id_book_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."book_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_receipts" ADD CONSTRAINT "book_order_receipts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_receipts" ADD CONSTRAINT "book_order_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_order_receipts_key_item_unique" ON "book_order_receipts" USING btree ("academy_id","idempotency_key","item_id");--> statement-breakpoint
CREATE INDEX "book_order_receipts_order_id_idx" ON "book_order_receipts" USING btree ("order_id");
