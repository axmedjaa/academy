CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"template_id" text NOT NULL,
	"payload" jsonb,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_key_channel_unique" ON "notifications" USING btree ("idempotency_key","channel");--> statement-breakpoint
CREATE INDEX "notifications_status_created_at_idx" ON "notifications" USING btree ("status","created_at");