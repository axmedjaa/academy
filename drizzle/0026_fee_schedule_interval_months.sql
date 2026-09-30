-- Replaces enrollment_fee_schedules.frequency / fee_periods.frequency
-- (a 3-value enum: monthly/quarterly/yearly) with a plain checked integer
-- interval_months (1/2/3/4/6/12), so new payment-plan intervals (every 2,
-- 4, or 6 months) don't require a new enum value + migration each time.
-- Existing rows (if any) are backfilled from their old enum value before
-- the old column is dropped, so no data is lost.

ALTER TABLE "enrollment_fee_schedules" ADD COLUMN "interval_months" integer;
--> statement-breakpoint
UPDATE "enrollment_fee_schedules" SET "interval_months" = CASE "frequency"
  WHEN 'monthly' THEN 1
  WHEN 'quarterly' THEN 3
  WHEN 'yearly' THEN 12
END;
--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ALTER COLUMN "interval_months" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" ADD CONSTRAINT "enrollment_fee_schedules_interval_months_valid" CHECK ("interval_months" IN (1, 2, 3, 4, 6, 12));
--> statement-breakpoint
ALTER TABLE "enrollment_fee_schedules" DROP COLUMN "frequency";
--> statement-breakpoint

ALTER TABLE "fee_periods" ADD COLUMN "interval_months" integer;
--> statement-breakpoint
UPDATE "fee_periods" SET "interval_months" = CASE "frequency"
  WHEN 'monthly' THEN 1
  WHEN 'quarterly' THEN 3
  WHEN 'yearly' THEN 12
END;
--> statement-breakpoint
ALTER TABLE "fee_periods" ALTER COLUMN "interval_months" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fee_periods" ADD CONSTRAINT "fee_periods_interval_months_valid" CHECK ("interval_months" IN (1, 2, 3, 4, 6, 12));
--> statement-breakpoint
ALTER TABLE "fee_periods" DROP COLUMN "frequency";
--> statement-breakpoint

DROP TYPE "public"."fee_frequency";
