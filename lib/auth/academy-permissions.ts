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
  "enter_marks",
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
 * PLAN.md Item 42 / Master Permission Matrix row "Academy audit log
 * (view)": Full/Full/—/—/—/— ("n/a (Owner/Admin only, Decision #15)").
 * Gates `/academy/audit-logs` — see lib/academies/audit-logs.ts.
 */
export const ACADEMY_AUDIT_LOG_ACTION = "academy.audit_log";

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
    "academy.branches": "full",
    [ACADEMY_AUDIT_LOG_ACTION]: "full",
  },
  academy_admin: {
    [ACADEMY_SETTINGS_ACTION]: "full",
    "academy.branches": "full",
    [ACADEMY_AUDIT_LOG_ACTION]: "full",
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
    "academy.branches": "manage",
  },
  admissions_officer: {
    "academy.branches": "view",
  },
  finance_officer: {},
  trainer: {
    "academy.branches": "view",
  },
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

/**
 * PLAN.md Item 35 — Master Permission Matrix "Staff" row: Owner Full,
 * Admin Full, Manager Manage, Admissions —, Finance —, Trainer
 * "View self/assigned". Additive row only (see this file's module comment
 * on how later items extend `ACADEMY_PERMISSIONS`) — mutated in place
 * rather than editing the object literal above, so this never collides
 * with another item's own additive row landing in the same object at the
 * same time.
 *
 * Judgment call on Trainer: the matrix's "View self/assigned" is a
 * branch/self-scoped read, but branch-scoping (`staff_branch_assignments`,
 * assigned to Item 36) doesn't exist yet — this row grants Trainer the
 * unqualified "view" level for now (same level name PLAN.md's own legend
 * uses elsewhere), and lib/academies/staff.ts's `listStaff` documents,
 * at its own call site, that the result is academy-wide rather than
 * filtered to "self/assigned" until Item 36 adds that filter.
 */
export const ACADEMY_STAFF_ACTION = "academy.staff";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_STAFF_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_STAFF_ACTION] = "full";
ACADEMY_PERMISSIONS.manager[ACADEMY_STAFF_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_STAFF_ACTION] = "view";

/**
 * PLAN.md Item 38 — Master Permission Matrix "Students / admissions" row:
 * Owner Full, Admin Full, Manager Manage, Admissions Officer Manage,
 * Finance Officer View, Trainer "View assigned" — scope "assigned" for
 * the two branch-limited roles (Admissions Officer, Trainer). Same
 * additive-row convention as ACADEMY_STAFF_ACTION directly above: mutated
 * in place rather than editing the object literal, so this never collides
 * with another item's own additive row (e.g. Item 40's
 * "academy.student_id_cards") landing in the same object at the same
 * time.
 *
 * Judgment call on Trainer: the matrix's "View assigned" is a
 * branch-scoped read, modeled the same way ACADEMY_STAFF_ACTION's Trainer
 * comment above already treats "View self/assigned" — the unqualified
 * "view" level for now; lib/academies/register-student.ts documents, at
 * its own call site, that branch-scoping for *registration* (Admissions
 * Officer only, since Trainer never reaches "manage" on this row) is
 * enforced there via staff_branch_assignments.
 */
export const ACADEMY_STUDENTS_ACTION = "academy.students";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_STUDENTS_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_STUDENTS_ACTION] = "full";
ACADEMY_PERMISSIONS.manager[ACADEMY_STUDENTS_ACTION] = "manage";
ACADEMY_PERMISSIONS.admissions_officer[ACADEMY_STUDENTS_ACTION] = "manage";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_STUDENTS_ACTION] = "view";
ACADEMY_PERMISSIONS.trainer[ACADEMY_STUDENTS_ACTION] = "view";

/**
 * PLAN.md Item 40 — Master Permission Matrix "Student ID cards" row:
 * Full(owner)/Manage(admin)/Manage(manager)/Manage(admissions_officer)/
 * none(finance_officer)/none(trainer), scope "assigned" for the two
 * branch-limited roles. Additive row only, mutated in place at the bottom
 * of this file per the module comment's convention — see
 * ACADEMY_STAFF_ACTION just above for the identical pattern, so a
 * concurrently-landing sibling row (e.g. "academy.students") never
 * collides with this one in the same object-literal edit.
 */
export const ACADEMY_STUDENT_ID_CARDS_ACTION = "academy.student_id_cards";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_STUDENT_ID_CARDS_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_STUDENT_ID_CARDS_ACTION] = "manage";
ACADEMY_PERMISSIONS.manager[ACADEMY_STUDENT_ID_CARDS_ACTION] = "manage";
ACADEMY_PERMISSIONS.admissions_officer[ACADEMY_STUDENT_ID_CARDS_ACTION] = "manage";

/**
 * PLAN.md Phase 3, Item 43 — Master Permission Matrix "Courses / batches"
 * row: Full(owner)/Full(admin)/Manage(manager)/View(admissions_officer)/
 * —(finance_officer)/"Manage assigned"(trainer), scope "assigned" for the
 * two branch-limited roles. Additive row only, mutated in place at the
 * bottom of this file per the module comment's convention.
 *
 * Judgment call on Trainer: unlike every other branch-limited row in this
 * table so far (Staff/Students/Student ID cards, all "view"-level for
 * Trainer), the matrix's own cell text for Trainer here is literally
 * "Manage assigned" — a manage-capable level, not merely a read one. This
 * is modeled as the "manage" level directly (not a new level), matching
 * this table's existing convention that "manage" already means "create/
 * edit within scope" — the scope itself (branch-limited, via a batch's
 * `branch_id`) is enforced by lib/academies/batches.ts, not by this table.
 * Programs and courses have no branch_id column at all (see PLAN.md's
 * schema for those two tables) — they're academy-wide for every role that
 * can see them, so a Trainer's "manage assigned" only ever bites on
 * `batches`, never on `createProgram`/`createCourse` (which lib/academies/
 * programs.ts / courses.ts refuse to a Trainer entirely, since a Trainer
 * assigned to a specific batch's branch has no meaningful "manage" action
 * on an academy-wide program/course row).
 */
export const ACADEMY_COURSES_BATCHES_ACTION = "academy.courses_batches";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_COURSES_BATCHES_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_COURSES_BATCHES_ACTION] = "full";
ACADEMY_PERMISSIONS.manager[ACADEMY_COURSES_BATCHES_ACTION] = "manage";
ACADEMY_PERMISSIONS.admissions_officer[ACADEMY_COURSES_BATCHES_ACTION] = "view";
ACADEMY_PERMISSIONS.trainer[ACADEMY_COURSES_BATCHES_ACTION] = "manage";

/**
 * PLAN.md Phase 3, Item 46 — Master Permission Matrix "Grade-band
 * configuration" row: Full(owner)/Manage(admin)/"Manage/Approve"(manager)/
 * —/—/—, scope n/a (no branch-limited variant — this row has no
 * "assigned" scope column entry in the matrix). Additive row only.
 *
 * Judgment call: the matrix's Manager cell reads "Manage/Approve" — both
 * manage AND approve authority in one cell, unlike Academy Administrator's
 * plain "Manage" (no approve). Rather than inventing a compound level (this
 * table's `AcademyPermissionLevel` union has no "manage_approve" member,
 * and adding one would ripple through every existing consumer of that
 * union for a single row), Manager is given the existing "full" level here
 * — this table's convention elsewhere already treats "full" and "manage"
 * as equally create/edit-capable (see e.g. createBranch's `canManage()`
 * treating both as capable), so the distinguishing fact that actually
 * matters — Manager can approve, Academy Administrator cannot — is *not*
 * expressible as a difference between "full" and "manage" anyway. Academy
 * Owner also reaches Approve authority per the grade-configuration
 * lifecycle table ("Manager, and Academy Owner via their existing `Full`
 * authority — not Academy Administrator"), which already has "full" here,
 * consistent with this choice. This item builds no approval flow itself
 * (that's a separate, later item — see lib/academies/
 * grade-configurations.ts's module comment) — the level distinction here
 * only needs to exist now so that later item can gate `approveGradeConfig`
 * on `getAcademyPermissionLevel(role, ACADEMY_GRADE_BANDS_ACTION) === "full"`
 * (Owner/Manager) without redesigning this row, while Academy
 * Administrator's "manage" level continues to gate plain CRUD only.
 */
export const ACADEMY_GRADE_BANDS_ACTION = "academy.grade_bands";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_GRADE_BANDS_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_GRADE_BANDS_ACTION] = "manage";
ACADEMY_PERMISSIONS.manager[ACADEMY_GRADE_BANDS_ACTION] = "full";

/**
 * PLAN.md Phase 3, Item 48 — Master Permission Matrix "Exam mark entry" row:
 * Full(owner)/Full(admin)/Manage(manager)/—(admissions_officer)/
 * —(finance_officer)/"Enter marks (assigned batches only)"(trainer), scope
 * "assigned" for the branch-limited-role column. This is a genuinely NEW
 * row — not a reuse of ACADEMY_COURSES_BATCHES_ACTION ("Courses / batches")
 * the way Item 44/45 reused that row for trainer assignment/enrollment/
 * timetables — because the Master Permission Matrix lists "Exam mark
 * entry" as its own distinct line with its own distinct cell values
 * (Trainer's cell here is narrower than "Courses / batches"'s "Manage
 * assigned": a Trainer may enter marks into an existing exam on their own
 * assigned batch, but per the same matrix row's literal wording, and per
 * the Result Lifecycle table's actor column, may NOT create the exam
 * itself — createExam is Owner/Admin/Manager only, see
 * lib/academies/exams.ts's `canManage` gate).
 *
 * New level: "enter_marks" (added to `AcademyPermissionLevel` above,
 * additively, per this file's own extension-point convention). Not
 * reusing "view" (a read-only level everywhere else it's used in this
 * table — Trainer can definitely WRITE marks, just scoped to their own
 * batches) or "manage" (which every other row in this table already uses
 * to mean "can create/edit the parent entity itself" — a Trainer here
 * explicitly cannot create exams, only enter marks into ones that already
 * exist, so overloading "manage" would wrongly imply createExam access).
 * A distinct level lets lib/academies/exams.ts gate `createExam` on
 * `canManage` (full/manage: Owner/Admin/Manager) and `enterMarks` on a
 * separate, wider `canEnterMarks` (full/manage/enter_marks) without either
 * check accidentally admitting the wrong role.
 *
 * IMPORTANT — this is NOT the branch-based scoping every other
 * branch-limited row in this table uses (staff_branch_assignments, via
 * each file's own `getAssignedBranchIds`/`isBranchLimited`/
 * `BRANCH_LIMITED_ROLES`). The matrix's "assigned" scope for this
 * particular row means "batches this Trainer is assigned to teach" via
 * `batch_trainer_assignments` — exactly the join
 * lib/academies/batch-assignments.ts's exported `getAssignedBatchIds`
 * already builds (see that file's own module comment, which calls this
 * out as its forward-looking reason for existing). lib/academies/exams.ts
 * imports and calls that function directly for `enterMarks`'s scoping
 * check; it does NOT add trainer to this file's `BRANCH_LIMITED_ROLES`-style
 * set or reuse any `staffBranchAssignments` join for this row.
 */
export const ACADEMY_EXAMS_ACTION = "academy.exams";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_EXAMS_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_EXAMS_ACTION] = "full";
ACADEMY_PERMISSIONS.manager[ACADEMY_EXAMS_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_EXAMS_ACTION] = "enter_marks";
