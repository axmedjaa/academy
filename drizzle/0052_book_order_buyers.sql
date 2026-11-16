-- =========================================================================
-- 0052 — Book orders are placed for a buyer (a student or another person),
-- like a sale; payments come from the buyer; books can be issued to another
-- person too
-- =========================================================================
--
-- Registered in drizzle/meta/_journal.json after 0051. Apply through
-- `npm run migrate` (or `npm run migrate:prod`), one environment at a time.
--
-- book_orders
--   + buyer_type (book_buyer_type: student / other_person), student_id,
--     buyer_name, buyer_phone, branch_id, subtotal_cents, discount_cents
--   supplier_name becomes nullable (the 0051 supplier columns stay, for
--   history; new orders don't use them)
--   checks: 0 <= discount <= subtotal; buyer shape (student needs a student,
--   other person needs a name; null buyer = an order from before 0052)
-- book_order_payments
--   + income_record_id: each buyer payment posts one income_records row
--     (category "book_order"), the same convention as book-sale payments
-- book_issues
--   student_id becomes nullable; + recipient_name (another person) and
--   order_id (the order the books were given for); check: a student or a
--   recipient name, never neither
--
-- Safe for existing data: nothing is deleted or rewritten. Existing rows
-- keep their values; the new columns are nullable or default to 0, and every
-- new check holds for them (buyer_type is NULL; discount 0 <= subtotal 0;
-- every existing issue has a student).
--
-- Rollback (manual): drop the added columns/constraints; supplier_name and
-- book_issues.student_id can only get NOT NULL back while no row is null.
-- =========================================================================

ALTER TABLE "book_orders" ALTER COLUMN "supplier_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "buyer_type" "book_buyer_type";--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "buyer_phone" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "subtotal_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_discount_cents_valid" CHECK ("book_orders"."discount_cents" >= 0 AND "book_orders"."discount_cents" <= "book_orders"."subtotal_cents");--> statement-breakpoint
ALTER TABLE "book_orders" ADD CONSTRAINT "book_orders_buyer_shape" CHECK ("book_orders"."buyer_type" IS NULL OR ("book_orders"."buyer_type" = 'student' AND "book_orders"."student_id" IS NOT NULL) OR ("book_orders"."buyer_type" = 'other_person' AND "book_orders"."student_id" IS NULL AND "book_orders"."buyer_name" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "book_orders_student_id_idx" ON "book_orders" USING btree ("student_id");--> statement-breakpoint
ALTER TABLE "book_order_payments" ADD COLUMN "income_record_id" uuid;--> statement-breakpoint
ALTER TABLE "book_order_payments" ADD CONSTRAINT "book_order_payments_income_record_id_income_records_id_fk" FOREIGN KEY ("income_record_id") REFERENCES "public"."income_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_issues" ALTER COLUMN "student_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "book_issues" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "book_issues" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_order_id_book_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."book_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_recipient" CHECK ("book_issues"."student_id" IS NOT NULL OR "book_issues"."recipient_name" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "book_issues_order_id_idx" ON "book_issues" USING btree ("order_id");
