-- Book Management redesign: book subject/class, and book pre-orders
-- (campaigns, multi-book student orders, payments, receiving, handovers).
-- Additive only: no existing column, row or constraint is changed or dropped.
-- Ordinary sales (book_sales*) and books.stock_quantity are untouched.
--
-- Rollback (manual, in this order): drop tables book_preorder_handovers,
-- book_preorder_receipts, book_preorder_payments, book_preorder_items,
-- book_preorders, book_preorder_campaign_books, book_preorder_campaigns;
-- drop types book_preorder_payment_method and book_preorder_campaign_status;
-- drop columns class_level and subject from books. Income rows posted by
-- pre-order payments (category 'book_preorder') stay in income_records.

ALTER TABLE "books" ADD COLUMN "subject" text;
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "class_level" text;
--> statement-breakpoint
CREATE TYPE "public"."book_preorder_campaign_status" AS ENUM('draft', 'scheduled', 'open', 'closed', 'receiving', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."book_preorder_payment_method" AS ENUM('cash', 'mobile_money', 'bank_transfer', 'other');
--> statement-breakpoint
CREATE TABLE "book_preorder_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"opens_on" date NOT NULL,
	"closes_on" date NOT NULL,
	"expected_arrival_on" date NOT NULL,
	"status" "book_preorder_campaign_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorder_campaigns_closes_after_opens" CHECK ("book_preorder_campaigns"."closes_on" >= "book_preorder_campaigns"."opens_on"),
	CONSTRAINT "book_preorder_campaigns_arrival_after_closes" CHECK ("book_preorder_campaigns"."expected_arrival_on" >= "book_preorder_campaigns"."closes_on")
);
--> statement-breakpoint
ALTER TABLE "book_preorder_campaigns" ADD CONSTRAINT "book_preorder_campaigns_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_campaigns" ADD CONSTRAINT "book_preorder_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "book_preorder_campaigns_academy_id_idx" ON "book_preorder_campaigns" USING btree ("academy_id");
--> statement-breakpoint
CREATE TABLE "book_preorder_campaign_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorder_campaign_books_limit_positive" CHECK ("book_preorder_campaign_books"."quantity_limit" IS NULL OR "book_preorder_campaign_books"."quantity_limit" > 0)
);
--> statement-breakpoint
ALTER TABLE "book_preorder_campaign_books" ADD CONSTRAINT "book_preorder_campaign_books_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_campaign_books" ADD CONSTRAINT "book_preorder_campaign_books_campaign_id_book_preorder_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."book_preorder_campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_campaign_books" ADD CONSTRAINT "book_preorder_campaign_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorder_campaign_books_campaign_book_unique" ON "book_preorder_campaign_books" USING btree ("campaign_id","book_id");
--> statement-breakpoint
CREATE INDEX "book_preorder_campaign_books_academy_id_idx" ON "book_preorder_campaign_books" USING btree ("academy_id");
--> statement-breakpoint
CREATE TABLE "book_preorders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_percent" integer DEFAULT 0 NOT NULL,
	"discount_amount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorders_subtotal_nonnegative" CHECK ("book_preorders"."subtotal_cents" >= 0),
	CONSTRAINT "book_preorders_discount_percent_range" CHECK ("book_preorders"."discount_percent" BETWEEN 0 AND 100),
	CONSTRAINT "book_preorders_discount_amount_nonnegative" CHECK ("book_preorders"."discount_amount_cents" >= 0),
	CONSTRAINT "book_preorders_total_nonnegative" CHECK ("book_preorders"."total_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_campaign_id_book_preorder_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."book_preorder_campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorders_academy_reference_unique" ON "book_preorders" USING btree ("academy_id","reference");
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorders_academy_idempotency_unique" ON "book_preorders" USING btree ("academy_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "book_preorders_campaign_id_idx" ON "book_preorders" USING btree ("campaign_id");
--> statement-breakpoint
CREATE INDEX "book_preorders_student_id_idx" ON "book_preorders" USING btree ("student_id");
--> statement-breakpoint
CREATE INDEX "book_preorders_branch_id_idx" ON "book_preorders" USING btree ("branch_id");
--> statement-breakpoint
CREATE TABLE "book_preorder_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"given_quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "book_preorder_items_quantity_positive" CHECK ("book_preorder_items"."quantity" > 0),
	CONSTRAINT "book_preorder_items_unit_price_nonnegative" CHECK ("book_preorder_items"."unit_price_cents" >= 0),
	CONSTRAINT "book_preorder_items_given_range" CHECK ("book_preorder_items"."given_quantity" >= 0 AND "book_preorder_items"."given_quantity" <= "book_preorder_items"."quantity")
);
--> statement-breakpoint
ALTER TABLE "book_preorder_items" ADD CONSTRAINT "book_preorder_items_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_items" ADD CONSTRAINT "book_preorder_items_order_id_book_preorders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_preorders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_items" ADD CONSTRAINT "book_preorder_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorder_items_order_book_unique" ON "book_preorder_items" USING btree ("order_id","book_id");
--> statement-breakpoint
CREATE INDEX "book_preorder_items_book_id_idx" ON "book_preorder_items" USING btree ("book_id");
--> statement-breakpoint
CREATE TABLE "book_preorder_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "book_preorder_payment_method" NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"income_record_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorder_payments_amount_positive" CHECK ("book_preorder_payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "book_preorder_payments" ADD CONSTRAINT "book_preorder_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_payments" ADD CONSTRAINT "book_preorder_payments_order_id_book_preorders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_preorders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_payments" ADD CONSTRAINT "book_preorder_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_payments" ADD CONSTRAINT "book_preorder_payments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_payments" ADD CONSTRAINT "book_preorder_payments_income_record_id_income_records_id_fk" FOREIGN KEY ("income_record_id") REFERENCES "public"."income_records"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorder_payments_academy_idempotency_unique" ON "book_preorder_payments" USING btree ("academy_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "book_preorder_payments_order_id_idx" ON "book_preorder_payments" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE "book_preorder_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity_received" integer NOT NULL,
	"damaged_quantity" integer DEFAULT 0 NOT NULL,
	"received_on" date NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorder_receipts_received_positive" CHECK ("book_preorder_receipts"."quantity_received" > 0),
	CONSTRAINT "book_preorder_receipts_damaged_range" CHECK ("book_preorder_receipts"."damaged_quantity" >= 0 AND "book_preorder_receipts"."damaged_quantity" <= "book_preorder_receipts"."quantity_received")
);
--> statement-breakpoint
ALTER TABLE "book_preorder_receipts" ADD CONSTRAINT "book_preorder_receipts_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_receipts" ADD CONSTRAINT "book_preorder_receipts_campaign_id_book_preorder_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."book_preorder_campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_receipts" ADD CONSTRAINT "book_preorder_receipts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_receipts" ADD CONSTRAINT "book_preorder_receipts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorder_receipts_academy_idempotency_unique" ON "book_preorder_receipts" USING btree ("academy_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "book_preorder_receipts_campaign_book_idx" ON "book_preorder_receipts" USING btree ("campaign_id","book_id");
--> statement-breakpoint
CREATE TABLE "book_preorder_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"given_by" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_preorder_handovers_quantity_positive" CHECK ("book_preorder_handovers"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_order_id_book_preorders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_preorders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_order_item_id_book_preorder_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."book_preorder_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_campaign_id_book_preorder_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."book_preorder_campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "book_preorder_handovers" ADD CONSTRAINT "book_preorder_handovers_given_by_users_id_fk" FOREIGN KEY ("given_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "book_preorder_handovers_academy_idempotency_unique" ON "book_preorder_handovers" USING btree ("academy_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "book_preorder_handovers_order_id_idx" ON "book_preorder_handovers" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "book_preorder_handovers_campaign_book_idx" ON "book_preorder_handovers" USING btree ("campaign_id","book_id");
