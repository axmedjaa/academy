-- Dynamic subscription plans (Platform -> Plans). Additive only: no column or
-- row is dropped, every existing plan keeps its values and subscriptions.
--
-- Rollback (manual, in this order): delete the three plans inserted below if
-- no academy_subscriptions row references them; drop constraint
-- subscription_plans_active_requires_price; drop columns sort_order,
-- exports_enabled, advanced_reports_enabled; set price/limits on any NULL rows
-- and restore NOT NULL. The email_enabled backfill only aligns stored values
-- with behaviour that already existed (email was never gated), so it needs no
-- reversal.

-- NULL price = not set yet (the plan cannot be active until priced).
ALTER TABLE "subscription_plans" ALTER COLUMN "price_amount_cents" DROP NOT NULL;
--> statement-breakpoint
-- NULL limit = unlimited.
ALTER TABLE "subscription_plans" ALTER COLUMN "max_branches" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ALTER COLUMN "max_students" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ALTER COLUMN "max_staff" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ALTER COLUMN "max_courses" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ALTER COLUMN "max_storage_bytes" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing plans keep exports and finance/academic reports (nothing was gated before).
ALTER TABLE "subscription_plans" ADD COLUMN "exports_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "advanced_reports_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Email notifications become a plan feature; every existing plan already sent
-- email, so they keep it.
ALTER TABLE "subscription_plans" ALTER COLUMN "email_enabled" SET DEFAULT true;
--> statement-breakpoint
UPDATE "subscription_plans" SET "email_enabled" = true WHERE "email_enabled" = false;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_active_requires_price" CHECK (NOT "subscription_plans"."is_active" OR "subscription_plans"."price_amount_cents" IS NOT NULL);
--> statement-breakpoint
-- Initial recommended plans: retired and unpriced until the platform owner
-- prices and activates them. Skipped if a plan with the same name exists.
INSERT INTO "subscription_plans" (
  "name", "description", "price_amount_cents", "currency", "billing_period",
  "max_branches", "max_students", "max_staff", "max_courses", "max_storage_bytes",
  "sms_enabled", "email_enabled", "exports_enabled", "advanced_reports_enabled",
  "reports_level", "is_active", "sort_order"
)
SELECT v.name, v.description, NULL, 'USD', 'monthly',
  v.branches, v.students, v.staff, v.courses, v.storage,
  v.sms, true, true, true, 'advanced', false, v.sort_order
FROM (VALUES
  ('Starter', 'For small academies.', 1, 100, 10, 15, 2147483648::bigint, false, 1),
  ('Professional', 'For growing academies.', 3, 500, 30, 30, 10737418240::bigint, true, 2),
  ('Enterprise', 'For large academies.', 10, 2000, 100, 200, 53687091200::bigint, true, 3)
) AS v(name, description, branches, students, staff, courses, storage, sms, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM "subscription_plans" p WHERE p."name" = v.name);
