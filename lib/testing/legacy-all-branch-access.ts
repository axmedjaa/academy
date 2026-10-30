import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Fixtures and seed data only. Migration 0037 gave every existing academy
 * admin, manager and finance officer all-branch access (they could see
 * every branch before branch scoping applied to them), while members added
 * afterwards start limited to their assigned branches. Fixtures written for
 * the earlier behaviour use this so they keep testing what they were
 * written for; multi-branch tests set `academyWide` explicitly instead.
 */
export function legacyAllBranchAccess(role: AcademyRole): boolean {
  return role === "academy_admin" || role === "manager" || role === "finance_officer";
}
