CREATE TABLE "platform_website_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"support_email" text,
	"phone" text,
	"whatsapp_number" text,
	"office_address" text,
	"business_hours" text,
	"facebook_url" text,
	"linkedin_url" text,
	"instagram_url" text,
	"x_url" text,
	"youtube_url" text,
	"tiktok_url" text,
	"contact_form_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_website_settings_singleton" CHECK ("platform_website_settings"."id")
);
--> statement-breakpoint
ALTER TABLE "platform_website_settings" ADD CONSTRAINT "platform_website_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TYPE "public"."contact_submission_status" AS ENUM('new', 'read', 'archived');
--> statement-breakpoint
CREATE TABLE "contact_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" "contact_submission_status" DEFAULT 'new' NOT NULL,
	"dedupe_key" text NOT NULL,
	"notified_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "contact_submissions_dedupe_key_unique" ON "contact_submissions" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "contact_submissions_status_created_idx" ON "contact_submissions" USING btree ("status","created_at");
