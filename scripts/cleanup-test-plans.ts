/**
 * One-time dev-database maintenance script — NOT an app feature, NOT wired
 * into any Server Action or UI. PLAN.md's own schema comment on
 * subscription_plans is explicit that there is no `deletePlan` action in
 * this product's design (`setPlanActive(false)` / "Retire" is the only
 * intended removal); this script exists purely to clear leaked test rows
 * out of the local Postgres instance, the same way a developer would run a
 * one-off cleanup query by hand — except transaction-wrapped, reference-
 * checked, and auditable, per this task's explicit "never delete based on
 * a name pattern alone" instruction.
 *
 * Deletes ONLY rows matching one of the 5 confirmed test-leftover name
 * patterns AND having zero referencing academy_subscriptions rows (the
 * only FK anywhere in the schema that points at subscription_plans.id —
 * confirmed by grepping lib/db/schema.ts before writing this). Every
 * reference check re-runs inside the same transaction as the delete, so
 * nothing can slip in between the check and the write. Uses Drizzle's
 * query builder throughout (not raw SQL) — same convention as every other
 * mutation in this codebase.
 */
import { and, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { academySubscriptions, subscriptionPlans } from "@/lib/db/schema";

const TEST_PATTERNS = [
  "Grade Config Test Plan%",
  "Result Corrections Test Plan%",
  "Expense Records Test Plan%",
  "Finance Reversals Test Plan%",
  "Student Courses Plan%",
];

async function main() {
  const [{ count: beforeCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(subscriptionPlans);
  console.log(`Before: ${beforeCount} total subscription_plans rows`);

  const totalDeleted = await db.transaction(async (tx) => {
    // Every plan_id currently referenced by any academy_subscriptions row —
    // re-read inside this transaction, not reused from the earlier report.
    const referencedRows = await tx
      .select({ planId: academySubscriptions.planId })
      .from(academySubscriptions);
    const referencedIds = referencedRows.map((r) => r.planId);

    let deletedThisRun = 0;
    for (const pattern of TEST_PATTERNS) {
      const matchingCondition =
        referencedIds.length > 0
          ? and(like(subscriptionPlans.name, pattern), notInArray(subscriptionPlans.id, referencedIds))
          : like(subscriptionPlans.name, pattern);

      const toDelete = await tx
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(matchingCondition);

      if (toDelete.length === 0) {
        console.log(`${pattern.padEnd(32)} 0 unreferenced rows — nothing to delete`);
        continue;
      }

      const ids = toDelete.map((r) => r.id);
      const deleted = await tx
        .delete(subscriptionPlans)
        .where(inArray(subscriptionPlans.id, ids))
        .returning({ id: subscriptionPlans.id });

      console.log(`${pattern.padEnd(32)} deleted ${deleted.length} unreferenced rows`);
      deletedThisRun += deleted.length;
    }
    return deletedThisRun;
  });

  console.log(`\nTotal deleted: ${totalDeleted}`);

  const [{ count: afterCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(subscriptionPlans);
  console.log(`After: ${afterCount} total subscription_plans rows`);

  const [demo] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, "Demo Academy Plan"));
  console.log(`Demo Academy Plan still present: ${demo ? "yes" : "NO — PROBLEM"}`);

  const [{ count: subCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(academySubscriptions);
  console.log(`academy_subscriptions row count (should be unchanged by this script): ${subCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup failed, transaction rolled back:", err);
    process.exit(1);
  });
