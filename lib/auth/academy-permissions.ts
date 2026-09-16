import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Item 41's real prerequisite: an academy-level role -> capability
 * map. `lib/auth/permissions.ts`'s `hasPermission()` says it plainly:
 * "Academy-level role -> capability map doesn't exist yet ... added when
 * that phase's roles and actions are built." Item 41 (`updateAcademySettings`
 * + `getOwnAcademyUsage`) is the first action in the flat PLAN.md item list
 * that actually needs one — the Master Permission Matrix's "Academy-level
 * actions" table (§118-137) requires Owner/Admin `Full`, Manager
 * `View/Edit`, and every other role `—` (never visible/callable) on the
 * "Academy settings (direct edit)" row, and `hasPermission()` has no way to
 * express that today (it only ever returns `false` once it falls through
 * the platform-role branches).
 *
 * ---------------------------------------------------------------------
 * Why a new sibling file instead of extending lib/auth/permissions.ts
 * ---------------------------------------------------------------------
 * `hasPermission(context, capability, resource?)` is explicitly documented
 * as "the single path to authorization" for the platform-role side of this
 * codebase (platform_owner / platform_admin, gated against
 * `UNGRANTABLE_CAPABILITIES` and `platform_admin_permissions`). Academy-role
 * authorization is a genuinely different shape:
 *   - It's a static role -> action -> level table, not a per-user grant
 *     table lookup — no DB read is needed at all (unlike
 *     `hasGrantedPlatformPermission`).
 *   - It needs a *role* (`AcademyRole`, resolved by
 *     `checkAcademyAccessForContext` from `academy_memberships`), which
 *     `AuthContext` does not carry (`academyRole` on `AuthContext` is a
 *     vestigial, always-undefined field per its own doc comment — Phase 0
 *     predates `academy_memberships`). Every call site already has an
 *     `AcademyRole` in hand from the access-gate result, not an
 *     `AuthContext`, so this takes that directly rather than awkwardly
 *     reusing `hasPermission`'s `(context, capability, resource?)` shape.
 *   - PLAN.md's academy matrix has levels beyond plain boolean allow/deny
 *     (`Full`, `Manage`, `View`, `Approve`, branch-scoped variants) that
 *     later items will need to distinguish; folding that into
 *     `hasPermission()` would mean overloading its return type or bolting
 *     a second signature onto "the only path to authorization" for
 *     platform capabilities, which the task brief explicitly says not to
 *     touch. A sibling file keeps the two concerns (and their very
 *     different lookup mechanisms) separate, matching how `lib/auth/roles.ts`
 *     already keeps `PLATFORM_ROLES`/`ACADEMY_ROLES` as two separate lists
 *     rather than one merged one.
 *
 * ---------------------------------------------------------------------
 * What's built now vs. what's deliberately left as an extension point
 * ---------------------------------------------------------------------
 * Only the "Academy settings (direct edit)" row is populated below — this
 * item's actual need. The table shape (`Record<AcademyRole,
 * Partial<Record<string, AcademyPermissionLevel>>>`) mirrors the Master
 * Permission Matrix exactly (one row per PLAN.md action, one column per
 * `AcademyRole`) so a later item (branches, staff, students, grade-bands,
 * ...) only ever adds new keys to `ACADEMY_PERMISSIONS` and, if it needs a
 * level this table doesn't have yet (e.g. `Approve`), a new
 * `AcademyPermissionLevel` member — never a redesign of the lookup
 * mechanism or `hasAcademyPermission`'s signature. Action identifiers are
 * plain strings (not a closed union) for the same reason
 * `hasPermission()`'s `capability` parameter is a plain string: a new
 * action shouldn't require touching a central enum.
 *
 * Branch-scoped roles (Admissions Officer, Trainer) are out of scope here:
 * the Master Permission Matrix marks "Academy settings" as
 * "n/a (academy-wide only)" for the branch-limited scope column, and both
 * those roles get `—` (none) on this row anyway — branch-scoping logic
 * belongs to whichever later item first needs it (Branches/Staff/Students),
 * not to this one.
 */
export const ACADEMY_PERMISSION_LEVELS = [
  "full",
  "view_edit",
  "view",
  "manage",
  "none",
] as const;

export type AcademyPermissionLevel = (typeof ACADEMY_PERMISSION_LEVELS)[number];

/**
 * PLAN.md Master Permission Matrix row: "Academy settings (direct edit)".
 * The identifier follows the same dotted-namespace convention already used
 * for platform capabilities in lib/auth/permissions.ts
 * (`plans.manage`, `platform.revenue.view`, `platform.staff.manage`) —
 * `academy.<row>` for later items to follow (e.g. `academy.branches`,
 * `academy.staff`).
 */
export const ACADEMY_SETTINGS_ACTION = "academy.settings";

/**
 * The extension point: one row per Master Permission Matrix "Academy-level
 * actions" line, one column per `AcademyRole`. Only `academy.settings` is
 * populated — see module comment above. A role/action combination that is
 * absent from this table (rather than explicitly `"none"`) is treated
 * identically to `"none"` by `getAcademyPermissionLevel` below, so later
 * items may add either a full row up front or grow it action-by-action.
 */
const ACADEMY_PERMISSIONS: Record<
  AcademyRole,
  Partial<Record<string, AcademyPermissionLevel>>
> = {
  academy_owner: {
    [ACADEMY_SETTINGS_ACTION]: "full",
  },
  academy_admin: {
    [ACADEMY_SETTINGS_ACTION]: "full",
  },
  // PLAN.md's matrix cell literally reads "View/Edit" — a value the
  // matrix's own legend (Full/Manage/View/Approve/Per grant) never defines
  // anywhere else in the document. Judgment call, documented explicitly
  // per the task brief: for this one row there is nothing to view that
  // isn't also editable (a settings form has no separate "browse" mode,
  // and the row has no archive/delete-equivalent for "Full" to mean
  // something "View/Edit" doesn't) — so "view_edit" is treated as
  // edit-capable, identically to "full", by every caller in this codebase
  // that only asks "can this role access academy.settings at all"
  // (lib/academies/settings.ts's updateAcademySettings/getOwnAcademyUsage
  // both do). The level is still stored distinctly (not collapsed into
  // "full") so a later item that ever needs to tell Owner/Admin's "Full"
  // apart from Manager's "View/Edit" for some *other* purpose — e.g. a
  // future capability tied specifically to this row that PLAN.md hasn't
  // named yet — has the real matrix cell to key off, rather than a
  // pre-collapsed boolean.
  manager: {
    [ACADEMY_SETTINGS_ACTION]: "view_edit",
  },
  admissions_officer: {},
  finance_officer: {},
  trainer: {},
};

/**
 * The raw matrix cell for (role, action). Returns `"none"` for any
 * role/action combination this table doesn't (yet) list — matching the
 * Master Permission Matrix legend's `—` = "never visible/callable, not
 * merely hidden".
 */
export function getAcademyPermissionLevel(
  role: AcademyRole,
  action: string,
): AcademyPermissionLevel {
  return ACADEMY_PERMISSIONS[role]?.[action] ?? "none";
}

/**
 * The boolean the task brief asks for: "does this role have any access to
 * this action at all". For every action populated in this table today
 * (just `academy.settings`), the only two non-`"none"` levels that exist
 * (`full`, `view_edit`) both permit viewing *and* editing — see the
 * `manager` comment above — so this single boolean is sufficient for
 * `updateAcademySettings` and `getOwnAcademyUsage` to gate on directly.
 * A later item whose action legitimately splits view-only from edit
 * capability (e.g. a `View`-only role on some other row) should call
 * `getAcademyPermissionLevel` directly rather than stretching this
 * function's meaning.
 */
export function hasAcademyPermission(role: AcademyRole, action: string): boolean {
  return getAcademyPermissionLevel(role, action) !== "none";
}
