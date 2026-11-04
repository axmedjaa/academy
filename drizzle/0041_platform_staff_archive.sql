-- Platform staff lifecycle (Platform -> Staff): display name, archive/restore.
-- Additive only: no column or row is dropped. Every existing membership stays
-- active (archived_at NULL) with no name (the UI falls back to the email).
--
-- Rollback (manual, in this order): restore any archived staff first (set
-- archived_at NULL and users.status 'active' for them) or they regain access
-- the moment the column is gone; then drop index
-- platform_memberships_archived_at_idx and drop columns updated_at,
-- archived_at and full_name from platform_memberships.

ALTER TABLE "platform_memberships" ADD COLUMN "full_name" text;
--> statement-breakpoint
-- NULL = active. Set = archived: no platform access, all sessions revoked.
ALTER TABLE "platform_memberships" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_memberships" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX "platform_memberships_archived_at_idx" ON "platform_memberships" USING btree ("archived_at");
