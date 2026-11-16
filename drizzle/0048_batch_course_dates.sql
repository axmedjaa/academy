-- =========================================================================
-- 0048 — Individual start and end dates for each course in a batch
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0047. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- What it does
--   Adds `batch_courses.start_date` and `batch_courses.end_date`: the
--   schedule of one course inside one batch (e.g. Java 9 Oct–20 Nov, then
--   HTML 21 Nov–20 Jan). They are independent of the batch's own overall
--   `batches.start_date` / `batches.end_date`, which are unchanged.
--   A CHECK keeps a course's end date from being before its start date.
--
-- Existing data
--   Both columns are nullable with no default, so every existing
--   batch_courses row keeps working unchanged and simply has no course
--   dates yet (the batch page shows "Not set"; nothing is back-filled or
--   derived from the batch's dates). Adding nullable columns without a
--   default is a catalog-only change (no table rewrite). No relationship,
--   index or other table changes.
--
-- Rollback (manual)
--   ALTER TABLE "batch_courses" DROP CONSTRAINT "batch_courses_end_date_not_before_start_date";
--   ALTER TABLE "batch_courses" DROP COLUMN "end_date";
--   ALTER TABLE "batch_courses" DROP COLUMN "start_date";
--   Only after rolling the application back to a version that does not read
--   the columns. Any course dates entered since are lost.
-- =========================================================================

ALTER TABLE "batch_courses" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "batch_courses" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "batch_courses" ADD CONSTRAINT "batch_courses_end_date_not_before_start_date" CHECK ("batch_courses"."end_date" IS NULL OR "batch_courses"."start_date" IS NULL OR "batch_courses"."end_date" >= "batch_courses"."start_date");
