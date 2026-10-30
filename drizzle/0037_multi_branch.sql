-- Multi-branch management. One academy stays one tenant; this adds:
--
-- 1. branches.is_main — the academy's Main Branch (Head Office). Exactly
--    one per academy, enforced by a partial unique index. Backfill: each
--    existing academy's oldest branch (created_at, then id) becomes its
--    Main Branch — registration has always created that branch first.
--
-- 2. academy_memberships.academy_wide — all-branch access for a member
--    other than the owner (the owner is always all-branch, regardless of
--    this column). Off means the member works only in the branches they are
--    assigned to. Backfill: every active academy admin, manager and finance
--    officer — the roles that could see every branch before branch scoping
--    applied to them — keeps that access. Admissions officers and trainers
--    were already branch-limited and stay that way.
--
-- No row is deleted and no other column changes.

ALTER TABLE "branches" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "branches" AS b
SET "is_main" = true
FROM (
	SELECT DISTINCT ON ("academy_id") "id"
	FROM "branches"
	ORDER BY "academy_id", "created_at", "id"
) AS oldest
WHERE b."id" = oldest."id";
--> statement-breakpoint
CREATE UNIQUE INDEX "branches_one_main_per_academy" ON "branches" USING btree ("academy_id") WHERE "branches"."is_main";
--> statement-breakpoint
ALTER TABLE "academy_memberships" ADD COLUMN "academy_wide" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "academy_memberships"
SET "academy_wide" = true
WHERE "role" IN ('academy_admin', 'manager', 'finance_officer');
