import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { academyMemberships, users } from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";

/** Same labels as app/academy/_shell/academy-shell.tsx's own ROLE_LABELS —
 * duplicated rather than imported since that file is a "use client"
 * component and this is a server-side data helper; keep the two in sync if
 * either changes. */
const ROLE_LABELS: Record<AcademyRole, string> = {
  academy_owner: "Academy Owner",
  academy_admin: "Academy Administrator",
  manager: "Manager",
  admissions_officer: "Admissions Officer",
  finance_officer: "Finance Officer",
  trainer: "Trainer",
};

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
