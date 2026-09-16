CREATE TYPE "public"."subscription_payment_status" AS ENUM('pending', 'verified', 'rejected', 'reversed');--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_method" text NOT NULL,
	"payment_reference" text,
	"evidence_file_ref" text,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"verified_by" uuid,
	"status" "subscription_payment_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_amount_cents_nonnegative" CHECK ("subscription_payments"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_academy_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."academy_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_payments_subscription_id_idx" ON "subscription_payments" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_payments_academy_id_idx" ON "subscription_payments" USING btree ("academy_id");