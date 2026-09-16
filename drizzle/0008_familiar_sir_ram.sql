CREATE TABLE "academy_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"active_students_count" integer DEFAULT 0 NOT NULL,
	"active_staff_count" integer DEFAULT 0 NOT NULL,
	"branch_count" integer DEFAULT 0 NOT NULL,
	"course_count" integer DEFAULT 0 NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_usage_active_students_count_nonnegative" CHECK ("academy_usage"."active_students_count" >= 0),
	CONSTRAINT "academy_usage_active_staff_count_nonnegative" CHECK ("academy_usage"."active_staff_count" >= 0),
	CONSTRAINT "academy_usage_branch_count_nonnegative" CHECK ("academy_usage"."branch_count" >= 0),
	CONSTRAINT "academy_usage_course_count_nonnegative" CHECK ("academy_usage"."course_count" >= 0),
	CONSTRAINT "academy_usage_storage_used_bytes_nonnegative" CHECK ("academy_usage"."storage_used_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "academy_usage" ADD CONSTRAINT "academy_usage_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academy_usage_academy_id_calculated_at_idx" ON "academy_usage" USING btree ("academy_id","calculated_at");