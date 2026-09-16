CREATE TYPE "public"."billing_period" AS ENUM('monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."reports_level" AS ENUM('none', 'basic', 'advanced');--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"billing_period" "billing_period" NOT NULL,
	"max_branches" integer NOT NULL,
	"max_students" integer NOT NULL,
	"max_staff" integer NOT NULL,
	"max_courses" integer NOT NULL,
	"max_storage_bytes" bigint NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"certificate_enabled" boolean DEFAULT false NOT NULL,
	"reports_level" "reports_level" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_price_amount_cents_nonnegative" CHECK ("subscription_plans"."price_amount_cents" >= 0),
	CONSTRAINT "subscription_plans_max_branches_nonnegative" CHECK ("subscription_plans"."max_branches" >= 0),
	CONSTRAINT "subscription_plans_max_students_nonnegative" CHECK ("subscription_plans"."max_students" >= 0),
	CONSTRAINT "subscription_plans_max_staff_nonnegative" CHECK ("subscription_plans"."max_staff" >= 0),
	CONSTRAINT "subscription_plans_max_courses_nonnegative" CHECK ("subscription_plans"."max_courses" >= 0),
	CONSTRAINT "subscription_plans_max_storage_bytes_nonnegative" CHECK ("subscription_plans"."max_storage_bytes" >= 0)
);
