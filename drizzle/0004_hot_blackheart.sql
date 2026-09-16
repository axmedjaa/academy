CREATE TYPE "public"."academy_role" AS ENUM('academy_owner', 'academy_admin', 'manager', 'admissions_officer', 'finance_officer', 'trainer');--> statement-breakpoint
CREATE TYPE "public"."branch_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "academies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_currency" text NOT NULL,
	"settings" jsonb,
	"type" text,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"logo_ref" text,
	"registration_number" text,
	"primary_contact_name" text,
	"primary_contact_phone" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "academy_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"academy_id" uuid NOT NULL,
	"role" "academy_role" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" "branch_status" DEFAULT 'active' NOT NULL,
	"address" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academies" ADD CONSTRAINT "academies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academies" ADD CONSTRAINT "academies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_memberships" ADD CONSTRAINT "academy_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_memberships" ADD CONSTRAINT "academy_memberships_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academies_slug_unique" ON "academies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "academy_memberships_user_id_academy_id_unique" ON "academy_memberships" USING btree ("user_id","academy_id");--> statement-breakpoint
CREATE INDEX "academy_memberships_academy_id_user_id_idx" ON "academy_memberships" USING btree ("academy_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_academy_id_code_unique" ON "branches" USING btree ("academy_id","code");--> statement-breakpoint
CREATE INDEX "branches_academy_id_idx" ON "branches" USING btree ("academy_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;