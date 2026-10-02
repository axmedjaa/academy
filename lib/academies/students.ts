import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  branches,
  certificates,
  examResults,
  staffBranchAssignments,
  staffProfiles,
  studentCharges,
  studentDocuments,
  studentIdCards,
  studentPayments,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBatchIds } from "@/lib/academies/batch-assignments";
import {
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { deleteObject, getDownloadUrl, getUploadUrl, headObject, type StorageContentType } from "@/lib/storage/client";
import { getStudentPhotoKey, isStudentPhotoKey } from "@/lib/storage/keys";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 2, Item 39 — "Student search/update (`/academy/students`),
 * admissions view." Master Permission Matrix "Students / admissions" row:
 * Full(owner)/Full(admin)/Manage(manager)/Manage(admissions_officer)/
 * View(finance_officer)/"View assigned"(trainer), scope "assigned" for the
 * two branch-limited roles (Admissions Officer, Trainer — Phase 2 §6: "an
 * Admissions Officer's student, admissions, and ID-card views are scoped to
 * their assigned branch(es) only, the same mechanism already defined for
 * Trainer").
 *
 * ---------------------------------------------------------------------
 * The `academy.students` permission-action constant
 * ---------------------------------------------------------------------
 * This item's brief warns that a concurrent item (38 — `registerStudent`)
 * is expected to add a `"academy.students"` row to
 * lib/auth/academy-permissions.ts (exported as `ACADEMY_STUDENTS_ACTION`),
 * and that this file must NEVER edit that one itself. It had not yet
 * landed while this file was first drafted, so it was built temporarily
 * against a local literal `"academy.students"` string; re-reading that
 * file just before finishing this item found Item 38's row had landed in
 * the meantime — with exactly the level assignments this item's own brief
 * (and the Master Permission Matrix "Students / admissions" row) already
 * called for: owner/admin `full`, manager/admissions_officer `manage`,
 * finance_officer/trainer `view`. This file now imports and reuses that
 * export directly, per the brief's own instruction, rather than keeping a
 * second, locally-defined constant around.
 */
export const STUDENTS_PERMISSION_ACTION = ACADEMY_STUDENTS_ACTION;

// PLAN.md §6 / lib/academies/branches.ts's identical set: the two
// branch-limited roles across every Phase 2 area.
const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set([
  "admissions_officer",
  "trainer",
]);

function isBranchLimited(role: AcademyRole): boolean {
  return BRANCH_LIMITED_ROLES.has(role);
}

// Matrix cells: Full/Full/Manage/Manage/View/"View assigned" ->
// full/full/manage/manage/view/view. "full" and "manage" are both
// edit-capable (matches every other Phase 2 area's full-vs-manage
// treatment, e.g. lib/academies/branches.ts's canManage) — this row has no
// documented distinction between what Full and Manage may each do beyond
// which roles hold which label.
const MANAGE_LEVELS: ReadonlySet<AcademyPermissionLevel> = new Set(["full", "manage"]);

function canManageStudents(level: AcademyPermissionLevel): boolean {
  return MANAGE_LEVELS.has(level);
}

function canViewStudents(level: AcademyPermissionLevel): boolean {
  return level !== "none";
}

/** Stricter than `canManageStudents`/archive: Admissions Officer holds
 * "manage" on this action for their own assigned branch (see this file's
 * module comment), but permanent deletion is deliberately narrower than
 * archive — only Owner/Admin/Manager (the three academy-wide roles) may
 * ever delete a student, matching the same restriction already applied to
 * Programs/Courses/Batches. */
function canDeleteStudent(role: AcademyRole, level: AcademyPermissionLevel): boolean {
  return canManageStudents(level) && !isBranchLimited(role);
}

export interface StudentActionError {
  code: "forbidden" | "validation" | "blocked" | "not_found" | "ineligible";
  message: string;
}

const FORBIDDEN: StudentActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's students.",
};

// Same generic-message IDOR-safety convention as
// lib/academies/branches.ts's NOT_FOUND: "doesn't exist", "belongs to
// another academy", and "belongs to an unassigned branch for a
// branch-limited caller" must all be indistinguishable to the caller,
// including via a guessed id.
const NOT_FOUND: StudentActionError = {
  code: "not_found",
  message: "Student not found.",
};

// Same IDOR-safe wording as lib/academies/branches.ts's own NOT_FOUND —
// a branchId belonging to a different academy must look identical to a
// nonexistent one.
const BRANCH_NOT_FOUND: StudentActionError = {
  code: "not_found",
  message: "Branch not found.",
};

function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

function optionalEmail(maxLength = 200) {
  return z
    .string()
    .trim()
    .toLowerCase()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address",
    });
}

/**
 * Full-object update, same "resubmit the whole form" convention as
 * lib/academies/staff.ts's updateStaffSchema. `studentNumber` and
 * `createdBy` are immutable here (registration's concern — Item 38 — not
 * this item's `updateStudent`). `branchId` is included because PLAN.md's
 * `students` table carries the branch relationship directly (not just via
 * staff assignment) and Owner/Admin/Manager may legitimately need to
 * transfer a student between branches; see `updateStudent`'s own comment
 * for the judgment call restricting this field for branch-limited callers.
 */
export const updateStudentSchema = z.object({
  branchId: z.string().uuid().optional(),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  dateOfBirth: optionalText(20),
  gender: optionalText(50),
  phone: optionalText(50),
  email: optionalEmail(),
  guardianName: optionalText(200),
  guardianPhone: optionalText(50),
  // No `profileImageRef` field here, deliberately — that column is a real
  // R2 object key, exclusively managed by confirmStudentPhotoUpload/
  // removeStudentPhoto below (each independently validating the key
  // before writing it), same posture as academies.logoRef being removed
  // from updateAcademySettings's general schema once it became R2-backed
  // (see academy-logo.ts's own module comment). Letting this general,
  // free-text-resubmit schema accept it would be a way to smuggle an
  // unvalidated string into a column later used to request a signed GET.
  status: z.enum(["active", "archived"]).optional(),
});

export type UpdateStudentInput = z.input<typeof updateStudentSchema>;

export interface StudentRecord {
  id: string;
  academyId: string;
  branchId: string;
  studentNumber: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  /** A real R2 object key, never a URL — see this column's own
   * schema.ts comment. Resolve to a short-lived signed GET URL via
   * `getStudentPhotoUrl` before ever handing it to the browser. */
  profileImageRef: string | null;
  status: "active" | "archived";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: typeof students.$inferSelect): StudentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    studentNumber: row.studentNumber,
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    guardianName: row.guardianName,
    guardianPhone: row.guardianPhone,
    profileImageRef: row.profileImageRef,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolves the caller's staff_profiles row (by userId+academyId) and its
 * staff_branch_assignments — identical join pattern to
 * lib/academies/branches.ts's getAssignedBranchIds (read-only reference,
 * reimplemented here rather than imported since that function isn't
 * exported and branches.ts is out of this item's write scope). A caller
 * with no staff_profiles row (or zero assignments) is assigned to nothing.
 *
 * Exported (Phase 5, Item 61a) so lib/academies/student-reports.ts can reuse
 * this exact branch-assignment lookup for its own branch-limited scoping
 * instead of re-implementing a third copy of the same join — this file
 * isn't on Item 61's do-not-touch list, and adding `export` here is a
 * behavior-preserving change (no existing call site is affected).
 */
export async function getAssignedBranchIds(
  executor: DbClient,
  academyId: string,
  userId: string,
): Promise<string[]> {
  const [profile] = await executor
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)))
    .limit(1);
  if (!profile) return [];

  const assignments = await executor
    .select({ branchId: staffBranchAssignments.branchId })
    .from(staffBranchAssignments)
    .where(eq(staffBranchAssignments.staffProfileId, profile.id));

  return assignments.map((row) => row.branchId);
}

// Same per-file local copy as lib/academies/batches.ts's
// branchExistsInAcademy — verifies a client-supplied branchId actually
// belongs to the caller's own academy, not just that it exists somewhere.
async function branchExistsInAcademy(
  executor: DbClient,
  academyId: string,
  branchId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.academyId, academyId)))
    .limit(1);
  return Boolean(row);
}

interface ResolvedStudentAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveStudentAccessResult =
  | { ok: true; access: ResolvedStudentAccess }
  | { ok: false; error: StudentActionError };

async function resolveStudentAccess(
  actorContext: AuthContext,
): Promise<ResolveStudentAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    STUDENTS_PERMISSION_ACTION,
  );
  if (permissionLevel === "none") {
    return { ok: false, error: FORBIDDEN };
  }

  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      permissionLevel,
    },
  };
}

// PLAN.md "Pagination, Search & Export Limits": "List endpoints paginated
// from this phase onward" — same default/max page size and offset-based
// shape already established by lib/audit-query.ts (Item 32a) for the first
// paginated list in this codebase; reused verbatim here as the second.
export const STUDENTS_DEFAULT_PAGE_SIZE = 15;
export const STUDENTS_MAX_PAGE_SIZE = 100;

function normalizePage(page: number | undefined): number {
  if (!page || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

function normalizePageSize(pageSize: number | undefined): number {
  const requested =
    pageSize && Number.isFinite(pageSize) ? Math.floor(pageSize) : STUDENTS_DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(requested, 1), STUDENTS_MAX_PAGE_SIZE);
}

export interface StudentSearchFilters {
  /** Matched (case-insensitively) against full_name OR student_number. */
  searchTerm?: string;
  /** Explicit branch narrowing. Academy-wide roles may pass any branch id
   * in their academy; branch-limited roles may only narrow within their
   * own assigned branch(es) — an out-of-scope value is simply treated as
   * "no matches" (never an error, same as any other tenant/scope
   * mismatch elsewhere in this codebase) rather than widening their view. */
  branchId?: string;
  status?: "active" | "archived";
}

export interface StudentSearchPagination {
  page?: number;
  pageSize?: number;
}

export interface StudentDeletionEligibilitySummary {
  eligible: boolean;
  reasons: string[];
}

export interface StudentSearchResult {
  rows: (StudentRecord & { deletionEligibility: StudentDeletionEligibilitySummary })[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export type SearchStudentsResult =
  | {
      ok: true;
      data: StudentSearchResult;
      permissionLevel: AcademyPermissionLevel;
      canManage: boolean;
      /** The caller's own academy role — exposed only so the page/UI can
       * decide whether to render a branch-transfer control (branch-limited
       * roles never get one; see updateStudent's branchId judgment call).
       * Never used for authorization itself — every mutation re-derives
       * and re-checks this server-side regardless of what the UI shows. */
      membershipRole: AcademyRole;
      /** Narrower than `canManage` — see `canDeleteStudent`'s own comment.
       * The UI renders the Delete action only when this is true (never a
       * disabled Delete for a role that can never reach it at all, per
       * DESIGN.md §"Rule for building any screen"). */
      canDelete: boolean;
    }
  | { ok: false; error: StudentActionError };

/**
 * Resolves the caller's own `batch_trainer_assignments` rows (active only)
 * and, from those, every distinct student with a `batch_enrollments` row in
 * any of those batches — the one authoritative "which students can this
 * Trainer see" relationship in this codebase (Trainer -> taught batches ->
 * enrollments -> students), the same join
 * lib/academies/batch-assignments.ts's own `getAssignedBatchIds` doc
 * comment names as the intended reuse point for exactly this kind of check,
 * rather than a new relationship invented here.
 *
 * Deliberately not filtered by `batch_enrollments.status` — a student who
 * completed or withdrew from a batch this Trainer taught was still taught
 * by them; only a student with *zero* enrollment rows in any of the
 * Trainer's batches is excluded. `selectDistinct` (rather than relying on
 * the caller's own `students.id` primary key to dedupe downstream) keeps
 * the id list itself small when a student is enrolled in several of the
 * Trainer's batches at once.
 */
async function getTrainerVisibleStudentIds(
  executor: DbClient,
  userId: string,
  academyId: string,
): Promise<string[]> {
  const batchIds = await getAssignedBatchIds(executor, userId, academyId);
  if (batchIds.length === 0) return [];

  const rows = await executor
    .selectDistinct({ studentId: batchEnrollments.studentId })
    .from(batchEnrollments)
    .where(inArray(batchEnrollments.batchId, batchIds));

  return rows.map((row) => row.studentId);
}

/**
 * Resolves the scoping WHERE clause shared by searchStudents,
 * getAdmissionsView, and getStudent: always tenant-scoped to the caller's
 * academy, plus a role-specific visibility scope on top:
 *
 * - Admissions Officer (and every academy-wide role — Owner/Admin/Manager/
 *   Finance Officer): no restriction beyond the academy itself. An
 *   Admissions Officer must see every student in their academy regardless
 *   of branch assignment (explicit product requirement — branch assignment
 *   is a separate, unrelated concern; see `isBranchLimited`'s remaining
 *   uses below, which are about student *mutation* permissions, not this).
 * - Trainer: restricted to `getTrainerVisibleStudentIds` above — students
 *   enrolled in a batch this Trainer teaches, not their branch, not "all
 *   active students," not students they personally registered.
 *
 * `requestedBranchId` (the search form's explicit Branch filter) is always
 * an additional narrowing `AND`, for every role — it can only shrink the
 * result, never expand a Trainer's own scope beyond their taught batches'
 * students, and an Admissions Officer picking a specific branch is exactly
 * as valid as an Owner doing the same.
 *
 * Returns `unreachable: true` when the caller's role-specific scope is
 * provably empty (a Trainer with no active batch assignments, or whose
 * batches currently have zero enrollments) so callers can short-circuit to
 * an empty result without running the main query at all — this must never
 * silently fall back to "show everything."
 *
 * Exported (Phase 5, Item 61a) for lib/academies/student-reports.ts to reuse
 * verbatim — its own conditions are plain `students.academyId`/
 * `students.branchId`/`students.id` SQL fragments, so they compose
 * unchanged into any query that joins through the `students` table, not
 * just this file's own `students`-rooted selects.
 */
export async function resolveScope(
  academyId: string,
  membershipRole: AcademyRole,
  userId: string,
  requestedBranchId: string | undefined,
): Promise<{ conditions: SQL[]; unreachable: boolean }> {
  const conditions: SQL[] = [eq(students.academyId, academyId)];

  if (membershipRole === "trainer") {
    const visibleStudentIds = await getTrainerVisibleStudentIds(db, userId, academyId);
    if (visibleStudentIds.length === 0) {
      return { conditions, unreachable: true };
    }
    conditions.push(inArray(students.id, visibleStudentIds));
  }

  if (requestedBranchId) {
    conditions.push(eq(students.branchId, requestedBranchId));
  }

  return { conditions, unreachable: false };
}

/**
 * PLAN.md §4 `searchStudents` / §3 `/academy/students`. Any non-"none"
 * level may search (Finance's "View", Trainer's "View assigned" included);
 * `canManage` on the result tells the page/UI whether to render edit
 * controls, same convention as lib/academies/branches.ts's listBranches.
 */
export async function searchStudents(
  actorContext: AuthContext,
  filters: StudentSearchFilters = {},
  pagination: StudentSearchPagination = {},
): Promise<SearchStudentsResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canViewStudents(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const page = normalizePage(pagination.page);
  const pageSize = normalizePageSize(pagination.pageSize);
  const offset = (page - 1) * pageSize;

  const scope = await resolveScope(academyId, membershipRole, actorContext.userId, filters.branchId);
  if (scope.unreachable) {
    return {
      ok: true,
      data: { rows: [], page, pageSize, totalCount: 0 },
      permissionLevel,
      canManage: canManageStudents(permissionLevel),
      membershipRole,
      canDelete: canDeleteStudent(membershipRole, permissionLevel),
    };
  }

  const conditions = [...scope.conditions];
  if (filters.status) {
    conditions.push(eq(students.status, filters.status));
  }
  const term = filters.searchTerm?.trim();
  if (term) {
    // ILIKE with '%' wrapping — the same "contains, case-insensitive"
    // convention as every free-text admin search a user would expect;
    // '%'/'_' in the raw term are passed through literally to Postgres's
    // ILIKE (no wildcard-escaping layer exists elsewhere in this codebase
    // to match, and a stray '%'/'_' only ever widens/narrows the match,
    // never an injection risk since this is a parameterized query).
    const pattern = `%${term}%`;
    conditions.push(
      or(ilike(students.fullName, pattern), ilike(students.studentNumber, pattern))!,
    );
  }
  const where = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(students)
      .where(where)
      .orderBy(desc(students.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(students).where(where),
  ]);

  const countsByStudentId = await countStudentDependentsBulk(rows.map((row) => row.id));

  return {
    ok: true,
    data: {
      rows: rows.map((row) => {
        const counts = countsByStudentId.get(row.id) ?? {
          enrollmentCount: 0,
          examResultCount: 0,
          chargeCount: 0,
          paymentCount: 0,
          certificateCount: 0,
        };
        const reasons = buildStudentDeletionReasons(counts);
        return { ...toRecord(row), deletionEligibility: { eligible: reasons.length === 0, reasons } };
      }),
      page,
      pageSize,
      totalCount: totalRows[0]?.value ?? 0,
    },
    permissionLevel,
    canManage: canManageStudents(permissionLevel),
    membershipRole,
    canDelete: canDeleteStudent(membershipRole, permissionLevel),
  };
}

export type GetStudentResult =
  | { ok: true; student: StudentRecord }
  | { ok: false; error: StudentActionError };

/**
 * Single-student read, tenant-scoped and (for a Trainer) further scoped to
 * their own taught-batch enrollments via the same `resolveScope` every
 * other read in this file uses — kept in sync automatically rather than a
 * second, hand-maintained copy of the same visibility rule. IDOR-safe: a
 * nonexistent id, a different academy's student, and (for a Trainer) a
 * student outside their taught batches all return the identical
 * `NOT_FOUND` — including for a guessed id — matching
 * lib/academies/branches.ts's getBranch exactly.
 */
export async function getStudent(
  actorContext: AuthContext,
  studentId: string,
): Promise<GetStudentResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canViewStudents(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const scope = await resolveScope(academyId, membershipRole, actorContext.userId, undefined);
  if (scope.unreachable) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(students)
    .where(and(...scope.conditions, eq(students.id, studentId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  return { ok: true, student: toRecord(row) };
}

export type UpdateStudentResult =
  | { ok: true; student: StudentRecord }
  | { ok: false; error: StudentActionError };

/**
 * PLAN.md §4 `updateStudent`. Gated to "full"/"manage" (Owner, Admin,
 * Manager, Admissions Officer) — Finance's "View" and Trainer's "View
 * assigned" are both view-only and refused here with `FORBIDDEN`, even
 * though both can read via searchStudents/getStudent.
 *
 * IDOR-safe lookup identical to getStudent: a branch-limited caller
 * (Admissions Officer) editing a student outside their assigned branch(es)
 * gets the same `NOT_FOUND` a nonexistent id would.
 *
 * Judgment call on `branchId`: a branch-limited caller (Admissions
 * Officer) may not change a student's `branchId` at all — allowing it
 * would let them either move a student they can see into a branch they
 * aren't assigned to (losing it from their own view, a one-way action
 * with no oversight) or, worse, reach into another branch's roster
 * indirectly by moving a student they can already act on. PLAN.md never
 * spells this restriction out explicitly, but it follows directly from
 * §6's "an Admissions Officer's ... views are scoped to their assigned
 * branch(es) only" combined with "Full/Manage/View" never being described
 * as including a cross-branch transfer capability for a branch-limited
 * role. Academy-wide roles (Owner/Admin/Manager) may set `branchId`
 * freely to any branch within their own academy (not validated against a
 * `branches` row here beyond the FK itself, matching this item's
 * read-only relationship to lib/academies/branches.ts).
 */
export async function updateStudent(
  actorContext: AuthContext,
  studentId: string,
  input: UpdateStudentInput,
): Promise<UpdateStudentResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManageStudents(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = updateStudentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const branchLimited = isBranchLimited(membershipRole);
  if (branchLimited && data.branchId !== undefined) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "You don't have permission to move a student to a different branch.",
      },
    };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.academyId, academyId)))
      .limit(1);
    if (!existing) return { outcome: "not_found" as const };

    if (branchLimited) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { outcome: "not_found" as const };
      }
    }

    // Academy-wide caller transferring the student: verify the target
    // branch actually belongs to this academy before writing anything —
    // the bare FK only proves the branch exists *somewhere*. No change is
    // made to the student row when this fails.
    if (!branchLimited && data.branchId !== undefined) {
      const branchOk = await branchExistsInAcademy(tx, academyId, data.branchId);
      if (!branchOk) {
        return { outcome: "invalid_branch" as const };
      }
    }

    const [updated] = await tx
      .update(students)
      .set({
        branchId: data.branchId ?? existing.branchId,
        fullName: data.fullName,
        dateOfBirth: data.dateOfBirth,
        gender: data.gender,
        phone: data.phone,
        email: data.email,
        guardianName: data.guardianName,
        guardianPhone: data.guardianPhone,
        status: data.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(students.id, studentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "updateStudent",
        entityType: "student",
        entityId: studentId,
        branchId: updated.branchId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return { outcome: "ok" as const, student: updated };
  });

  if (result.outcome === "not_found") {
    return { ok: false, error: NOT_FOUND };
  }
  if (result.outcome === "invalid_branch") {
    return { ok: false, error: BRANCH_NOT_FOUND };
  }
  return { ok: true, student: toRecord(result.student) };
}

// ---------------------------------------------------------------------
// Student profile photo (R2-backed) — lib/academies/academy-logo.ts's
// exact presign -> verify -> confirm/remove shape, adapted for a
// per-student column instead of a single academy-wide one. See
// students.profileImageRef's own schema.ts comment for why this is a
// dedicated column/flow rather than reusing student_id_cards.photo_file_ref.
// ---------------------------------------------------------------------

export const MAX_STUDENT_PHOTO_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedPhotoContentType = (typeof ALLOWED_PHOTO_CONTENT_TYPES)[number];

const PHOTO_EXTENSION_BY_CONTENT_TYPE: Record<AllowedPhotoContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isAllowedPhotoContentType(value: string): value is AllowedPhotoContentType {
  return (ALLOWED_PHOTO_CONTENT_TYPES as readonly string[]).includes(value);
}

const INVALID_PHOTO_FORMAT: StudentActionError = {
  code: "validation",
  message: "Photo must be JPEG, PNG, or WebP.",
};

const PHOTO_TOO_LARGE: StudentActionError = {
  code: "validation",
  message: "Photo must be 5 MB or smaller.",
};

const PHOTO_VERIFICATION_FAILED: StudentActionError = {
  code: "validation",
  message: "The photo upload could not be verified.",
};

/**
 * Resolves "this caller may manage this specific student" — the same
 * academy-wide + per-student branch-scope resolution `updateStudent`
 * performs, extracted here so the photo actions below don't each
 * re-derive it. Not exported; those actions are its only callers.
 */
async function resolveStudentForPhoto(
  actorContext: AuthContext,
  studentId: string,
): Promise<
  | { ok: true; academyId: string; membershipRole: AcademyRole; branchId: string }
  | { ok: false; error: StudentActionError }
> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManageStudents(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [existing] = await db
    .select({ branchId: students.branchId })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.academyId, academyId)))
    .limit(1);
  if (!existing) {
    return { ok: false, error: NOT_FOUND };
  }

  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(existing.branchId)) {
      return { ok: false, error: NOT_FOUND };
    }
  }

  return { ok: true, academyId, membershipRole, branchId: existing.branchId };
}

export interface RequestStudentPhotoUploadUrlInput {
  contentType: string;
  fileSizeBytes: number;
}

export type RequestStudentPhotoUploadUrlResult =
  | { ok: true; uploadUrl: string; key: string; expiresInSeconds: number }
  | { ok: false; error: StudentActionError };

async function requestPhotoUploadUrlFor(
  academyId: string,
  input: RequestStudentPhotoUploadUrlInput,
): Promise<RequestStudentPhotoUploadUrlResult> {
  if (!isAllowedPhotoContentType(input.contentType)) {
    return { ok: false, error: INVALID_PHOTO_FORMAT };
  }
  if (
    !Number.isFinite(input.fileSizeBytes) ||
    input.fileSizeBytes <= 0 ||
    input.fileSizeBytes > MAX_STUDENT_PHOTO_SIZE_BYTES
  ) {
    return { ok: false, error: PHOTO_TOO_LARGE };
  }

  const key = getStudentPhotoKey({
    academyId,
    extension: PHOTO_EXTENSION_BY_CONTENT_TYPE[input.contentType as AllowedPhotoContentType],
  });
  const result = await getUploadUrl({ key, contentType: input.contentType as StorageContentType });
  if (!result.ok) {
    return {
      ok: false,
      error: { code: "validation", message: "The photo upload could not be started. Please try again." },
    };
  }
  return { ok: true, uploadUrl: result.uploadUrl, key, expiresInSeconds: result.expiresInSeconds };
}

/**
 * Step 1 for an EXISTING student's photo. `resolveStudentForPhoto` checks
 * both the academy-wide `academy.students` permission AND (for a
 * branch-limited caller) that this specific student is within their
 * assigned branch — same two-layer check `updateStudent` itself performs
 * — before ever handing out a presigned PUT.
 */
export async function requestStudentPhotoUploadUrl(
  actorContext: AuthContext,
  studentId: string,
  input: RequestStudentPhotoUploadUrlInput,
): Promise<RequestStudentPhotoUploadUrlResult> {
  const resolved = await resolveStudentForPhoto(actorContext, studentId);
  if (!resolved.ok) return resolved;
  return requestPhotoUploadUrlFor(resolved.academyId, input);
}

/**
 * Step 1 for a NEW student's photo (the registration form) — no student
 * row exists yet, so this only checks the academy-wide permission (the
 * same gate `registerStudent` itself uses), not a specific student. The
 * key is academy-scoped, not student-scoped (lib/storage/keys.ts's
 * `getStudentPhotoKey`), so it can be uploaded to before the row exists,
 * then passed straight into lib/academies/register-student.ts's
 * `registerStudentSchema.profileImageRef` for `registerStudent` to verify
 * and persist in one step — same pattern as book covers'
 * `requestNewBookCoverUploadUrl`.
 */
export async function requestNewStudentPhotoUploadUrl(
  actorContext: AuthContext,
  input: RequestStudentPhotoUploadUrlInput,
): Promise<RequestStudentPhotoUploadUrlResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  if (!canManageStudents(resolved.access.permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }
  return requestPhotoUploadUrlFor(resolved.access.academyId, input);
}

/**
 * Shared verification authority for a claimed student-photo key — the
 * object must exist, match this academy's own key shape
 * (`isStudentPhotoKey`), and its REAL (server-reported) content-type/size
 * must be within the allowed set — never the client's claims from step 1.
 * An object that fails this check is deleted from R2 immediately (never
 * left as an orphaned invalid upload). Shared by `confirmStudentPhotoUpload`
 * (existing student) and `registerStudent` (new student) — both need the
 * identical check, the latter since it has no separate confirm step of its
 * own (same reasoning as `createBook`'s own `coverRef` verification).
 */
export async function verifyStudentPhotoUpload(
  key: string,
  academyId: string,
): Promise<{ ok: true } | { ok: false; error: StudentActionError }> {
  if (!isStudentPhotoKey(key, academyId)) {
    return { ok: false, error: { code: "validation", message: "Invalid upload reference." } };
  }

  const head = await headObject(key);
  if (!head.ok) {
    return { ok: false, error: PHOTO_VERIFICATION_FAILED };
  }
  if (!head.exists) {
    return {
      ok: false,
      error: { code: "not_found", message: "The uploaded photo could not be found. Please try uploading again." },
    };
  }
  if (!head.info.contentType || !isAllowedPhotoContentType(head.info.contentType)) {
    await deleteObject(key);
    return { ok: false, error: INVALID_PHOTO_FORMAT };
  }
  if (!head.info.contentLength || head.info.contentLength > MAX_STUDENT_PHOTO_SIZE_BYTES) {
    await deleteObject(key);
    return { ok: false, error: PHOTO_TOO_LARGE };
  }
  return { ok: true };
}

export type ConfirmStudentPhotoUploadResult =
  | { ok: true; profileImageRef: string }
  | { ok: false; error: StudentActionError };

/**
 * Step 2 for an EXISTING student — the only path that writes
 * `students.profileImageRef` for an already-registered student. Same
 * replacement ordering as `confirmAcademyLogoUpload`: the new key is
 * committed to the database FIRST (inside the same transaction as the
 * audit row); only once that succeeds is the OLD object deleted from R2,
 * best-effort, outside the transaction — a cleanup failure never rolls
 * back the already-authoritative new photo.
 */
export async function confirmStudentPhotoUpload(
  actorContext: AuthContext,
  studentId: string,
  input: { key: string },
): Promise<ConfirmStudentPhotoUploadResult> {
  const resolved = await resolveStudentForPhoto(actorContext, studentId);
  if (!resolved.ok) return resolved;

  const verification = await verifyStudentPhotoUpload(input.key, resolved.academyId);
  if (!verification.ok) return verification;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ profileImageRef: students.profileImageRef })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1);
    if (!existing) return null;

    const previousKey = existing.profileImageRef;
    await tx
      .update(students)
      .set({ profileImageRef: input.key, updatedAt: new Date() })
      .where(eq(students.id, studentId));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: resolved.membershipRole,
        academyId: resolved.academyId,
        action: previousKey ? "replaceStudentPhoto" : "uploadStudentPhoto",
        entityType: "student",
        entityId: studentId,
        branchId: resolved.branchId,
        before: { profileImageRef: previousKey },
        after: { profileImageRef: input.key },
      },
      tx,
    );

    return { previousKey };
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }

  if (result.previousKey && result.previousKey !== input.key) {
    const deleted = await deleteObject(result.previousKey);
    if (!deleted.ok) {
      logger.warn("student photo replacement: old R2 object could not be deleted (orphaned)", { studentId });
    }
  }

  return { ok: true, profileImageRef: input.key };
}

export type RemoveStudentPhotoResult = { ok: true } | { ok: false; error: StudentActionError };

/**
 * Removal ordering is the reverse of replacement's, same as
 * `removeAcademyLogo`: deletes the R2 object FIRST, then clears the
 * database reference. A no-op (still `ok: true`) when there is no photo
 * to remove.
 */
export async function removeStudentPhoto(
  actorContext: AuthContext,
  studentId: string,
): Promise<RemoveStudentPhotoResult> {
  const resolved = await resolveStudentForPhoto(actorContext, studentId);
  if (!resolved.ok) return resolved;

  const [existing] = await db
    .select({ profileImageRef: students.profileImageRef })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!existing) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!existing.profileImageRef) {
    return { ok: true };
  }

  const previousKey = existing.profileImageRef;
  const deleted = await deleteObject(previousKey);
  if (!deleted.ok) {
    logger.warn("student photo removal: R2 object could not be deleted (clearing database reference anyway)", {
      studentId,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(students)
      .set({ profileImageRef: null, updatedAt: new Date() })
      .where(eq(students.id, studentId));
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: resolved.membershipRole,
        academyId: resolved.academyId,
        action: "removeStudentPhoto",
        entityType: "student",
        entityId: studentId,
        branchId: resolved.branchId,
        before: { profileImageRef: previousKey },
        after: { profileImageRef: null },
      },
      tx,
    );
  });

  return { ok: true };
}

/**
 * Display-only read helper, NOT a Server Action — same convention as
 * `academy-logo.ts`'s `getAcademyLogoUrl`. Returns `null` (never throws)
 * if there's no photo, or if R2 is unreachable/misconfigured — a missing
 * photo is the correct degraded behavior (StudentAvatar's own initials
 * fallback), not a page-breaking error.
 */
export async function getStudentPhotoUrl(profileImageRef: string | null): Promise<string | null> {
  if (!profileImageRef) return null;
  const result = await getDownloadUrl({ key: profileImageRef });
  return result.ok ? result.downloadUrl : null;
}

/**
 * Batch variant of `getStudentPhotoUrl`, for pages that only have a list
 * of studentIds rather than full StudentRecord rows — e.g.
 * app/academy/results/page.tsx's `ResultRosterRow`, which carries
 * `studentId` but not `profileImageRef`. Every id passed in must have
 * already come from an authorized, tenant/scope-checked read (the same
 * "display-field fetch on already-authorized ids, not a fresh
 * authorization decision" posture as lib/academies/staff-labels.ts's
 * `resolveStaffLabels`) — this does not re-derive branch-scoping of its
 * own, only a plain academy-tenant check, since it never exposes anything
 * beyond a signed GET url for a photo the caller's own already-authorized
 * read already proved they may see the owning row of.
 *
 * Returns an empty map (never throws) for an empty id list or a blocked
 * caller — a page with no photos to show degrades to every row's
 * initials fallback, same as a single `getStudentPhotoUrl(null)`.
 */
export async function getStudentPhotoUrlsByIds(
  actorContext: AuthContext,
  studentIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(studentIds)];
  if (uniqueIds.length === 0) return new Map();

  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return new Map();

  const rows = await db
    .select({ id: students.id, profileImageRef: students.profileImageRef })
    .from(students)
    .where(and(eq(students.academyId, access.academyId), inArray(students.id, uniqueIds)));

  const entries = await Promise.all(
    rows
      .filter((row) => row.profileImageRef)
      .map(async (row) => {
        const url = await getStudentPhotoUrl(row.profileImageRef);
        return url ? ([row.id, url] as const) : null;
      }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null));
}

// ---------------------------------------------------------------------
// Admissions view (`/academy/admissions`)
// ---------------------------------------------------------------------
//
// DESIGN.md §9.2 describes `/academy/admissions` as "A (board/pipeline
// variant) | Applied -> Documents Pending -> Enrolled stages, quick advance
// action per row" — but the `students` table this item must read from
// (Item 37's schema, out of this item's write scope) has no pipeline-stage
// column at all: just `status enum(active, archived)`, no
// applied/documents_pending/enrolled values anywhere in the schema or in
// PLAN.md's Phase 2 §2 column list. Adding such a column is schema work
// squarely outside this item's authorized file list
// (lib/db/schema.ts is explicitly DO-NOT-TOUCH), so building the literal
// 3-stage board DESIGN.md sketches isn't possible without another item's
// migration.
//
// Judgment call (per this item's own brief, which explicitly allows this):
// the admissions view here is a reasonable admissions-focused subset of
// the same `students` rows, distinct from the plain `/academy/students`
// list by:
//   1. Scope: only `status = 'active'` students (an archived student was
//      never an active admissions concern).
//   2. Recency/pending-onboarding filter: a student is surfaced here only
//      if EITHER (a) they were registered within the last
//      `ADMISSIONS_RECENT_WINDOW_DAYS` days ("Applied" stand-in — someone
//      just walked in), OR (b) they have zero `student_documents` rows at
//      all yet ("Documents Pending" stand-in — registered but paperwork
//      incomplete, regardless of age). A student who is neither recent nor
//      missing documents reads as fully settled ("Enrolled" stand-in) and
//      is left off this view — they still show up on the plain
//      `/academy/students` list.
//   3. Ordering: newest registrations first (most actionable for an
//      admissions worker), same as the plain list.
//   4. Each row additionally reports `hasDocuments` and `daysSinceRegistered`
//      so the UI can render a "Documents Pending" vs. "Recently applied"
//      badge per row — the "quick advance action per row" DESIGN.md asks
//      for has no real transition to perform without a stage column, so
//      the closest honest equivalent this item offers is a quick link into
//      the student's edit form (already `updateStudent`-backed) rather than
//      a fabricated stage-advance action that would silently do nothing
//      meaningful against the schema.
// Same permission gating as searchStudents (Master Permission Matrix has no
// separate row for "admissions" vs. "students" — one row covers both).
export const ADMISSIONS_RECENT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdmissionsRow extends StudentRecord {
  hasDocuments: boolean;
  daysSinceRegistered: number;
}

export interface AdmissionsViewResult {
  rows: AdmissionsRow[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export type GetAdmissionsViewResult =
  | {
      ok: true;
      data: AdmissionsViewResult;
      permissionLevel: AcademyPermissionLevel;
      canManage: boolean;
      membershipRole: AcademyRole;
    }
  | { ok: false; error: StudentActionError };

export async function getAdmissionsView(
  actorContext: AuthContext,
  filters: Pick<StudentSearchFilters, "branchId"> = {},
  pagination: StudentSearchPagination = {},
  now: Date = new Date(),
): Promise<GetAdmissionsViewResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canViewStudents(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const page = normalizePage(pagination.page);
  const pageSize = normalizePageSize(pagination.pageSize);
  const offset = (page - 1) * pageSize;

  const scope = await resolveScope(academyId, membershipRole, actorContext.userId, filters.branchId);
  if (scope.unreachable) {
    return {
      ok: true,
      data: { rows: [], page, pageSize, totalCount: 0 },
      permissionLevel,
      canManage: canManageStudents(permissionLevel),
      membershipRole,
    };
  }

  const recentCutoff = new Date(now.getTime() - ADMISSIONS_RECENT_WINDOW_DAYS * DAY_MS);

  const where = and(...scope.conditions, eq(students.status, "active"));

  // Left join + per-student document count, grouped, so "zero documents"
  // is computable in one query rather than N+1 lookups. The recency/
  // pending-onboarding decision itself (§ comment above) is then applied
  // in JS rather than SQL, and pagination is applied after that filter —
  // a deliberate simplicity tradeoff (documented, not an oversight): this
  // view's candidate set is already narrowed to one academy's (or one
  // branch's, for branch-limited roles) *active* students, which never
  // approaches a scale where an in-memory filter/paginate is a real
  // performance concern, and it avoids expressing "created_at >= X OR
  // document_count = 0" as a HAVING clause mixed with a plain WHERE
  // academy/branch/status scope.
  const rows = await db
    .select({
      student: students,
      documentCount: count(studentDocuments.id),
    })
    .from(students)
    .leftJoin(studentDocuments, eq(studentDocuments.studentId, students.id))
    .where(where)
    .groupBy(students.id)
    .orderBy(desc(students.createdAt));

  const filtered = rows.filter((row) => {
    const recentlyRegistered = row.student.createdAt >= recentCutoff;
    const hasDocuments = row.documentCount > 0;
    return recentlyRegistered || !hasDocuments;
  });

  const totalCount = filtered.length;
  const pageRows = filtered.slice(offset, offset + pageSize).map((row) => ({
    ...toRecord(row.student),
    hasDocuments: row.documentCount > 0,
    daysSinceRegistered: Math.floor(
      (now.getTime() - row.student.createdAt.getTime()) / DAY_MS,
    ),
  }));

  return {
    ok: true,
    data: { rows: pageRows, page, pageSize, totalCount },
    permissionLevel,
    canManage: canManageStudents(permissionLevel),
    membershipRole,
  };
}

/**
 * ---------------------------------------------------------------------
 * Permanent student deletion — narrow, eligibility-gated, distinct from
 * the archive/restore status toggle
 * ---------------------------------------------------------------------
 * Direct inbound FKs to `students` (lib/db/schema.ts): studentDocuments,
 * studentIdCards, batchEnrollments, examResults, studentCharges,
 * studentPayments, certificates. The last five are protected — PLAN.md's
 * no-hard-delete principle covers enrollment history, exam results, and
 * every financial/certificate record explicitly, so any row in any of
 * them (regardless of status — a withdrawn enrollment or a cancelled
 * certificate is still a real historical fact) blocks deletion outright.
 *
 * studentDocuments/studentIdCards are treated as safely disposable — they
 * carry no historical value beyond the student's own existence (same
 * judgment lib/academies/delete-academy.ts's own disposable-data list
 * already made for these exact two tables at the whole-academy scale).
 * They are deleted explicitly, by name, inside the same transaction —
 * never a blind cascade.
 */
export interface StudentDeletionEligibility {
  studentId: string;
  studentName: string;
  eligible: boolean;
  reasons: string[];
  enrollmentCount: number;
  examResultCount: number;
  chargeCount: number;
  paymentCount: number;
  certificateCount: number;
}

export type GetStudentDeletionEligibilityResult =
  | { ok: true; eligibility: StudentDeletionEligibility }
  | { ok: false; error: StudentActionError };

type StudentDependentCounts = {
  enrollmentCount: number;
  examResultCount: number;
  chargeCount: number;
  paymentCount: number;
  certificateCount: number;
};

/** Bulk per-student dependent counts, for the students list's Delete
 * button — five grouped queries for the whole visible page rather than
 * N+1 (bounded by page size, never the whole academy). */
async function countStudentDependentsBulk(studentIds: string[]): Promise<Map<string, StudentDependentCounts>> {
  if (studentIds.length === 0) return new Map();
  const [enrollmentRows, examResultRows, chargeRows, paymentRows, certificateRows] = await Promise.all([
    db.select({ studentId: batchEnrollments.studentId, count: sql<number>`count(*)::int` }).from(batchEnrollments).where(inArray(batchEnrollments.studentId, studentIds)).groupBy(batchEnrollments.studentId),
    db.select({ studentId: examResults.studentId, count: sql<number>`count(*)::int` }).from(examResults).where(inArray(examResults.studentId, studentIds)).groupBy(examResults.studentId),
    db.select({ studentId: studentCharges.studentId, count: sql<number>`count(*)::int` }).from(studentCharges).where(inArray(studentCharges.studentId, studentIds)).groupBy(studentCharges.studentId),
    db.select({ studentId: studentPayments.studentId, count: sql<number>`count(*)::int` }).from(studentPayments).where(inArray(studentPayments.studentId, studentIds)).groupBy(studentPayments.studentId),
    db.select({ studentId: certificates.studentId, count: sql<number>`count(*)::int` }).from(certificates).where(inArray(certificates.studentId, studentIds)).groupBy(certificates.studentId),
  ]);
  const enrollmentByStudent = new Map(enrollmentRows.map((r) => [r.studentId, r.count]));
  const examResultByStudent = new Map(examResultRows.map((r) => [r.studentId, r.count]));
  const chargeByStudent = new Map(chargeRows.map((r) => [r.studentId, r.count]));
  const paymentByStudent = new Map(paymentRows.map((r) => [r.studentId, r.count]));
  const certificateByStudent = new Map(certificateRows.map((r) => [r.studentId, r.count]));

  const result = new Map<string, StudentDependentCounts>();
  for (const studentId of studentIds) {
    result.set(studentId, {
      enrollmentCount: enrollmentByStudent.get(studentId) ?? 0,
      examResultCount: examResultByStudent.get(studentId) ?? 0,
      chargeCount: chargeByStudent.get(studentId) ?? 0,
      paymentCount: paymentByStudent.get(studentId) ?? 0,
      certificateCount: certificateByStudent.get(studentId) ?? 0,
    });
  }
  return result;
}

async function countStudentDependents(
  executor: DbClient,
  studentId: string,
): Promise<StudentDependentCounts> {
  const [[enrollmentRow], [examResultRow], [chargeRow], [paymentRow], [certificateRow]] = await Promise.all([
    executor.select({ count: sql<number>`count(*)::int` }).from(batchEnrollments).where(eq(batchEnrollments.studentId, studentId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(examResults).where(eq(examResults.studentId, studentId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(studentCharges).where(eq(studentCharges.studentId, studentId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(studentPayments).where(eq(studentPayments.studentId, studentId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(certificates).where(eq(certificates.studentId, studentId)),
  ]);
  return {
    enrollmentCount: enrollmentRow?.count ?? 0,
    examResultCount: examResultRow?.count ?? 0,
    chargeCount: chargeRow?.count ?? 0,
    paymentCount: paymentRow?.count ?? 0,
    certificateCount: certificateRow?.count ?? 0,
  };
}

function buildStudentDeletionReasons(counts: {
  enrollmentCount: number;
  examResultCount: number;
  chargeCount: number;
  paymentCount: number;
  certificateCount: number;
}): string[] {
  const reasons: string[] = [];
  if (counts.enrollmentCount > 0) {
    reasons.push(`${counts.enrollmentCount} batch enrollment${counts.enrollmentCount === 1 ? "" : "s"}`);
  }
  if (counts.examResultCount > 0) {
    reasons.push(`${counts.examResultCount} exam result${counts.examResultCount === 1 ? "" : "s"}`);
  }
  if (counts.chargeCount > 0) {
    reasons.push(`${counts.chargeCount} charge${counts.chargeCount === 1 ? "" : "s"}`);
  }
  if (counts.paymentCount > 0) {
    reasons.push(`${counts.paymentCount} payment${counts.paymentCount === 1 ? "" : "s"}`);
  }
  if (counts.certificateCount > 0) {
    reasons.push(`${counts.certificateCount} certificate${counts.certificateCount === 1 ? "" : "s"}`);
  }
  return reasons;
}

/** Read-only preview for the UI's Delete button — `deleteStudent` below
 * re-runs the identical check itself, inside the deletion transaction, as
 * the actual authority. */
export async function getStudentDeletionEligibility(
  actorContext: AuthContext,
  studentId: string,
): Promise<GetStudentDeletionEligibilityResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canDeleteStudent(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [student] = await db
    .select({ id: students.id, fullName: students.fullName })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.academyId, academyId)))
    .limit(1);
  if (!student) {
    return { ok: false, error: NOT_FOUND };
  }

  const counts = await countStudentDependents(db, student.id);
  const reasons = buildStudentDeletionReasons(counts);

  return {
    ok: true,
    eligibility: {
      studentId: student.id,
      studentName: student.fullName,
      eligible: reasons.length === 0,
      reasons,
      ...counts,
    },
  };
}

export type DeleteStudentResult =
  | { ok: true; studentId: string }
  | { ok: false; error: StudentActionError };

/**
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — an enrollment or payment could be
 * recorded between the UI's preview and this call, and this is the check
 * that actually decides whether the delete proceeds. Audited before the
 * row is removed, same convention as deleteAcademy/deleteExam/
 * deleteProgram/deleteCourse/deleteBatch. No branch-scoping check is
 * needed here (see `canDeleteStudent`'s own comment) — every role that
 * ever reaches this point is academy-wide, never branch-limited.
 */
export async function deleteStudent(
  actorContext: AuthContext,
  studentId: string,
  confirmedName: string,
): Promise<DeleteStudentResult> {
  const resolved = await resolveStudentAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canDeleteStudent(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(studentId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.academyId, academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: NOT_FOUND };
    }

    // Re-checked against the row's CURRENT full name, under the same
    // lock — never trusts a name the caller fetched earlier via the
    // eligibility preview, same convention as
    // lib/academies/delete-academy.ts's deleteAcademy.
    if (confirmedName !== existing.fullName) {
      return {
        ok: false,
        error: { code: "validation", message: "Type the exact student name to confirm permanent deletion." },
      };
    }

    const counts = await countStudentDependents(tx, existing.id);
    const reasons = buildStudentDeletionReasons(counts);
    if (reasons.length > 0) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: `This student cannot be permanently deleted because academic or financial history exists (${reasons.join(", ")}). Archive the student instead.`,
        },
      };
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteStudent",
        entityType: "student",
        entityId: studentId,
        branchId: existing.branchId,
        before: toRecord(existing),
      },
      tx,
    );

    // Disposable dependent data only — guaranteed by the eligibility check
    // above that no enrollment/result/charge/payment/certificate exists.
    await tx.delete(studentDocuments).where(eq(studentDocuments.studentId, studentId));
    await tx.delete(studentIdCards).where(eq(studentIdCards.studentId, studentId));
    await tx.delete(students).where(eq(students.id, studentId));

    return { ok: true, studentId };
  });
}
