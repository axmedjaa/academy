import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies, branches, staffBranchAssignments, staffProfiles } from "@/lib/db/schema";
import { listNotificationsForUser } from "@/lib/notifications/list-notifications";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Read-only, presentation-only data for the `/academy/*` shell (sidebar +
 * topbar) — academy display name, the DESIGN.md §2.2 "Academy/Branch
 * Context Chip" label, and the notification-bell unread count. Deliberately
 * NOT a permission gate of its own: every caller has already passed
 * `checkAcademyAccessForContext` (this file is only ever called from
 * app/academy/layout.tsx, after that check succeeds with "full"/"grace"),
 * so this only resolves display strings, never a new authorization
 * decision.
 *
 * Branch-limited roles (Admissions Officer, Trainer — same set
 * lib/academies/branches.ts and lib/academies/id-cards.ts each separately
 * define as BRANCH_LIMITED_ROLES, not exported from either) get their
 * assigned branch name(s) as a locked label; academy-wide roles get "All
 * branches". DESIGN.md §2.2 describes a *dropdown* for academy-wide roles
 * and a *locked, possibly multi-branch-switchable* control for
 * branch-limited roles with more than one assignment — this wave renders
 * both as a static label only (no functional branch-filter is wired to any
 * existing list page yet, and wiring one is a separate, larger change than
 * "build the navigation shell"). Documented scope decision, not a silent
 * simplification.
 */
const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set(["admissions_officer", "trainer"]);

export interface AcademyShellData {
  academyName: string;
  branchChipLabel: string;
  unreadNotificationsCount: number;
}

export async function getAcademyShellData(
  actorContext: AuthContext,
  academyId: string,
  membershipRole: AcademyRole,
): Promise<AcademyShellData> {
  const [academy, unread] = await Promise.all([
    db.select({ name: academies.name }).from(academies).where(eq(academies.id, academyId)).limit(1),
    listNotificationsForUser(actorContext, { unreadOnly: true }),
  ]);

  let branchChipLabel = "All branches";
  if (BRANCH_LIMITED_ROLES.has(membershipRole)) {
    const [profile] = await db
      .select({ id: staffProfiles.id })
      .from(staffProfiles)
      .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, actorContext.userId)))
      .limit(1);

    const assignedBranchNames = profile
      ? (
          await db
            .select({ name: branches.name })
            .from(staffBranchAssignments)
            .innerJoin(branches, eq(branches.id, staffBranchAssignments.branchId))
            .where(eq(staffBranchAssignments.staffProfileId, profile.id))
        ).map((row) => row.name)
      : [];

    branchChipLabel = assignedBranchNames.length > 0 ? assignedBranchNames.join(", ") : "No branch assigned";
  }

  return {
    academyName: academy[0]?.name ?? "Academy",
    branchChipLabel,
    unreadNotificationsCount: unread.length,
  };
}
