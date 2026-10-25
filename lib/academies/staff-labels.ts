import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { academyMemberships, staffProfiles, users } from "@/lib/db/schema";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";

/** Display labels for academy roles (re-exported from the pure
 * lib/auth/role-labels.ts so client components can share them). */
export const ROLE_LABELS = ACADEMY_ROLE_LABELS;

/**
 * Batched "who recorded this" display label — resolves to the user's
 * current role in this academy (e.g. "Manager") when a membership row still
 * exists, falling back to their email when it doesn't (e.g. removed staff).
 * Display-only: this never gates access — every id passed in already came
 * from an already-authorized read (a payment/receipt's recordedBy/issuedBy),
 * same "display enrichment on an already-authorized read" pattern as
 * lib/academies/batch-assignments.ts's getActiveCoursesForStudents.
 *
 * Batched (one query for memberships, one for emails) regardless of how
 * many user ids are passed — never N+1 on a payment-history list.
 */
export async function resolveStaffLabels(academyId: string, userIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const [membershipRows, userRows] = await Promise.all([
    db
      .select({ userId: academyMemberships.userId, role: academyMemberships.role })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.academyId, academyId), inArray(academyMemberships.userId, uniqueIds))),
    db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, uniqueIds)),
  ]);

  const roleByUser = new Map(membershipRows.map((row) => [row.userId, row.role]));
  const emailByUser = new Map(userRows.map((row) => [row.id, row.email]));

  for (const userId of uniqueIds) {
    const role = roleByUser.get(userId);
    result.set(userId, role ? ROLE_LABELS[role] : (emailByUser.get(userId) ?? userId));
  }
  return result;
}

/**
 * "Recorded by" names for list pages: the person's staff-profile name in
 * this academy, falling back to `resolveStaffLabels` (role, then email) for
 * anyone without a profile, such as the owner. Display-only, same contract
 * as above: every id comes from a record the caller already read, and the
 * lookup is pinned to `academyId`.
 */
export async function resolveStaffNames(academyId: string, userIds: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return {};
  const rows = await db
    .select({ userId: staffProfiles.userId, fullName: staffProfiles.fullName })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), inArray(staffProfiles.userId, uniqueIds)));
  const names: Record<string, string> = Object.fromEntries(rows.map((row) => [row.userId, row.fullName]));
  const missing = uniqueIds.filter((id) => !names[id]);
  if (missing.length > 0) {
    const labels = await resolveStaffLabels(academyId, missing);
    for (const id of missing) names[id] = labels.get(id) ?? "Staff member";
  }
  return names;
}
