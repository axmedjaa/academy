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
  "approve",
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
 * configuration" row, ORIGINALLY: Full(owner)/Manage(admin)/
 * "Manage/Approve"(manager)/—/—/—, scope n/a (no branch-limited variant —
 * this row has no "assigned" scope column entry in the matrix). Additive
 * row only.
 *
 * Original judgment call (Item 46): the matrix's Manager cell read
 * "Manage/Approve" — both manage AND approve authority in one cell, unlike
 * Academy Administrator's plain "Manage" (no approve). Rather than
 * inventing a compound level (this table's `AcademyPermissionLevel` union
 * has no "manage_approve" member), Manager was given the existing "full"
 * level here — this table's convention elsewhere already treats "full" and
 * "manage" as equally create/edit-capable — so the distinguishing fact that
 * mattered at the time — Manager can approve, Academy Administrator cannot
 * — was expressed by gating `approveGradeConfig`/`rejectGradeConfig` on
 * `level === "full"` specifically (see lib/academies/
 * grade-configurations.ts's `canApprove`), while Academy Administrator's
 * "manage" level gated plain CRUD only.
 *
 * ---------------------------------------------------------------------
 * Later architecture decision — Academy Administrator raised to "full"
 * ---------------------------------------------------------------------
 * "No approval workflow should ever block Owner/Academy Administrator/
 * Manager on an action they are already authorized to perform" —
 * explicitly approved, scoped to this row only. Academy Administrator's
 * level here is raised from "manage" to "full", matching Owner/Manager
 * exactly: Academy Administrator can now approve/reject ANY submitted
 * grade configuration (not just self-decide their own), the same authority
 * Owner/Manager already had. `grade-configurations.ts`'s existing
 * `canSelfDecide = canManage(level) && canApprove(level)` needed no code
 * change at all — both checks already pass at `"full"`, so Academy
 * Administrator automatically gained self-decide the instant this level
 * changed. This is a genuine, deliberate reversal of the original Item 46
 * decision above (documented rather than silently overwritten) — every
 * OTHER permission row (expenses, student payments, results, ...) is
 * unaffected; Academy Administrator gains nothing here beyond grade-band
 * configuration authority.
 */
export const ACADEMY_GRADE_BANDS_ACTION = "academy.grade_bands";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_GRADE_BANDS_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_GRADE_BANDS_ACTION] = "full";
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

/**
 * PLAN.md Phase 3, Item 49 — Master Permission Matrix "Result approve /
 * reject / publish" row: Approve(owner)/Approve(admin)/Approve(manager)/
 * —(admissions_officer)/—(finance_officer)/"Submit only"(trainer), scope
 * n/a. A genuinely NEW row (not a reuse of `ACADEMY_EXAMS_ACTION`) — the
 * matrix lists it as its own distinct line with its own distinct cell
 * values, and critically, Academy Administrator's cell here is "Approve"
 * (unlike the grade-configuration approval row, where Admin is capped at
 * "Manage" and never reaches Approve — see `ACADEMY_GRADE_BANDS_ACTION`'s
 * comment). Reusing that row's "full"/"manage" split would have wrongly
 * excluded Admin from approving/rejecting/publishing results.
 *
 * New level: "approve" (added to `AcademyPermissionLevel` above,
 * additively). Not reusing "full"/"manage": this row's three
 * approve-capable roles (Owner/Admin/Manager) are otherwise ungraded
 * relative to each other (there is no separate "manage-only, non-approving"
 * cell on this row the way the grade-band row distinguishes Admin's
 * "Manage" from Manager's "Manage/Approve") — a single new level keeps
 * `lib/academies/results.ts`'s `canApprove` gate a plain
 * `level === "approve"` check, and avoids overloading "full"/"manage"
 * (which every other row in this table already uses to mean "can create/
 * edit the parent entity itself") with a meaning ("can decide on a
 * submitted item") those levels don't carry anywhere else.
 *
 * ---------------------------------------------------------------------
 * Trainer: deliberately NO entry on this row — reasoning, not an omission
 * ---------------------------------------------------------------------
 * The matrix's Trainer cell reads "Submit only." `submitResults` is
 * explicitly documented (PLAN.md's Result Lifecycle table, `Marks
 * Entered -> Submitted` row) as using "same actors as [enterMarks]" —
 * i.e. it is gated on `ACADEMY_EXAMS_ACTION`'s `"enter_marks"` level
 * (already granted to Trainer above), NOT on this row at all. Trainer
 * never calls `approveResult`/`rejectResult`/`publishResults` (the three
 * actions this row actually gates), so there is no capability left on
 * this row for Trainer to hold: adding e.g. a `"submit"` level here would
 * be a second, unused gate on an action (`submitResults`) that already has
 * exactly one gate (`ACADEMY_EXAMS_ACTION`). Leaving Trainer unset here
 * means `getAcademyPermissionLevel("trainer", ACADEMY_RESULTS_ACTION)`
 * returns `"none"` — the correct answer, since Trainer has no access to
 * anything this row actually protects (approve/reject/publish are all
 * "—" for Trainer on the matrix's own text). This is the same reasoning
 * PLAN.md's own row 131 ("Result correction request") uses when it says
 * "Same authority as submit/approve above — no separate role": the
 * distinct actions on this row are simply gated by whichever row already
 * covers them, not duplicated onto a new one.
 */
export const ACADEMY_RESULTS_ACTION = "academy.results";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_RESULTS_ACTION] = "approve";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_RESULTS_ACTION] = "approve";
ACADEMY_PERMISSIONS.manager[ACADEMY_RESULTS_ACTION] = "approve";

/**
 * PLAN.md Phase 4, Item 51 — Master Permission Matrix "Student payments
 * (record)" row (PLAN.md line 132, DESIGN.md §5 line 149, identical):
 * View(owner)/View(admin)/"Approve/Manage"(manager)/—(admissions_officer)/
 * "Manage (not own)"(finance_officer)/View(trainer), scope n/a in PLAN.md's
 * own scope column — but DESIGN.md §5's branch-scope note ("Admissions
 * Officer and Trainer are branch-limited") makes Trainer's View branch-
 * scoped in practice; see lib/academies/student-payments.ts's
 * BRANCH_LIMITED_ROLES-style handling of this row specifically (Admissions
 * Officer has no access on this row at all, so only Trainer's read is ever
 * actually branch-filtered here).
 *
 * ---------------------------------------------------------------------
 * Decision A's Manager-vs-Finance-Officer "Manage" encoding
 * ---------------------------------------------------------------------
 * Both Manager's and Finance Officer's cells use the word "Manage," but per
 * the task brief's pre-resolved decision A (DESIGN.md §5's own legend:
 * "Manage = create/edit within own scope; Approve = decision-making on
 * submitted items"), only Manager's cell ("Approve/Manage") actually carries
 * approve authority — Finance Officer's "Manage (not own)" is manage-only,
 * and the "(not own)" qualifier is the *general* self-approval rule
 * (already enforced universally by lib/academies/approval-requests.ts's
 * decideApprovalRequest) restated on this specific row, not a second,
 * narrower permission tier.
 *
 * Rather than inventing a new `AcademyPermissionLevel` member for this
 * (e.g. "manage_approve"), this reuses the exact precedent
 * ACADEMY_GRADE_BANDS_ACTION already set for an identically-shaped
 * problem (Manager's "Manage/Approve" cell vs. Academy Administrator's
 * plain "Manage" cell there): Manager is given "full" (this table's
 * existing full/manage split is otherwise all Owner/Admin get "full" —
 * this is the one row where Manager, not Owner/Admin, reaches "full", by
 * deliberate design, exactly mirroring the grade-bands row's Manager
 * treatment), and Finance Officer is given "manage". Both "full" and
 * "manage" pass `canManage`'s "full"-or-"manage" gate identically (so both
 * roles can call createStudentCharge/recordStudentPayment/issueReceipt),
 * but only `level === "full"` passes the narrower `canReverse` gate that
 * `lib/academies/finance-reversals.ts` uses to gate reversal/adjustment —
 * so Finance Officer structurally can never reach reversal authority on this
 * row, for anyone's submission, not just their own. (Student-payment
 * recording itself has no approval step at all anymore — recording is
 * immediately effective for Manager, Finance Officer, and Academy
 * Administrator alike; see `lib/academies/student-payments.ts`'s module
 * comment.)
 *
 * Academy Administrator was originally "view" here (deliberately NOT
 * "full"/"manage", per PLAN.md/DESIGN.md's stated inversion for this one
 * row) — explicitly revised afterward (per the Afoogy manual student-payment
 * verification report's staff list, which names "Administrator" as
 * authorized to record payments) to "manage": the same level as Finance
 * Officer, granting record/create/issue-receipt authority but NOT reversal
 * (`canReverse` still requires "full", i.e. Manager only — this change does
 * not give Administrator the ability to reverse or adjust anyone's
 * payment). Academy Owner remains "view" — this revision was scoped to
 * Administrator only, matching what was explicitly approved.
 */
export const ACADEMY_STUDENT_PAYMENTS_ACTION = "academy.student_payments";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_STUDENT_PAYMENTS_ACTION] = "view";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_STUDENT_PAYMENTS_ACTION] = "manage";
ACADEMY_PERMISSIONS.manager[ACADEMY_STUDENT_PAYMENTS_ACTION] = "full";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_STUDENT_PAYMENTS_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_STUDENT_PAYMENTS_ACTION] = "view";

/**
 * PLAN.md Phase 4, Item 53 — Master Permission Matrix "Expenses
 * (create/approve)" row (PLAN.md line 133, DESIGN.md §5 line 150,
 * identical), ORIGINALLY: View(owner)/Approve(admin)/Approve(manager)/
 * —(admissions_officer)/"Create/Submit"(finance_officer)/View(trainer),
 * scope n/a. Uses the existing "approve" level (same one
 * ACADEMY_RESULTS_ACTION already established) for Admin/Manager, and
 * "manage" for Finance Officer's create/submit capability — kept distinct
 * from ACADEMY_STUDENT_PAYMENTS_ACTION's row (decision D) since no
 * expense-approval action would ever check a level meaningful only for
 * income, and vice versa.
 *
 * ---------------------------------------------------------------------
 * Later architecture decision — Owner raised to "manage"; self-approval
 * widened for all four
 * ---------------------------------------------------------------------
 * "Owner, Academy Administrator, Manager, and Finance Officer must all be
 * able to create/record AND approve their own Expense" — explicitly
 * approved, scoped to this row only:
 *
 *  - Owner raised from "view" to "manage" (matching Finance Officer) so
 *    Owner can create/submit an expense — Owner previously had no create
 *    capability on this row at all.
 *  - Admin/Manager stay at "approve" (level UNCHANGED) — their EXISTING
 *    general approve-anyone authority (and `canReverseExpense`'s
 *    `level === "approve"` reversal gate) is untouched. `canCreate` in
 *    expense-records.ts was widened to also accept `"approve"`, so
 *    Admin/Manager gain create/submit WITHOUT any matrix change here.
 *  - Finance Officer's level is UNCHANGED ("manage") — Finance Officer
 *    does NOT gain general approve-anyone authority (still `level !==
 *    "approve"`). Finance Officer's new ability to decide their OWN
 *    submission is granted entirely in expense-records.ts's
 *    `approveExpense`/`rejectExpense` via a role-based check
 *    (`SELF_APPROVE_ROLES`), independent of this permission level — the
 *    first case in this codebase where self-decide is granted to a role
 *    that never reaches the entity's own general "approve" level at all
 *    (contrast the grade-configuration/results precedent, where self-decide
 *    was always "the actor already independently qualifies for both the
 *    create and the approve gate").
 *
 * Net effect on this row: Owner "view" -> "manage". Admin/Manager/Finance
 * Officer levels are byte-for-byte unchanged; every behavior difference
 * for them lives in expense-records.ts's function-level logic instead.
 */
export const ACADEMY_EXPENSES_ACTION = "academy.expenses";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_EXPENSES_ACTION] = "manage";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_EXPENSES_ACTION] = "approve";
ACADEMY_PERMISSIONS.manager[ACADEMY_EXPENSES_ACTION] = "approve";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_EXPENSES_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_EXPENSES_ACTION] = "view";

/**
 * PLAN.md Phase 4, Item 53 — Income has NO Master Permission Matrix row in
 * either PLAN.md or DESIGN.md's main matrices, but PLAN.md's "Finance
 * Lifecycle (Phase 4)" table (Lifecycle & State-Transition Tables) resolves
 * this directly, verbatim: "`income_records` | `posted` directly by
 * **Manager or Finance Officer** (no approval step — no dedicated Master
 * Permission Matrix row exists for income specifically, so this reuses the
 * same recording capability the matrix already grants those two roles for
 * `student_payments`, rather than inventing a new permission)." This is no
 * longer a judgment call (a Wave 1 patch had initially given Manager
 * "view" only, mirroring Item 53's own then-undiscovered-source guess) —
 * corrected in Wave 2 once this table was found: Manager gets the same
 * "manage" (create) level as Finance Officer, matching PLAN.md's literal
 * "reuses the same recording capability" instruction exactly. Owner/Admin
 * remain read-only view, Admissions Officer/Trainer no access. Kept as its
 * OWN row, separate from ACADEMY_EXPENSES_ACTION (decision D): an
 * approve-capable level on this row would be permanently meaningless, since
 * no income-approval action will ever exist to check it against.
 */
export const ACADEMY_INCOME_ACTION = "academy.income";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_INCOME_ACTION] = "view";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_INCOME_ACTION] = "view";
ACADEMY_PERMISSIONS.manager[ACADEMY_INCOME_ACTION] = "manage";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_INCOME_ACTION] = "manage";

/**
 * PLAN.md Phase 5, Item 57 — Master Permission Matrix "Certificates
 * (issue/cancel)" row (PLAN.md line 135, DESIGN.md §5 line 151, identical):
 * Full(owner)/Manage(admin)/Manage(manager)/—(admissions_officer)/
 * —(finance_officer)/View(trainer), scope "n/a". Both "full" and "manage"
 * pass `issueCertificate`/`cancelCertificate`'s "full"-or-"manage" gate
 * identically (lib/academies/certificates.ts's `canManage`) — Owner, Admin,
 * and Manager may all issue/cancel. Trainer gets "view" only (can list/view
 * certificates, e.g. for a batch they're assigned to, but never
 * issue/cancel) — no `canManage` gate ever passes for "view". Admissions
 * Officer and Finance Officer get no entry at all (their matrix cells are
 * both "—"), which `getAcademyPermissionLevel` already resolves to "none"
 * for any action absent from a role's row (see this file's own doc comment
 * on that fallback), so no explicit assignment is needed for either of
 * them here — same convention as every other row in this file that skips a
 * "—" cell rather than writing out an explicit "none".
 *
 * No new `AcademyPermissionLevel` member is needed: "full"/"manage"/"view"
 * all already exist (established by earlier rows in this file), and this
 * row uses only those three — exactly the levels PLAN.md's/DESIGN.md's
 * matrix cells name for it.
 */
export const ACADEMY_CERTIFICATES_ACTION = "academy.certificates";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_CERTIFICATES_ACTION] = "full";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_CERTIFICATES_ACTION] = "manage";
ACADEMY_PERMISSIONS.manager[ACADEMY_CERTIFICATES_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_CERTIFICATES_ACTION] = "view";

/**
 * Student Fee Periods (new feature, not in PLAN.md/DESIGN.md's original
 * matrix). Mirrors ACADEMY_STUDENT_PAYMENTS_ACTION exactly, row for row —
 * fee-period payments are recorded through the SAME student_payments table
 * (see lib/academies/fee-periods.ts's module comment), so the authority to
 * manage them must be identical: Owner/Trainer view-only, Manager full,
 * Finance Officer and Academy Administrator manage, Admissions Officer no
 * access. (Academy Administrator raised from "view" to "manage" alongside
 * ACADEMY_STUDENT_PAYMENTS_ACTION above — see that row's own comment for
 * why.)
 */
export const ACADEMY_FEE_PERIODS_ACTION = "academy.fee_periods";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_FEE_PERIODS_ACTION] = "view";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_FEE_PERIODS_ACTION] = "manage";
ACADEMY_PERMISSIONS.manager[ACADEMY_FEE_PERIODS_ACTION] = "full";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_FEE_PERIODS_ACTION] = "manage";
ACADEMY_PERMISSIONS.trainer[ACADEMY_FEE_PERIODS_ACTION] = "view";

/**
 * Academy Books (new feature). No approval workflow exists for this domain
 * (book-sale income posts directly, matching ACADEMY_INCOME_ACTION's
 * no-approval design) — "manage" is therefore the top level anyone reaches,
 * same shape as ACADEMY_INCOME_ACTION's row. Owner/Admin get read-only
 * visibility (can see the catalogue/sales history), Manager and Finance
 * Officer can create books, sell, record additional payments, and refund.
 * Admissions Officer/Trainer have no entry ("none").
 */
export const ACADEMY_BOOKS_ACTION = "academy.books";
ACADEMY_PERMISSIONS.academy_owner[ACADEMY_BOOKS_ACTION] = "view";
ACADEMY_PERMISSIONS.academy_admin[ACADEMY_BOOKS_ACTION] = "view";
ACADEMY_PERMISSIONS.manager[ACADEMY_BOOKS_ACTION] = "manage";
ACADEMY_PERMISSIONS.finance_officer[ACADEMY_BOOKS_ACTION] = "manage";
