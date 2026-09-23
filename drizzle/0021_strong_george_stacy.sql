ALTER TABLE "courses" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "image_ref" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "instructor_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_instructor_id_staff_profiles_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."staff_profiles"("id") ON DELETE no action ON UPDATE no action;