CREATE TYPE "public"."subscription_status" AS ENUM('draft', 'trial', 'active', 'past_due', 'suspended', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "academy_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"renewed_at" timestamp with time zone,
	"renewed_by" uuid,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"notes" text,
	CONSTRAINT "academy_subscriptions_ends_at_after_starts_at" CHECK ("academy_subscriptions"."ends_at" >= "academy_subscriptions"."starts_at"),
	CONSTRAINT "academy_subscriptions_trial_ends_at_after_starts_at" CHECK ("academy_subscriptions"."trial_ends_at" >= "academy_subscriptions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "academy_subscriptions" ADD CONSTRAINT "academy_subscriptions_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_subscriptions" ADD CONSTRAINT "academy_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_subscriptions" ADD CONSTRAINT "academy_subscriptions_renewed_by_users_id_fk" FOREIGN KEY ("renewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_subscriptions" ADD CONSTRAINT "academy_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_subscriptions" ADD CONSTRAINT "academy_subscriptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academy_subscriptions_academy_id_idx" ON "academy_subscriptions" USING btree ("academy_id");