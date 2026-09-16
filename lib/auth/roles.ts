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
