-- Book pre-orders for other people (Book Management update): an order is
-- for an existing student, or for another person recorded by name with an
-- optional phone and a chosen branch. Existing rows are all student orders
-- and stay valid unchanged (buyer_type defaults to 'student').
--
-- Rollback (manual): only possible while no other-person order exists —
-- delete or convert those first; then drop constraint
-- book_preorders_buyer_shape, set student_id NOT NULL, drop columns
-- buyer_phone, buyer_name and buyer_type, and drop type
-- book_preorder_buyer_type.

CREATE TYPE "public"."book_preorder_buyer_type" AS ENUM('student', 'other_person');
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD COLUMN "buyer_type" "book_preorder_buyer_type" DEFAULT 'student' NOT NULL;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD COLUMN "buyer_name" text;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD COLUMN "buyer_phone" text;
--> statement-breakpoint
ALTER TABLE "book_preorders" ALTER COLUMN "student_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "book_preorders" ADD CONSTRAINT "book_preorders_buyer_shape" CHECK (("book_preorders"."buyer_type" = 'student' AND "book_preorders"."student_id" IS NOT NULL AND "book_preorders"."buyer_name" IS NULL AND "book_preorders"."buyer_phone" IS NULL) OR ("book_preorders"."buyer_type" = 'other_person' AND "book_preorders"."student_id" IS NULL AND "book_preorders"."buyer_name" IS NOT NULL));
