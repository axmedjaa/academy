import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies, branches, staffProfiles, users } from "@/lib/db/schema";

/**
 * Turns internal ids into the names an export shows, with one grouped
 * query per kind (never one per row). Every lookup is scoped: staff and
 * branch names are read only from the given academy, so an id that
 * belongs to another academy resolves to the fallback label, never to
 * that academy's data. A missing relationship is never left blank: it
 * gets an explicit readable fallback ("Unknown staff member", "Unknown
 * branch") so a reader can see something was not found.
 */

export const UNKNOWN_STAFF = "Unknown staff member";
export const UNKNOWN_BRANCH = "Unknown branch";
export const UNKNOWN_ACADEMY = "Unknown academy";

const uniq = (ids: (string | null | undefined)[]) => Array.from(new Set(ids.filter((id): id is string => Boolean(id))));

/**
 * Staff names for user ids within one academy: the staff record's full
 * name, else the account's sign-in email (e.g. the registering owner, who
 * may have no staff record), else "Unknown staff member".
 */
export async function resolveStaffNames(academyId: string | null, userIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = uniq(userIds);
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  if (academyId) {
    const profiles = await db
      .select({ userId: staffProfiles.userId, fullName: staffProfiles.fullName })
      .from(staffProfiles)
      .where(and(eq(staffProfiles.academyId, academyId), inArray(staffProfiles.userId, ids)));
    for (const p of profiles) result.set(p.userId, p.fullName);
  }
  const missing = ids.filter((id) => !result.has(id));
  if (missing.length) {
    const accounts = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, missing));
    for (const a of accounts) result.set(a.id, a.email);
  }
  for (const id of ids) if (!result.has(id)) result.set(id, UNKNOWN_STAFF);
  return result;
}

/** Branch names for ids within one academy, else "Unknown branch". */
export async function resolveBranchNames(academyId: string | null, branchIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = uniq(branchIds);
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(academyId ? and(eq(branches.academyId, academyId), inArray(branches.id, ids)) : inArray(branches.id, ids));
  for (const r of rows) result.set(r.id, r.name);
  for (const id of ids) if (!result.has(id)) result.set(id, UNKNOWN_BRANCH);
  return result;
}

/** Academy names (platform-wide exports only). */
export async function resolveAcademyNames(academyIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = uniq(academyIds);
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await db.select({ id: academies.id, name: academies.name }).from(academies).where(inArray(academies.id, ids));
  for (const r of rows) result.set(r.id, r.name);
  for (const id of ids) if (!result.has(id)) result.set(id, UNKNOWN_ACADEMY);
  return result;
}
