-- =========================================================================
-- 0053 — Supplier purchasing: purchase orders, stock receipts, supplier
-- payments (kept apart from student book requests)
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0052. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- ADDITIVE ONLY: one enum and four new tables. No existing table, column or
-- row changes.
--
-- book_purchase_orders       an order to a supplier (status ordered /
--                            partially_received / received / cancelled)
-- book_purchase_order_items  its lines: quantity ordered, quantity received
--                            (0 <= received <= ordered), unit purchase price
-- book_purchase_receipts     receiving history: each delivery, per line —
--                            only these quantities are added to stock
-- book_purchase_payments     money paid to the supplier against an order
--                            (partial or full)
--
-- Every write carries an idempotency key unique per academy, so a repeated
-- submit can't create a second order, receipt or payment.
--
-- Rollback (manual, only while unwanted):
--   DROP TABLE book_purchase_payments, book_purchase_receipts,
--     book_purchase_order_items, book_purchase_orders;
--   DROP TYPE book_purchase_order_status;
-- =========================================================================

CREATE TYPE "public"."book_purchase_order_status" AS ENUM('ordered', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "book_purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_phone" text,
	"supplier_reference" text,
	"order_date" date NOT NULL,
	"status" "book_purchase_order_status" DEFAULT 'ordered' NOT NULL,
	"currency" text NOT NULL,
	"total_cents" integer NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_purchase_orders_total_cents_nonnegative" CHECK ("book_purchase_orders"."total_cents" >= 0)
);--> statement-breakpoint
ALTER TABLE "book_purchase_orders" ADD CONSTRAINT "book_purchase_orders_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_orders" ADD CONSTRAINT "book_purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_purchase_orders_academy_idempotency_unique" ON "book_purchase_orders" USING btree ("academy_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "book_purchase_orders_academy_id_idx" ON "book_purchase_orders" USING btree ("academy_id");--> statement-breakpoint
CREATE TABLE "book_purchase_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	CONSTRAINT "book_purchase_order_items_quantity_positive" CHECK ("book_purchase_order_items"."quantity_ordered" > 0),
	CONSTRAINT "book_purchase_order_items_received_range" CHECK ("book_purchase_order_items"."quantity_received" >= 0 AND "book_purchase_order_items"."quantity_received" <= "book_purchase_order_items"."quantity_ordered"),
	CONSTRAINT "book_purchase_order_items_unit_cost_nonnegative" CHECK ("book_purchase_order_items"."unit_cost_cents" >= 0),
	CONSTRAINT "book_purchase_order_items_line_total" CHECK ("book_purchase_order_items"."line_total_cents" = "book_purchase_order_items"."quantity_ordered" * "book_purchase_order_items"."unit_cost_cents")
);--> statement-breakpoint
ALTER TABLE "book_purchase_order_items" ADD CONSTRAINT "book_purchase_order_items_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_order_items" ADD CONSTRAINT "book_purchase_order_items_purchase_order_id_book_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."book_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_order_items" ADD CONSTRAINT "book_purchase_order_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_purchase_order_items_order_book_unique" ON "book_purchase_order_items" USING btree ("purchase_order_id","book_id");--> statement-breakpoint
CREATE INDEX "book_purchase_order_items_book_id_idx" ON "book_purchase_order_items" USING btree ("book_id");--> statement-breakpoint
CREATE TABLE "book_purchase_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"received_on" date NOT NULL,
	"note" text,
	"idempotency_key" uuid NOT NULL,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_purchase_receipts_quantity_positive" CHECK ("book_purchase_receipts"."quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "book_purchase_receipts" ADD CONSTRAINT "book_purchase_receipts_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_receipts" ADD CONSTRAINT "book_purchase_receipts_purchase_order_id_book_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."book_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_receipts" ADD CONSTRAINT "book_purchase_receipts_item_id_book_purchase_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."book_purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_receipts" ADD CONSTRAINT "book_purchase_receipts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_receipts" ADD CONSTRAINT "book_purchase_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_purchase_receipts_key_item_unique" ON "book_purchase_receipts" USING btree ("academy_id","idempotency_key","item_id");--> statement-breakpoint
CREATE INDEX "book_purchase_receipts_order_id_idx" ON "book_purchase_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE TABLE "book_purchase_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "book_order_payment_method" NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_purchase_payments_amount_cents_positive" CHECK ("book_purchase_payments"."amount_cents" > 0)
);--> statement-breakpoint
ALTER TABLE "book_purchase_payments" ADD CONSTRAINT "book_purchase_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_payments" ADD CONSTRAINT "book_purchase_payments_purchase_order_id_book_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."book_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_purchase_payments" ADD CONSTRAINT "book_purchase_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_purchase_payments_academy_idempotency_unique" ON "book_purchase_payments" USING btree ("academy_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "book_purchase_payments_order_id_idx" ON "book_purchase_payments" USING btree ("purchase_order_id");
