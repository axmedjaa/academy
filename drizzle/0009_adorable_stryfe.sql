CREATE TABLE "subscription_payment_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_payment_id" uuid NOT NULL,
	"academy_subscription_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_payment_consumptions" ADD CONSTRAINT "subscription_payment_consumptions_subscription_payment_id_subscription_payments_id_fk" FOREIGN KEY ("subscription_payment_id") REFERENCES "public"."subscription_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment_consumptions" ADD CONSTRAINT "subscription_payment_consumptions_academy_subscription_id_academy_subscriptions_id_fk" FOREIGN KEY ("academy_subscription_id") REFERENCES "public"."academy_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment_consumptions" ADD CONSTRAINT "subscription_payment_consumptions_consumed_by_users_id_fk" FOREIGN KEY ("consumed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_consumptions_subscription_payment_id_unique" ON "subscription_payment_consumptions" USING btree ("subscription_payment_id");--> statement-breakpoint
CREATE INDEX "subscription_payment_consumptions_academy_subscription_id_idx" ON "subscription_payment_consumptions" USING btree ("academy_subscription_id");