CREATE TYPE "public"."book_buyer_type" AS ENUM('student', 'other_person');--> statement-breakpoint
CREATE TYPE "public"."book_discount_type" AS ENUM('none', 'fixed', 'percentage');--> statement-breakpoint
CREATE TYPE "public"."book_sale_payment_method" AS ENUM('cash', 'mobile_money');--> statement-breakpoint
CREATE TYPE "public"."book_sale_payment_status" AS ENUM('unpaid', 'partially_paid', 'paid');--> statement-breakpoint
CREATE TYPE "public"."book_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."fee_frequency" AS ENUM('monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TABLE "book_sale_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"book_sale_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "book_sale_payment_method" NOT NULL,
	"reference" text,
	"paid_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"income_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_sale_payments_amount_cents_positive" CHECK ("book_sale_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "book_sale_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"book_sale_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"returned_quantity" integer DEFAULT 0 NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_sale_refunds_amount_cents_positive" CHECK ("book_sale_refunds"."amount_cents" > 0),
	CONSTRAINT "book_sale_refunds_returned_quantity_nonnegative" CHECK ("book_sale_refunds"."returned_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "book_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid,
	"book_id" uuid NOT NULL,
	"buyer_type" "book_buyer_type" NOT NULL,
	"student_id" uuid,
	"other_buyer_name" text,
	"other_buyer_phone" text,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_type" "book_discount_type" DEFAULT 'none' NOT NULL,
	"discount_value" integer DEFAULT 0 NOT NULL,
	"discount_amount_cents" integer DEFAULT 0 NOT NULL,
	"final_amount_cents" integer NOT NULL,
	"payment_status" "book_sale_payment_status" DEFAULT 'unpaid' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_sales_quantity_positive" CHECK ("book_sales"."quantity" > 0),
	CONSTRAINT "book_sales_subtotal_cents_nonnegative" CHECK ("book_sales"."subtotal_cents" >= 0),
	CONSTRAINT "book_sales_discount_amount_cents_nonnegative" CHECK ("book_sales"."discount_amount_cents" >= 0),
	CONSTRAINT "book_sales_final_amount_cents_nonnegative" CHECK ("book_sales"."final_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"author" text,
	"isbn" text,
	"category" text,
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"cover_ref" text,
	"status" "book_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_price_cents_nonnegative" CHECK ("books"."price_cents" >= 0),
	CONSTRAINT "books_stock_quantity_nonnegative" CHECK ("books"."stock_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "enrollment_fee_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"frequency" "fee_frequency" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"anchor_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_fee_schedules_amount_cents_positive" CHECK ("enrollment_fee_schedules"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "fee_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"frequency" "fee_frequency" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date NOT NULL,
	"expected_amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_periods_expected_amount_cents_nonnegative" CHECK ("fee_periods"."expected_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_payment_id" uuid NOT NULL,
	"fee_period_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_cents_positive" CHECK ("payment_allocations"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "book_sale_payments" ADD CONSTRAINT "book_sale_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_payments" ADD CONSTRAINT "book_sale_payments_book_sale_id_book_sales_id_fk" FOREIGN KEY ("book_sale_id") REFERENCES "public"."book_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_payments" ADD CONSTRAINT "book_sale_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_payments" ADD CONSTRAINT "book_sale_payments_income_record_id_income_records_id_fk" FOREIGN KEY ("income_record_id") REFERENCES "public"."income_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_refunds" ADD CONSTRAINT "book_sale_refunds_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_refunds" ADD CONSTRAINT "book_sale_refunds_book_sale_id_book_sales_id_fk" FOREIGN KEY ("book_sale_id") REFERENCES "public"."book_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sale_refunds" ADD CONSTRAINT "book_sale_refunds_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sales" ADD CONSTRAINT "book_sales_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sales" ADD CONSTRAINT "book_sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sales" ADD CONSTRAINT "book_sales_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sales" ADD CONSTRAINT "book_sales_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_sales" ADD CONSTRAINT "book_sales_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_enrollment_id_batch_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."batch_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_enrollment_id_batch_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."batch_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_student_payment_id_student_payments_id_fk" FOREIGN KEY ("student_payment_id") REFERENCES "public"."student_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_fee_period_id_fee_periods_id_fk" FOREIGN KEY ("fee_period_id") REFERENCES "public"."fee_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_sale_payments_book_sale_id_idx" ON "book_sale_payments" USING btree ("book_sale_id");--> statement-breakpoint
CREATE INDEX "book_sale_refunds_book_sale_id_idx" ON "book_sale_refunds" USING btree ("book_sale_id");--> statement-breakpoint
CREATE INDEX "book_sales_academy_id_idx" ON "book_sales" USING btree ("academy_id");--> statement-breakpoint
CREATE INDEX "book_sales_book_id_idx" ON "book_sales" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_sales_student_id_idx" ON "book_sales" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "books_academy_id_idx" ON "books" USING btree ("academy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_fee_schedules_enrollment_id_unique" ON "enrollment_fee_schedules" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "enrollment_fee_schedules_academy_id_idx" ON "enrollment_fee_schedules" USING btree ("academy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_periods_enrollment_id_period_start_period_end_unique" ON "fee_periods" USING btree ("enrollment_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "fee_periods_academy_id_idx" ON "fee_periods" USING btree ("academy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_id_fee_period_id_unique" ON "payment_allocations" USING btree ("student_payment_id","fee_period_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_fee_period_id_idx" ON "payment_allocations" USING btree ("fee_period_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_student_payment_id_idx" ON "payment_allocations" USING btree ("student_payment_id");