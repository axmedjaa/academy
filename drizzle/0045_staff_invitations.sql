-- =========================================================================
-- 0045 — Staff invitations (security fix SEC-H-01)
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0044 (which DEV had applied
-- by hand and was reconciled into DEV's migration history without being
-- re-run). Apply through `npm run migrate`, one environment at a time.
--
-- What it does
--   Creates `staff_invitations`: one row per "Add staff" request, bound to a
--   lower-cased email, the academy, the role and the branch scope the
--   inviter was allowed to grant. Only the SHA-256 hash of the invitation
--   token is stored. Acceptance (lib/academies/staff-invitations.ts) is the
--   only path that creates the membership and staff profile.
--
-- Indexes and constraints
--   - token_hash unique: one row per token; lookups by hash.
--   - (academy_id, email) unique WHERE status = 'pending': no duplicate open
--     invitations for the same person in the same academy.
--   - (academy_id, status): the staff page's pending list.
--   - email = lower(email); role is never a retired role; status 'accepted'
--     iff accepted_at and accepted_user_id are set.
--
-- Transaction requirements (enforced in application code)
--   Acceptance locks the invitation row (SELECT ... FOR UPDATE) and writes
--   the membership, profile, branch assignments, invitation status and audit
--   row in one transaction. The existing unique indexes
--   academy_memberships(user_id, academy_id) and
--   staff_profiles(academy_id, user_id) are the second guard against
--   duplicate memberships under concurrent acceptance.
--
-- It changes no existing table and touches no existing rows.
-- =========================================================================

CREATE TYPE "public"."staff_invitation_status" AS ENUM('pending', 'accepted', 'revoked');--> statement-breakpoint
CREATE TABLE "staff_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" "academy_role" NOT NULL,
	"academy_wide" boolean DEFAULT false NOT NULL,
	"branch_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"employee_number" text,
	"hire_date" date,
	"status" "staff_invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invitations_email_lowercase" CHECK ("staff_invitations"."email" = lower("staff_invitations"."email")),
	CONSTRAINT "staff_invitations_role_not_retired" CHECK ("staff_invitations"."role" not in ('admissions_officer', 'finance_officer')),
	CONSTRAINT "staff_invitations_accepted_consistent" CHECK (("staff_invitations"."status" = 'accepted') = ("staff_invitations"."accepted_at" is not null and "staff_invitations"."accepted_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_academy_id_academies_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invitations_token_hash_unique" ON "staff_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invitations_academy_email_pending_unique" ON "staff_invitations" USING btree ("academy_id","email") WHERE "staff_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "staff_invitations_academy_status_idx" ON "staff_invitations" USING btree ("academy_id","status");
