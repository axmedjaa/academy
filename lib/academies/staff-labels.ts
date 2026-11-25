import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { staffProfiles, users } from "@/lib/db/schema";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";

/** Display labels for academy roles (re-exported from the pure
 * lib/auth/role-labels.ts so client components can share them). */
export const ROLE_LABELS = ACADEMY_ROLE_LABELS;

/** Shown when a user id resolves to no account at all. */
export const UNKNOWN_STAFF_LABEL = "Staff member";

/**
 * A readable name from a sign-in email ("amina.yusuf@x.so" -> "Amina
 * Yusuf"), for accounts with no staff profile (e.g. the academy owner).
 * The same name the console header shows for that person.
 */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
  return name || email;
}

/**
 * Batched "who recorded this" display label: the person's NAME, never their
 * role. Their staff-profile full name in this academy, else a name derived
 * from their sign-in email (e.g. the owner, who may have no staff profile),
 * the same name the console header shows them. Archived or removed staff
 * keep their profile, so their name still shows on old records.
 *
 * Display-only: this never gates access. Every id passed in already came
 * from an already-authorized read (a payment/receipt's recordedBy/issuedBy),
 * and the profile lookup is pinned to `academyId`, so a name from another
 * academy's staff records never leaks in.
 *
 * Batched (one query for profiles, one for emails) regardless of how many
 * user ids are passed — never N+1 on a payment-history list.
 */
export async function resolveStaffLabels(academyId: string, userIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const [profileRows, userRows] = await Promise.all([
    db
      .select({ userId: staffProfiles.userId, fullName: staffProfiles.fullName })
      .from(staffProfiles)
      .where(and(eq(staffProfiles.academyId, academyId), inArray(staffProfiles.userId, uniqueIds))),
    db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, uniqueIds)),
  ]);

  const nameByUser = new Map(profileRows.filter((row) => row.fullName.trim()).map((row) => [row.userId, row.fullName.trim()]));
  const emailByUser = new Map(userRows.map((row) => [row.id, row.email]));

  for (const userId of uniqueIds) {
    const email = emailByUser.get(userId);
    result.set(userId, nameByUser.get(userId) ?? (email ? nameFromEmail(email) : UNKNOWN_STAFF_LABEL));
  }
  return result;
}

/**
 * Same names as `resolveStaffLabels`, as a plain object for list pages
 * that pass the lookup to client components.
 */
export async function resolveStaffNames(academyId: string, userIds: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await resolveStaffLabels(academyId, userIds));
}
