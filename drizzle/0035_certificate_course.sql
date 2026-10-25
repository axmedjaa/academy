-- Certificates are issued per student per completed course, also when a
-- batch runs several courses. Adds certificates.course_id, backfills every
-- existing certificate, then moves the uniqueness rule from
-- (student_id, batch_id) to (student_id, batch_id, course_id).
--
-- Backfill, for each existing certificate:
--   1. the one course of the batch in which the student has a published,
--      passing result (the course the certificate was earned in);
--   2. otherwise the batch's primary course (batches.course_id), which is
--      the course the certificate's printout and public verification page
--      already showed before this change.
-- A certificate whose student passed in more than one course of the batch
-- also takes the primary course when that is one of them, else the first
-- passed course by name. Codes, statuses and cancellations are unchanged,
-- so every existing verification link keeps working.

ALTER TABLE "certificates" ADD COLUMN "course_id" uuid;
--> statement-breakpoint
UPDATE "certificates" ce
SET "course_id" = COALESCE(
  (
    SELECT e."course_id"
    FROM "exam_results" r
    JOIN "exams" e ON e."id" = r."exam_id"
    JOIN "courses" c ON c."id" = e."course_id"
    JOIN "batches" b ON b."id" = ce."batch_id"
    WHERE r."student_id" = ce."student_id"
      AND r."batch_id" = ce."batch_id"
      AND r."status" = 'published'
      AND r."pass_fail" = 'pass'
    GROUP BY e."course_id", c."name", b."course_id"
    ORDER BY (e."course_id" = b."course_id") DESC, c."name"
    LIMIT 1
  ),
  (SELECT b."course_id" FROM "batches" b WHERE b."id" = ce."batch_id")
)
WHERE ce."course_id" IS NULL;
--> statement-breakpoint
-- Safety net for the composite FK below: every (batch, course) pair a
-- certificate now names must exist in batch_courses. Migration 0033 already
-- added each batch's primary course, so on a database that ran it this
-- inserts nothing (verified with a read-only dry run before release).
INSERT INTO "batch_courses" ("academy_id", "batch_id", "course_id")
SELECT DISTINCT ce."academy_id", ce."batch_id", ce."course_id" FROM "certificates" ce
ON CONFLICT ("batch_id", "course_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "certificates" ALTER COLUMN "course_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_batch_course_fk" FOREIGN KEY ("batch_id","course_id") REFERENCES "public"."batch_courses"("batch_id","course_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "certificates_student_batch_course_unique" ON "certificates" USING btree ("student_id","batch_id","course_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "certificates_student_id_batch_id_unique";
