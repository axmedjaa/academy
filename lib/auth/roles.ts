// Matches the platform_role DB enum exactly (lib/db/schema.ts, Item 9).
export const PLATFORM_ROLES = ["platform_owner", "platform_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

// PLAN.md names these 6 academy roles throughout (Master Permission Matrix,
// DESIGN.md role tables) but only ever as display labels ("Academy Owner",
// "Academy Administrator", "Manager", "Admissions Officer", "Finance
// Officer", "Trainer") — no snake_case identifier is given anywhere. Item 19
// (Phase 1) built the `academy_memberships.role` DB enum
// (`academyRoleEnum` in lib/db/schema.ts) using exactly these slugs, so
// these values are now authoritative — keep the two in sync if either is
// ever touched again.
export const ACADEMY_ROLES = [
  "academy_owner",
  "academy_admin",
  "manager",
  "admissions_officer",
  "finance_officer",
  "trainer",
] as const;
export type AcademyRole = (typeof ACADEMY_ROLES)[number];

/**
 * Roles staff can be given today. Admissions Officer and Finance Officer
 * are retired: nobody can be created with, or changed to, either one.
 * They stay in `ACADEMY_ROLES` (and the `academy_role` DB enum) only so
 * memberships that still hold them keep working, with the same access as
 * before, until drizzle/0044_retire_admissions_finance_roles.sql moves
 * them to Manager. Nobody silently loses access in between.
 */
export const RETIRED_ACADEMY_ROLES = ["admissions_officer", "finance_officer"] as const satisfies readonly AcademyRole[];
export type RetiredAcademyRole = (typeof RETIRED_ACADEMY_ROLES)[number];

export const ASSIGNABLE_ACADEMY_ROLES = ACADEMY_ROLES.filter(
  (role): role is Exclude<AcademyRole, RetiredAcademyRole> => !(RETIRED_ACADEMY_ROLES as readonly string[]).includes(role),
);

/** True for a role that can no longer be given to anyone. */
export function isRetiredAcademyRole(role: string): role is RetiredAcademyRole {
  return (RETIRED_ACADEMY_ROLES as readonly string[]).includes(role);
}
