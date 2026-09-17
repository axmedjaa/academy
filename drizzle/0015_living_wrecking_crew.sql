CREATE TYPE "public"."exam_result_pass_fail" AS ENUM('pending', 'pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."exam_result_status" AS ENUM('draft', 'marks_entered', 'submitted', 'under_review', 'approved', 'rejected', 'published');--> statement-breakpoint
CREATE TYPE "public"."exam_status" AS ENUM('scheduled', 'marks_entry', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "exam_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"marks_obtained" numeric,
	"grade_configuration_id" uuid NOT NULL,
	"grade_band_label" text,
	"pass_fail" "exam_result_pass_fail" DEFAULT 'pending' NOT NULL,
	"status" "exam_result_status" DEFAULT 'draft' NOT NULL,
	"entered_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_results_marks_obtained_nonnegative" CHECK ("exam_results"."marks_obtained" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"max_marks" numeric NOT NULL,
	"exam_date" date,
	"status" "exam_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exams_max_marks_nonnegative" CHECK ("exams"."max_marks" >= 0)
);
--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_grade_configuration_id_grade_configurations_id_fk" FOREIGN KEY ("grade_configuration_id") REFERENCES "public"."grade_configurations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_results_exam_id_student_id_unique" ON "exam_results" USING btree ("exam_id","student_id");--> statement-breakpoint
CREATE INDEX "exam_results_academy_id_batch_id_idx" ON "exam_results" USING btree ("academy_id","batch_id");--> statement-breakpoint
CREATE INDEX "exam_results_student_id_idx" ON "exam_results" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "exams_batch_id_idx" ON "exams" USING btree ("batch_id");