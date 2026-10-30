import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, staffBranchAssignments, staffProfiles, users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Read-only, presentation-only data for the `/academy/*` shell (sidebar +
 * topbar) — the caller's email and staff name, and the DESIGN.md §2.2
 * "Academy/Branch Context Chip" label. Deliberately
 * NOT a permission gate of its own: every caller has already passed
 * `checkAcademyAccessForContext` (this file is only ever called from
 * app/academy/layout.tsx, after that check succeeds with "full"/"grace"),
 * so this only resolves display strings, never a new authorization
 * decision.
 *
 * Members without all-branch access (lib/academies/branch-access.ts) get
 * their assigned branch name(s) as a locked label; all-branch members get
 * "All branches". DESIGN.md §2.2 describes a *dropdown* for academy-wide roles
 * and a *locked, possibly multi-branch-switchable* control for
 * branch-limited roles with more than one assignment — this wave renders
 * both as a static label only (no functional branch-filter is wired to any
 * existing list page yet, and wiring one is a separate, larger change than
 * "build the navigation shell"). Documented scope decision, not a silent
 * simplification.
 */

export interface AcademyShellIdentity {
  email: string;
  /** The caller's staff record name in this academy, or null if none. */
  staffFullName: string | null;
  branchChipLabel: string;
}

/**
 * Performance plan P3: the caller's email, staff name and branch chip label
 * in ONE query — previously a `users` read, a `staff_profiles` read (done
 * twice: once for the name, once for the branch lookup) and, for
 * branch-limited roles, a dependent `staff_branch_assignments` read. The
 * staff profile join is scoped to this academy and this user exactly as
 * before; assignments are only turned into a label for branch-limited roles.
 * Academy name/logo now come from the access gate's own academy row.
 */
export async function getAcademyShellIdentity(
  actorContext: AuthContext,
  academyId: string,
  academyWide: boolean,
): Promise<AcademyShellIdentity> {
  const rows = await db
    .select({
      email: users.email,
      staffProfileId: staffProfiles.id,
      staffFullName: staffProfiles.fullName,
      branchName: branches.name,
    })
    .from(users)
    .leftJoin(staffProfiles, and(eq(staffProfiles.userId, users.id), eq(staffProfiles.academyId, academyId)))
    .leftJoin(staffBranchAssignments, eq(staffBranchAssignments.staffProfileId, staffProfiles.id))
    .leftJoin(branches, eq(branches.id, staffBranchAssignments.branchId))
    .where(eq(users.id, actorContext.userId));

  let branchChipLabel = "All branches";
  if (!academyWide) {
    const assignedBranchNames = rows.map((row) => row.branchName).filter((name): name is string => name !== null);
    branchChipLabel = assignedBranchNames.length > 0 ? assignedBranchNames.join(", ") : "No branch assigned";
  }

  return {
    email: rows[0]?.email ?? "",
    staffFullName: rows[0]?.staffFullName ?? null,
    branchChipLabel,
  };
}
