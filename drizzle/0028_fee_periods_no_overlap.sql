-- Custom SQL migration file, put your code below! --

-- Follow-up to the interval-change generation bug: enrollment_id X could
-- previously end up with two (or more) fee_periods rows whose date ranges
-- overlap (e.g. a 1-month period and a 6-month period both anchored on the
-- same start date) whenever a fee schedule's interval was changed without
-- moving its anchorDate — lib/academies/fee-periods.ts's
-- generateFeePeriodsForEnrollment now resumes generation strictly after the
-- latest already-existing period for the enrollment, which prevents any
-- NEW overlap going forward, but that is an application-level invariant
-- only. Nothing in the schema itself stopped some other/future code path
-- from inserting an overlapping row.
--
-- This adds the real, database-level guarantee, same technique already
-- used for grade_bands' "no two mark ranges may overlap for the same
-- grade_configuration_id" invariant (see drizzle/0013_quiet_amazoness.sql
-- and lib/db/schema.ts's own comment on `gradeBands` for the full
-- rationale) — drizzle-orm 0.45.2 / drizzle-kit 0.31.10 have no declarative
-- builder for a Postgres `EXCLUDE USING gist` constraint, so this is a
-- hand-written custom migration rather than something `db:generate` could
-- produce from lib/db/schema.ts. See that file's own comment on
-- `feePeriods` for the schema-side pointer to this migration.
--
-- daterange(period_start, period_end, '[]') uses INCLUSIVE bounds on both
-- ends (not Postgres's default '[)') because period_end is itself the last
-- calendar day covered by that period (see generateFeePeriodsForEnrollment:
-- `periodEnd = addDays(addMonths(cursor, months), -1)`) — an
-- "adjacent-but-touching" pair like 2026-09-28..2026-10-27 and
-- 2026-10-28..2026-11-27 must NOT be flagged as overlapping (they share no
-- day), while two periods that both claim 2026-10-27 itself must be.
--
-- Idempotent — btree_gist is already installed by 0013_quiet_amazoness.sql
-- for grade_bands, but this is repeated so this migration stands on its
-- own regardless of run order relative to that one.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- If this statement fails with something like "conflicting key value
-- violates exclusion constraint" / "could not create exclusion constraint",
-- it means fee_periods ALREADY contains overlapping rows for at least one
-- enrollment_id (pre-existing corrupted data from before the generation
-- fix above existed). Do NOT resolve that by deleting, merging, or
-- reassigning any fee_periods/student_payments/payment_allocations rows to
-- force this migration through — the conflicting rows and their payment
-- history must be audited and remediated deliberately first (see
-- scripts/audit-fee-periods.ts), never silently altered just to satisfy a
-- schema constraint.
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_no_overlap"
  EXCLUDE USING gist ("enrollment_id" WITH =, daterange("period_start", "period_end", '[]') WITH &&);
