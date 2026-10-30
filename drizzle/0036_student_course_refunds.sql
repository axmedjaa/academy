-- Course-withdrawal refunds (approved policy): a refund is recorded only
-- when a student withdraws from a course, for at most the net amount paid
-- for that enrollment minus refunds already recorded for it. The academy
-- returns the money manually; this only records that it was returned.
--
-- Two new tables; no existing table, column, constraint or row changes, and
-- no backfill (no refunds are invented for past withdrawals).
--
-- student_course_refunds: one row per refund, tied to the enrollment, its
-- branch (from the batch at refund time), the student and the operator.
-- idempotency_key is unique per academy so a retried submission inserts
-- once. student_course_refund_payments: which original payments the refund
-- came out of, and how much from each. No ON DELETE CASCADE anywhere:
-- financial history can't be removed through a parent row.

CREATE TABLE "student_course_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"method" "student_payment_method" NOT NULL,
	"refunded_at" timestamp with time zone NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_course_refunds_idempotency" UNIQUE("academy_id","idempotency_key"),
	CONSTRAINT "student_course_refunds_amount_cents_positive" CHECK ("student_course_refunds"."amount_cents" > 0),
	CONSTRAINT "student_course_refunds_reason_length" CHECK (length(btrim("student_course_refunds"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "student_course_refunds_reference_length" CHECK ("student_course_refunds"."reference" IS NULL OR length("student_course_refunds"."reference") <= 200)
);
--> statement-breakpoint
CREATE TABLE "student_course_refund_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"student_payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "student_course_refund_payments_once" UNIQUE("refund_id","student_payment_id"),
	CONSTRAINT "student_course_refund_payments_amount_cents_positive" CHECK ("student_course_refund_payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_enrollment_id_batch_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."batch_enrollments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refund_payments" ADD CONSTRAINT "student_course_refund_payments_refund_id_student_course_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."student_course_refunds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_course_refund_payments" ADD CONSTRAINT "student_course_refund_payments_student_payment_id_student_payments_id_fk" FOREIGN KEY ("student_payment_id") REFERENCES "public"."student_payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "student_course_refunds_enrollment_idx" ON "student_course_refunds" USING btree ("enrollment_id");
--> statement-breakpoint
CREATE INDEX "student_course_refunds_student_idx" ON "student_course_refunds" USING btree ("student_id");
--> statement-breakpoint
CREATE INDEX "student_course_refunds_academy_date_idx" ON "student_course_refunds" USING btree ("academy_id","refunded_at");
--> statement-breakpoint
CREATE INDEX "student_course_refund_payments_payment_idx" ON "student_course_refund_payments" USING btree ("student_payment_id");
