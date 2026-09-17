CREATE TYPE "public"."result_correction_status" AS ENUM('requested', 'approved', 'rejected', 'applied');--> statement-breakpoint
CREATE TABLE "result_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"original_result_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"proposed_marks_obtained" numeric,
	"status" "result_correction_status" DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_corrections_proposed_marks_obtained_nonnegative" CHECK ("result_corrections"."proposed_marks_obtained" >= 0)
);
--> statement-breakpoint
ALTER TABLE "result_corrections" ADD CONSTRAINT "result_corrections_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_corrections" ADD CONSTRAINT "result_corrections_original_result_id_exam_results_id_fk" FOREIGN KEY ("original_result_id") REFERENCES "public"."exam_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_corrections" ADD CONSTRAINT "result_corrections_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_corrections" ADD CONSTRAINT "result_corrections_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "result_corrections_original_result_id_idx" ON "result_corrections" USING btree ("original_result_id");