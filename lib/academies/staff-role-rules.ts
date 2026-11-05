import { ASSIGNABLE_ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";

/**
 * Who may grant which academy role, and who may act on whose staff record.
 * Pure and client-safe: lib/academies/staff.ts enforces these on the server
 * (the authority), and the staff page uses the same functions only to hide
 * controls a viewer can't use.
 *
 *   Role change        Owner: any role. Academy Admin: any role except
 *                      Owner. Everyone else (Manager included): none.
 *   Staff creation     Owner: any role. Academy Admin: any role except
 *                      Owner. Manager: only Trainer (the one role below Manager), so creating
 *                      an account is never a way around the role-change rule
 *                      (e.g. a Manager registering an Admin account they
 *                      control, then promoting themselves with it).
 *   Owner records      Only an Owner may edit, archive, re-place or remove
 *                      access for someone who holds the Owner role.
 *   Self               Nobody changes their own role, or archives their own
 *                      staff record.
 *   Retired roles      Admissions Officer and Finance Officer are never
 *                      offered or accepted, by anyone (see RETIRED_ACADEMY_ROLES).
 */

/** Roles below Manager: what a Manager may give a new staff member. */
const BELOW_MANAGER: readonly AcademyRole[] = ["trainer"];

/** Whether this role may change other staff members' roles at all. */
export function canChangeStaffRoles(actorRole: AcademyRole): boolean {
  return actorRole === "academy_owner" || actorRole === "academy_admin";
}

/** Roles this actor may give someone, by role change or by creating staff. */
export function rolesAssignableBy(actorRole: AcademyRole, purpose: "change" | "create"): readonly AcademyRole[] {
  if (actorRole === "academy_owner") return ASSIGNABLE_ACADEMY_ROLES;
  if (actorRole === "academy_admin") return ASSIGNABLE_ACADEMY_ROLES.filter((role) => role !== "academy_owner");
  if (purpose === "create" && actorRole === "manager") return BELOW_MANAGER;
  return [];
}

/** Whether the actor may modify the staff record of someone holding
 * `targetRole` (null = no active academy access). Only an Owner touches an
 * Owner's record. */
export function canModifyStaffWithRole(actorRole: AcademyRole, targetRole: AcademyRole | null): boolean {
  return targetRole !== "academy_owner" || actorRole === "academy_owner";
}
