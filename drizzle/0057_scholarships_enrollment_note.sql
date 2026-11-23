-- =========================================================================
-- 0057 — Scholarships on enrollments, and a note when a student is
-- registered without an enrollment
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0056. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time,
-- BEFORE deploying the code that reads these columns.
--
-- students
--   + enrollment_note: why a student was registered with "Don't enroll yet".
--   ~ date_of_birth renamed to registration_date. Staff always used this
--     field for the registration date, so every value is kept as it is.
-- batch_enrollments, program_enrollments
--   + scholarship: NULL (none), 'full' (free: no fee schedule, nothing due)
--     or 'partial' (the schedule's discount is a scholarship).
--
-- No row is changed: new nullable columns and one column rename.
--
-- Rollback (manual):
--   ALTER TABLE students DROP COLUMN enrollment_note;
--   ALTER TABLE students RENAME COLUMN registration_date TO date_of_birth;
--   ALTER TABLE batch_enrollments DROP CONSTRAINT batch_enrollments_scholarship_valid, DROP COLUMN scholarship;
--   ALTER TABLE program_enrollments DROP CONSTRAINT program_enrollments_scholarship_valid, DROP COLUMN scholarship;
-- =========================================================================

ALTER TABLE "students" ADD COLUMN "enrollment_note" text;--> statement-breakpoint
ALTER TABLE "students" RENAME COLUMN "date_of_birth" TO "registration_date";--> statement-breakpoint
ALTER TABLE "batch_enrollments" ADD COLUMN "scholarship" text;--> statement-breakpoint
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_scholarship_valid" CHECK ("batch_enrollments"."scholarship" IS NULL OR "batch_enrollments"."scholarship" IN ('full', 'partial'));--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD COLUMN "scholarship" text;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_scholarship_valid" CHECK ("program_enrollments"."scholarship" IS NULL OR "program_enrollments"."scholarship" IN ('full', 'partial'));
