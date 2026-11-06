-- =========================================================================
-- 0044 — Retire the Admissions Officer and Finance Officer academy roles
-- =========================================================================
--
-- STATUS: REGISTERED (drizzle/meta/_journal.json idx 44, when
-- 1793700000000). Already applied on DEV: it was run there by hand,
-- then recorded in DEV's drizzle.__drizzle_migrations without re-running
-- (together with 0042 and 0043, which DEV had also applied by hand). Other
-- environments apply it through the normal `npm run migrate`, in journal
-- order, after a backup. On a database with no retired-role memberships the
-- INSERT and UPDATE are no-ops and only the CHECK constraint is added.
--
-- This header was edited after DEV recorded the file's hash. Drizzle never
-- re-reads the hash of an applied migration (it compares created_at only),
-- so the differing hash has no effect.
--
-- What it does
--   1. Writes one audit_logs row per affected membership (old role -> new
--      role), so the history of who held which role is kept.
--   2. Moves every membership holding `admissions_officer` or
--      `finance_officer` (any status: active, removed, ...) to `manager`.
--      Manager is the only remaining role whose permissions include
--      everything both retired roles could do, so nobody loses access.
--      Nothing else on the membership changes: `status`, `academy_wide`
--      and the person's staff_branch_assignments stay exactly as they are,
--      so each person keeps the same branch reach.
--   3. Adds a CHECK constraint so no row can hold a retired role again.
--
-- What it does NOT do
--   - It does not drop the two values from the `academy_role` enum.
--     Postgres cannot remove an enum value in place; rebuilding the type
--     would rewrite academy_memberships and is not needed. The values stay,
--     unused, and the CHECK constraint keeps them unused.
--   - It deletes nothing and touches no business records, audit history or
--     approval history.
--
-- Access impact (owner decision): moving to Manager also grants Manager's
-- other permissions (manage staff below Manager, edit settings, manage
-- exams, approve/publish results, grade bands, full student payments and
-- fee periods). Review the pre-flight list before applying.
--
-- Pre-flight (read-only) — run first and review the people listed:
--   SELECT m.academy_id, m.user_id, m.role, m.status, m.academy_wide
--   FROM academy_memberships m
--   WHERE m.role IN ('admissions_officer', 'finance_officer')
--   ORDER BY m.academy_id, m.role;
--
-- Rollback: the audit rows written in step 1 record each membership's
-- previous role (`before`). To undo: drop the constraint, then set each
-- listed membership's role back from those rows.
-- =========================================================================

INSERT INTO "audit_logs" ("actor_user_id", "actor_role", "academy_id", "action", "entity_type", "entity_id", "before", "after", "reason", "result")
SELECT
	NULL,
	'system',
	m."academy_id",
	'retireStaffRole',
	'academy_membership',
	m."id",
	jsonb_build_object('role', m."role"::text, 'status', m."status"::text, 'academyWide', m."academy_wide"),
	jsonb_build_object('role', 'manager', 'status', m."status"::text, 'academyWide', m."academy_wide"),
	'Admissions Officer and Finance Officer roles retired; responsibilities moved to Manager (migration 0044).',
	'success'
FROM "academy_memberships" m
WHERE m."role" IN ('admissions_officer', 'finance_officer');
--> statement-breakpoint
UPDATE "academy_memberships"
SET "role" = 'manager'
WHERE "role" IN ('admissions_officer', 'finance_officer');
--> statement-breakpoint
ALTER TABLE "academy_memberships"
	ADD CONSTRAINT "academy_memberships_role_not_retired"
	CHECK ("role" NOT IN ('admissions_officer', 'finance_officer'));
