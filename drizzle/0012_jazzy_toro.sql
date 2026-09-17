CREATE TABLE "student_id_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"card_number" text NOT NULL,
	"photo_file_ref" text,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" uuid NOT NULL,
	"reprint_count" integer DEFAULT 0 NOT NULL,
	"status" "branch_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_id_cards_reprint_count_nonnegative" CHECK ("student_id_cards"."reprint_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "student_id_cards" ADD CONSTRAINT "student_id_cards_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_id_cards" ADD CONSTRAINT "student_id_cards_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_id_cards" ADD CONSTRAINT "student_id_cards_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_id_cards_card_number_unique" ON "student_id_cards" USING btree ("card_number");--> statement-breakpoint
CREATE INDEX "student_id_cards_student_id_idx" ON "student_id_cards" USING btree ("student_id");