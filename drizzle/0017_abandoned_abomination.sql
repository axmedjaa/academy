CREATE TYPE "public"."expense_record_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."income_record_status" AS ENUM('posted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."student_charge_status" AS ENUM('open', 'partially_paid', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."student_payment_method" AS ENUM('cash', 'mobile_money', 'bank_transfer');--> statement-breakpoint
CREATE TYPE "public"."student_payment_status" AS ENUM('pending_approval', 'approved', 'rejected', 'reversed');--> statement-breakpoint
CREATE TABLE "expense_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid,
	"category" text NOT NULL,
	"description" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"status" "expense_record_status" DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"reversed_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_records_amount_cents_nonnegative" CHECK ("expense_records"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "income_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid,
	"category" text NOT NULL,
	"description" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"status" "income_record_status" DEFAULT 'posted' NOT NULL,
	"reversed_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_records_amount_cents_nonnegative" CHECK ("income_records"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_payment_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"due_date" date,
	"status" "student_charge_status" DEFAULT 'open' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_charges_amount_cents_nonnegative" CHECK ("student_charges"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "student_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"charge_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"method" "student_payment_method" NOT NULL,
	"reference" text,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"status" "student_payment_status" DEFAULT 'pending_approval' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reversed_payment_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_payments_amount_cents_nonnegative" CHECK ("student_payments"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "expense_records" ADD CONSTRAINT "expense_records_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_records" ADD CONSTRAINT "expense_records_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_records" ADD CONSTRAINT "expense_records_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_records" ADD CONSTRAINT "expense_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_records" ADD CONSTRAINT "expense_records_reversed_record_id_expense_records_id_fk" FOREIGN KEY ("reversed_record_id") REFERENCES "public"."expense_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_reversed_record_id_income_records_id_fk" FOREIGN KEY ("reversed_record_id") REFERENCES "public"."income_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_student_payment_id_student_payments_id_fk" FOREIGN KEY ("student_payment_id") REFERENCES "public"."student_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_charges" ADD CONSTRAINT "student_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_charge_id_student_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."student_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_reversed_payment_id_student_payments_id_fk" FOREIGN KEY ("reversed_payment_id") REFERENCES "public"."student_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_records_academy_id_idx" ON "expense_records" USING btree ("academy_id");--> statement-breakpoint
CREATE INDEX "income_records_academy_id_idx" ON "income_records" USING btree ("academy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_student_payment_id_unique" ON "receipts" USING btree ("student_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_academy_id_receipt_number_unique" ON "receipts" USING btree ("academy_id","receipt_number");--> statement-breakpoint
CREATE INDEX "student_charges_student_id_idx" ON "student_charges" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "student_charges_academy_id_idx" ON "student_charges" USING btree ("academy_id");--> statement-breakpoint
CREATE INDEX "student_payments_academy_id_created_at_idx" ON "student_payments" USING btree ("academy_id","created_at");--> statement-breakpoint
CREATE INDEX "student_payments_student_id_idx" ON "student_payments" USING btree ("student_id");