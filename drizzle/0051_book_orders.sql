-- =========================================================================
-- 0051 — Book Management, simplified: supplier orders, supplier payments,
-- books issued to students
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0050. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- ADDITIVE ONLY: four new tables and two new enums. No existing table,
-- column, constraint or row is changed or deleted. The pre-order tables
-- (book_preorder_*) keep every record; the app shows them read-only.
--
-- book_orders          a purchase order to a supplier (status ordered /
--                      received / cancelled; total computed by the server)
-- book_order_items     its lines: book, quantity, unit cost (line total is
--                      checked = quantity x unit cost)
-- book_order_payments  money the academy paid the supplier for an order;
--                      always tied to an order; payment status is derived
-- book_issues          books given to a student (who, which book, how many,
--                      when, by whom)
--
-- Every write carries an idempotency key unique per academy, so a repeated
-- submit can never create a second order, payment or issue.
--
-- Rollback (manual, only while the tables are empty or unwanted):
--   DROP TABLE book_issues, book_order_payments, book_order_items, book_orders;
--   DROP TYPE book_order_payment_method; DROP TYPE book_order_status;
-- =========================================================================

CREATE TYPE "public"."book_order_status" AS ENUM('ordered', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."book_order_payment_method" AS ENUM('cash', 'mobile_money', 'bank_transfer');--> statement-breakpoint
CREATE TABLE "book_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_phone" text,
	"supplier_reference" text,
	"order_date" date NOT NULL,
	"status" "book_order_status" DEFAULT 'ordered' NOT NULL,
	"currency" text NOT NULL,
	"total_cents" integer NOT NULL,
	"notes" text,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_orders_total_cents_nonnegative" CHECK ("book_orders"."total_cents" >= 0)
);--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_orders_academy_idempotency_unique" ON "book_orders" USING btree ("academy_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "book_orders_academy_id_idx" ON "book_orders" USING btree ("academy_id");--> statement-breakpoint
CREATE TABLE "book_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	CONSTRAINT "book_order_items_quantity_positive" CHECK ("book_order_items"."quantity" > 0),
	CONSTRAINT "book_order_items_unit_cost_nonnegative" CHECK ("book_order_items"."unit_cost_cents" >= 0),
	CONSTRAINT "book_order_items_line_total" CHECK ("book_order_items"."line_total_cents" = "book_order_items"."quantity" * "book_order_items"."unit_cost_cents")
);--> statement-breakpoint
ALTER TABLE "book_order_items" ADD CONSTRAINT "book_order_items_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_items" ADD CONSTRAINT "book_order_items_order_id_book_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_items" ADD CONSTRAINT "book_order_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_order_items_order_book_unique" ON "book_order_items" USING btree ("order_id","book_id");--> statement-breakpoint
CREATE INDEX "book_order_items_book_id_idx" ON "book_order_items" USING btree ("book_id");--> statement-breakpoint
CREATE TABLE "book_order_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "book_order_payment_method" NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_order_payments_amount_cents_positive" CHECK ("book_order_payments"."amount_cents" > 0)
);--> statement-breakpoint
ALTER TABLE "book_order_payments" ADD CONSTRAINT "book_order_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_payments" ADD CONSTRAINT "book_order_payments_order_id_book_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_order_payments" ADD CONSTRAINT "book_order_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_order_payments_academy_idempotency_unique" ON "book_order_payments" USING btree ("academy_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "book_order_payments_order_id_idx" ON "book_order_payments" USING btree ("order_id");--> statement-breakpoint
CREATE TABLE "book_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"issued_on" date NOT NULL,
	"issued_by" uuid NOT NULL,
	"notes" text,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_issues_quantity_positive" CHECK ("book_issues"."quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "book_issues_academy_idempotency_unique" ON "book_issues" USING btree ("academy_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "book_issues_student_id_idx" ON "book_issues" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "book_issues_book_id_idx" ON "book_issues" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_issues_academy_id_idx" ON "book_issues" USING btree ("academy_id");
