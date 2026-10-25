-- Student home address and district (both optional). Additive only.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "address" text;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "district" text;
