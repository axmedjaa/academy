-- =========================================================================
-- 0049 — Program-based batches and complete program enrollment billing
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0048. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- What it does
--   1. `program_enrollments`: a student's enrollment in a COMPLETE PROGRAM
--      through one program-based batch. One active row per student/program.
--   2. `batches.program_id`: set for a program-based batch; null (every
--      existing batch) for a course-based batch.
--   3. `batch_enrollments.program_enrollment_id`: links the academic course
--      enrollments of a program student back to their program enrollment.
--      Those course rows never get a fee schedule or fee periods.
--   4. One billing engine, two owners: `enrollment_fee_schedules`,
--      `fee_periods` and `student_course_refunds` may now belong to a course
--      enrollment (`enrollment_id`, as before) OR a program enrollment
--      (`program_enrollment_id`) — exactly one, enforced by CHECK. The one
--      program fee is billed once, against the program enrollment.
--   5. `enrollment_fee_schedules.discount_cents`: the discount already taken
--      off `amount_cents` (the total actually billed). Default 0.
--
-- Existing data
--   Nothing existing is changed or reinterpreted. Every existing schedule,
--   fee period and refund already has `enrollment_id` set, so it satisfies
--   the new "exactly one owner" CHECKs as-is; dropping NOT NULL on
--   `enrollment_id` only allows NEW program-owned rows. New columns are
--   nullable (or default 0), so this is catalog-only (no table rewrite).
--   Existing batches stay course-based (`program_id` null). Payments,
--   allocations, receipts and reversals are untouched — program installments
--   are paid with the same `student_payments` / `payment_allocations` rows.
--
-- Note on fee_periods_no_overlap (0028)
--   That EXCLUDE constraint compares `enrollment_id WITH =`; program rows
--   have NULL there and are never compared by it. Program installments are
--   guarded by the new unique (program_enrollment_id, period_start,
--   period_end) index and by the bounded generator instead.
--
-- Rollback (manual, only after rolling the application back and only if no
-- program-owned rows exist yet)
--   DROP the new constraints/indexes/columns below, DROP TABLE
--   "program_enrollments", and restore NOT NULL on the three enrollment_id
--   columns.
-- =========================================================================

CREATE TABLE "program_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"status" "batch_enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "program_enrollments_student_program_active_unique" ON "program_enrollments" USING btree ("student_id","program_id") WHERE "program_enrollments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "program_enrollments_academy_id_student_id_idx" ON "program_enrollments" USING btree ("academy_id","student_id");--> statement-breakpoint
CREATE INDEX "program_enrollments_batch_id_idx" ON "program_enrollments" USING btree ("batch_id");--> statement-breakpoint

ALTER TABLE "batches" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "batch_enrollments" ADD COLUMN "program_enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_program_enrollment_id_program_enrollments_id_fk" FOREIGN KEY ("program_enrollment_id") REFERENCES "public"."program_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "enrollment_fee_schedules" ALTER COLUMN "enrollment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD COLUMN "program_enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_program_enrollment_id_program_enrollments_id_fk" FOREIGN KEY ("program_enrollment_id") REFERENCES "public"."program_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_discount_cents_nonnegative" CHECK ("enrollment_fee_schedules"."discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_one_owner" CHECK (("enrollment_fee_schedules"."enrollment_id" IS NULL) <> ("enrollment_fee_schedules"."program_enrollment_id" IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_fee_schedules_program_enrollment_id_unique" ON "enrollment_fee_schedules" USING btree ("program_enrollment_id");--> statement-breakpoint

ALTER TABLE "fee_periods" ALTER COLUMN "enrollment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_periods" ADD COLUMN "program_enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_program_enrollment_id_program_enrollments_id_fk" FOREIGN KEY ("program_enrollment_id") REFERENCES "public"."program_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_one_owner" CHECK (("fee_periods"."enrollment_id" IS NULL) <> ("fee_periods"."program_enrollment_id" IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "fee_periods_program_enrollment_period_unique" ON "fee_periods" USING btree ("program_enrollment_id","period_start","period_end");--> statement-breakpoint

ALTER TABLE "student_course_refunds" ALTER COLUMN "enrollment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD COLUMN "program_enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_program_enrollment_id_program_enrollments_id_fk" FOREIGN KEY ("program_enrollment_id") REFERENCES "public"."program_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_course_refunds" ADD CONSTRAINT "student_course_refunds_one_owner" CHECK (("student_course_refunds"."enrollment_id" IS NULL) <> ("student_course_refunds"."program_enrollment_id" IS NULL));--> statement-breakpoint
CREATE INDEX "student_course_refunds_program_enrollment_idx" ON "student_course_refunds" USING btree ("program_enrollment_id");
