import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { db } from "@/lib/db";
import { platformMemberships, users } from "@/lib/db/schema";

export type StaffTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serializes every staff mutation that can change who the active platform
 * owners are. Without it, two owners demoting/archiving each other at the
 * same moment would each see "one other active owner" and both succeed,
 * leaving none. Transaction-scoped: released on commit/rollback.
 */
export async function lockStaffMutations(tx: StaffTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('platform_staff_mutation'))`);
}

/**
 * Active platform owners other than `excludeUserId`. Active = membership
 * not archived AND the user account itself active.
 */
export async function countActiveOwnersExcluding(tx: StaffTx, excludeUserId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(platformMemberships)
    .innerJoin(users, eq(users.id, platformMemberships.userId))
    .where(
      and(
        eq(platformMemberships.role, "platform_owner"),
        isNull(platformMemberships.archivedAt),
        eq(users.status, "active"),
        ne(platformMemberships.userId, excludeUserId),
      ),
    );
  return Number(row?.n ?? 0);
}
