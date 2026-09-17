CREATE TYPE "public"."approval_request_entity_type" AS ENUM('result', 'grade_configuration', 'expense', 'student_payment');--> statement-breakpoint
CREATE TYPE "public"."approval_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('planned', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."grade_configuration_status" AS ENUM('draft', 'pending_approval', 'approved', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"entity_type" "approval_request_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" "approval_request_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" "batch_status" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"duration_weeks" integer,
	"status" "branch_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grade_configuration_id" uuid NOT NULL,
	"label" text NOT NULL,
	"min_mark" numeric NOT NULL,
	"max_mark" numeric NOT NULL,
	"is_pass" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_bands_max_mark_gte_min_mark" CHECK ("grade_bands"."max_mark" >= "grade_bands"."min_mark")
);
--> statement-breakpoint
CREATE TABLE "grade_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "grade_configuration_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "branch_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_grade_configuration_id_grade_configurations_id_fk" FOREIGN KEY ("grade_configuration_id") REFERENCES "public"."grade_configurations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_configurations" ADD CONSTRAINT "grade_configurations_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_configurations" ADD CONSTRAINT "grade_configurations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_configurations" ADD CONSTRAINT "grade_configurations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_entity_type_entity_id_idx" ON "approval_requests" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "approval_requests_academy_id_status_idx" ON "approval_requests" USING btree ("academy_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_academy_id_code_unique" ON "batches" USING btree ("academy_id","code");--> statement-breakpoint
CREATE INDEX "batches_course_id_idx" ON "batches" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "batches_branch_id_idx" ON "batches" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courses_academy_id_name_unique" ON "courses" USING btree ("academy_id","name");--> statement-breakpoint
CREATE INDEX "courses_program_id_idx" ON "courses" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "grade_configurations_academy_id_status_idx" ON "grade_configurations" USING btree ("academy_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_academy_id_name_unique" ON "programs" USING btree ("academy_id","name");--> statement-breakpoint
-- Item 46 — hand-appended (drizzle-orm 0.45.2 / drizzle-kit 0.31.10 have no
-- declarative builder for a Postgres EXCLUDE USING gist constraint; see
-- lib/db/schema.ts's comment on gradeBands for the full explanation).
-- Mandatory on every configuration regardless of status, not just `active`
-- ones (Planning Gaps Resolution §5): two grade bands for the same
-- grade_configuration_id may never have overlapping mark ranges, even
-- while the configuration is still Draft.
-- numrange's bounds are given explicitly as '[]' (inclusive on both ends,
-- not Postgres's default '[)'): min_mark/max_mark are both inclusive grade
-- boundaries (e.g. a band of 60-70 includes a mark of exactly 70), so a
-- mark of exactly 70 must never be able to fall inside two bands at once —
-- an "adjacent-but-touching" pair like [60,70] and [70,80] has to be
-- rejected as overlapping (they both claim the single point 70), which
-- only the '[]' bound spec (not the default '[)') makes true.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_no_overlap" EXCLUDE USING gist ("grade_configuration_id" WITH =, numrange("min_mark", "max_mark", '[]') WITH &&);