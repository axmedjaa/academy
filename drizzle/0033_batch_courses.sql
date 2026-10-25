-- Batches hold one or more courses; enrollments, timetable entries and
-- exams name the course they belong to. Additive only: nothing is dropped,
-- and `batches.course_id` stays as each batch's primary course. Every new
-- course_id is backfilled from the batch's existing course, so existing
-- rows keep exactly the meaning they had (one course per batch).

CREATE TABLE IF NOT EXISTS "batch_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_courses" ADD CONSTRAINT "batch_courses_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "batch_courses" ADD CONSTRAINT "batch_courses_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "batch_courses" ADD CONSTRAINT "batch_courses_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "batch_courses_batch_id_course_id_unique" ON "batch_courses" USING btree ("batch_id","course_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_courses_academy_id_idx" ON "batch_courses" USING btree ("academy_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_courses_course_id_idx" ON "batch_courses" USING btree ("course_id");
--> statement-breakpoint
INSERT INTO "batch_courses" ("academy_id", "batch_id", "course_id")
SELECT "academy_id", "id", "course_id" FROM "batches"
ON CONFLICT ("batch_id", "course_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "batch_enrollments" ADD COLUMN "course_id" uuid;
--> statement-breakpoint
UPDATE "batch_enrollments" e SET "course_id" = b."course_id" FROM "batches" b WHERE b."id" = e."batch_id" AND e."course_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "batch_enrollments" ALTER COLUMN "course_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "batch_enrollments" ADD CONSTRAINT "batch_enrollments_batch_course_fk" FOREIGN KEY ("batch_id","course_id") REFERENCES "public"."batch_courses"("batch_id","course_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "batch_enrollments_student_batch_course_active_unique" ON "batch_enrollments" USING btree ("student_id","batch_id","course_id") WHERE "batch_enrollments"."status" = 'active';
--> statement-breakpoint
DROP INDEX IF EXISTS "batch_enrollments_student_id_batch_id_active_unique";
--> statement-breakpoint

ALTER TABLE "timetables" ADD COLUMN "course_id" uuid;
--> statement-breakpoint
UPDATE "timetables" t SET "course_id" = b."course_id" FROM "batches" b WHERE b."id" = t."batch_id" AND t."course_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "timetables" ALTER COLUMN "course_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_batch_course_fk" FOREIGN KEY ("batch_id","course_id") REFERENCES "public"."batch_courses"("batch_id","course_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "exams" ADD COLUMN "course_id" uuid;
--> statement-breakpoint
UPDATE "exams" x SET "course_id" = b."course_id" FROM "batches" b WHERE b."id" = x."batch_id" AND x."course_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "exams" ALTER COLUMN "course_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_batch_course_fk" FOREIGN KEY ("batch_id","course_id") REFERENCES "public"."batch_courses"("batch_id","course_id") ON DELETE no action ON UPDATE no action;
