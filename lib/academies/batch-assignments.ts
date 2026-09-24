import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  certificates,
  courses,
  examResults,
  staffBranchAssignments,
  staffProfiles,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_COURSES_BATCHES_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 3, Item 44 — "`batch_trainer_assignments` + `batch_enrollments`
 * + trainer-scoped access checks" / §4's `assignTrainerToBatch` and
 * `enrollStudentInBatch`.
 *
 * ---------------------------------------------------------------------
 * Permission row: reused, not new
 * ---------------------------------------------------------------------
 * The Master Permission Matrix has exactly one row covering this area —
 * "Courses / batches": Full(owner)/Full(admin)/Manage(manager)/
 * View(admissions_officer)/—(finance_officer)/"Manage assigned"(trainer).
 * No distinct "trainer assignment" or "enrollment" row exists anywhere in
 * PLAN.md's matrix or DESIGN.md — trainer-to-batch assignment and
 * student-to-batch enrollment are both actions performed *on* a batch, so
 * they fall under the same capability lib/academies/batches.ts (Item 43)
 * already gates with (`ACADEMY_COURSES_BATCHES_ACTION`,
 * `"academy.courses_batches"`). No new row is added to
 * lib/auth/academy-permissions.ts for this item — "no duplicate permission
 * patterns," per this item's own brief.
 *
 * ---------------------------------------------------------------------
 * Branch scoping — same join pattern as batches.ts, duplicated per file
 * ---------------------------------------------------------------------
 * A batch carries a real `branch_id`; both new tables are keyed off a
 * `batch_id`, so the same branch-scoped/tenant-scoped IDOR pattern applies:
 * join the caller's staff_profiles row to staff_branch_assignments to get
 * their assigned branch_ids, then require the *batch's* branch to be in
 * that set for the two branch-limited roles (Admissions Officer, Trainer).
 * Admissions Officer's level here is "view" (never reaches `canManage`), so
 * in practice only Trainer's branch-limited writes ever need this check —
 * Admissions Officer is refused before the branch check is even reached.
 *
 * ---------------------------------------------------------------------
 * batch_trainer_assignments: plain unique, reactivate-in-place
 * ---------------------------------------------------------------------
 * The `(batch_id, staff_profile_id)` unique index is NOT partial (see
 * lib/db/schema.ts's comment on this table) — PLAN.md gives this table no
 * "for active" qualifier the way it explicitly does for batch_enrollments.
 * So `assignTrainerToBatch` looks up any existing row for the pair first:
 * a "removed" row is reactivated in place (status -> "active", a fresh
 * `assigned_at`), never a second inserted row; only an already-"active" row
 * is a genuine conflict.
 *
 * ---------------------------------------------------------------------
 * batch_enrollments: partial unique, fresh row per enrollment
 * ---------------------------------------------------------------------
 * The partial unique index (WHERE status = 'active') means a withdrawn
 * enrollment is history, not a live constraint — `enrollStudentInBatch`
 * always inserts a fresh row (blocked only by an existing *active* row for
 * the same student+batch), and `withdrawStudentFromBatch` flips the
 * existing active row to "withdrawn" rather than deleting it. Re-enrollment
 * after a withdrawal is therefore a brand new row with its own
 * `enrolled_at`, preserving the full enrollment history — no hard delete
 * anywhere, consistent with this codebase's project-wide convention.
 *
 * ---------------------------------------------------------------------
 * Cross-academy integrity check (enrollStudentInBatch)
 * ---------------------------------------------------------------------
 * Per this item's brief: "verify the student and batch belong to the same
 * academy (same integrity-check pattern as lib/subscriptions/payments.ts's
 * subscriptionId/academyId cross-check)." The batch is already scoped by
 * the caller's academyId via the normal query, but the student is looked
 * up by id alone first and its academyId is then compared explicitly —
 * mirroring recordSubscriptionPayment's "fetch the referenced row, then
 * compare its own academyId field to the expected one" shape, rather than
 * relying solely on both queries happening to be scoped by the same
 * variable. A mismatch (or a student that doesn't exist at all) returns
 * the identical generic "not found" — never a distinguishing message that
 * would confirm a given studentId exists in some other academy.
 *
 * ---------------------------------------------------------------------
 * getAssignedBatchIds — forward-looking export for Item 48
 * ---------------------------------------------------------------------
 * Item 48 (exam mark-entry scoping, a later wave) needs "which batches is
 * this trainer assigned to" to restrict `enterMarks` to a trainer's own
 * batches. That join (staff_profiles by userId+academyId -> active
 * batch_trainer_assignments rows) is built here, once, as a plain exported
 * function so Item 48 can import it directly rather than re-deriving the
 * same join. It is also used within this item itself (see
 * `listMyAssignedBatches` below) for the "a Trainer viewing their batches"
 * convenience view — the one place in this item's own scope where "batches
 * I'm assigned to teach" (via batch_trainer_assignments) is a meaningfully
 * different, narrower set than "batches in my assigned branch(es)" (via
 * staff_branch_assignments, the set every other branch-limited check in
 * this file uses).
 */
const BRANCH_LIMITED_ROLES: ReadonlySet<AcademyRole> = new Set([
  "admissions_officer",
  "trainer",
]);

function isBranchLimited(role: AcademyRole): boolean {
  return BRANCH_LIMITED_ROLES.has(role);
}

function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/** Stricter than `canManage`/withdraw: Trainer holds "manage" on this
 * action for their own assigned batches, but permanent deletion is
 * deliberately narrower than the reversible withdraw action — only
 * Owner/Admin/Manager (the three academy-wide roles) may ever delete an
 * enrollment, matching the same restriction already applied to Programs/
 * Courses/Batches/Students/Staff. */
function canDeleteEnrollment(role: AcademyRole, level: AcademyPermissionLevel): boolean {
  return canManage(level) && role !== "trainer";
}

export interface BatchAssignmentActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_transition" | "ineligible";
  message: string;
}

const FORBIDDEN: BatchAssignmentActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this batch's trainers or enrollments.",
};

// Same generic-message IDOR-safety convention as batches.ts's NOT_FOUND:
// nonexistent, cross-academy, and unassigned-for-a-branch-limited-caller
// all indistinguishable, including for a guessed id.
const BATCH_NOT_FOUND: BatchAssignmentActionError = {
  code: "not_found",
  message: "Batch not found.",
};

const STAFF_NOT_FOUND: BatchAssignmentActionError = {
  code: "not_found",
  message: "Staff member not found.",
};

const STUDENT_NOT_FOUND: BatchAssignmentActionError = {
  code: "not_found",
  message: "Student not found.",
};

const ASSIGNMENT_NOT_FOUND: BatchAssignmentActionError = {
  code: "not_found",
  message: "Trainer assignment not found.",
};

const ENROLLMENT_NOT_FOUND: BatchAssignmentActionError = {
  code: "not_found",
  message: "Enrollment not found.",
};

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

/** Same join pattern as lib/academies/batches.ts's private
 * `getAssignedBranchIds` (each academy-scoped action file keeps its own
 * copy, per that file's own documented convention). */
async function getAssignedBranchIds(
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

/**
 * The forward-looking, exported helper — see this file's module comment.
 * Resolves the caller's staff_profiles row (by userId+academyId) and joins
 * it to active batch_trainer_assignments rows. A caller with no
 * staff_profiles row, or a profile with zero active assignments, is
 * assigned to nothing — an empty list, not an error.
 *
 * Signature: `getAssignedBatchIds(executor, userId, academyId)` — import
 * this directly (do not re-derive the join) for any future "which batches
 * can this trainer act on" check, e.g. Item 48's `enterMarks` scoping.
 */
export async function getAssignedBatchIds(
  executor: DbClient,
  userId: string,
  academyId: string,
): Promise<string[]> {
  const [profile] = await executor
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)))
    .limit(1);
  if (!profile) return [];

  const rows = await executor
    .select({ batchId: batchTrainerAssignments.batchId })
    .from(batchTrainerAssignments)
    .where(
      and(
        eq(batchTrainerAssignments.staffProfileId, profile.id),
        eq(batchTrainerAssignments.status, "active"),
      ),
    );

  return rows.map((row) => row.batchId);
}

interface ResolvedScopeAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveScopeAccessResult =
  | { ok: true; access: ResolvedScopeAccess }
  | { ok: false; error: BatchAssignmentActionError };

async function resolveScopeAccess(actorContext: AuthContext): Promise<ResolveScopeAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_COURSES_BATCHES_ACTION,
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

/** Fetches a batch scoped to the caller's academy, then (for branch-limited
 * roles) verifies its branch is one the caller is assigned to. Returns null
 * for "not found for any reason" — nonexistent, cross-academy, or
 * out-of-scope-branch — never distinguishing between them. */
async function getScopedBatch(
  executor: DbClient,
  academyId: string,
  membershipRole: AcademyRole,
  userId: string,
  batchId: string,
): Promise<typeof batches.$inferSelect | null> {
  const [row] = await executor
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!row) return null;

  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(executor, academyId, userId);
    if (!assignedIds.includes(row.branchId)) return null;
  }

  return row;
}

// ===========================================================================
// Trainer assignments
// ===========================================================================

export const assignTrainerSchema = z.object({
  batchId: z.string().uuid("Select a batch"),
  staffProfileId: z.string().uuid("Select a staff member"),
});

export type AssignTrainerInput = z.input<typeof assignTrainerSchema>;

export interface BatchTrainerAssignmentRecord {
  id: string;
  academyId: string;
  batchId: string;
  staffProfileId: string;
  assignedAt: Date;
  status: "active" | "removed";
  createdAt: Date;
}

function toAssignmentRecord(
  row: typeof batchTrainerAssignments.$inferSelect,
): BatchTrainerAssignmentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    batchId: row.batchId,
    staffProfileId: row.staffProfileId,
    assignedAt: row.assignedAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export type AssignTrainerResult =
  | { ok: true; assignment: BatchTrainerAssignmentRecord }
  | { ok: false; error: BatchAssignmentActionError };

/**
 * PLAN.md §4: `assignTrainerToBatch`. Only "full"/"manage" may assign —
 * Admissions Officer's "view" is refused here even though it can read
 * batches. Trainer (branch-limited, "manage") may only assign into a batch
 * within their own assigned branch(es) — see `getScopedBatch` above.
 */
export async function assignTrainerToBatch(
  actorContext: AuthContext,
  input: AssignTrainerInput,
): Promise<AssignTrainerResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = assignTrainerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const batch = await getScopedBatch(
        tx,
        academyId,
        membershipRole,
        actorContext.userId,
        data.batchId,
      );
      if (!batch) {
        return { outcome: "batch_not_found" as const };
      }

      const [staffProfile] = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .where(
          and(
            eq(staffProfiles.id, data.staffProfileId),
            eq(staffProfiles.academyId, academyId),
          ),
        )
        .limit(1);
      if (!staffProfile) {
        return { outcome: "staff_not_found" as const };
      }

      const [existing] = await tx
        .select()
        .from(batchTrainerAssignments)
        .where(
          and(
            eq(batchTrainerAssignments.batchId, data.batchId),
            eq(batchTrainerAssignments.staffProfileId, data.staffProfileId),
          ),
        )
        .for("update");

      if (existing?.status === "active") {
        return { outcome: "conflict" as const };
      }

      let row: typeof batchTrainerAssignments.$inferSelect;
      if (existing) {
        // Reactivate the previously-removed row in place — see this file's
        // module comment on why this table's unique index is plain, not
        // partial.
        [row] = await tx
          .update(batchTrainerAssignments)
          .set({ status: "active", assignedAt: new Date() })
          .where(eq(batchTrainerAssignments.id, existing.id))
          .returning();
      } else {
        [row] = await tx
          .insert(batchTrainerAssignments)
          .values({
            academyId,
            batchId: data.batchId,
            staffProfileId: data.staffProfileId,
          })
          .returning();
      }

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "assignTrainerToBatch",
          entityType: "batch_trainer_assignment",
          entityId: row.id,
          branchId: batch.branchId,
          before: existing ? { status: existing.status } : undefined,
          after: toAssignmentRecord(row),
        },
        tx,
      );

      return { outcome: "ok" as const, row };
    });

    if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
    if (result.outcome === "staff_not_found") return { ok: false, error: STAFF_NOT_FOUND };
    if (result.outcome === "conflict") {
      return {
        ok: false,
        error: { code: "conflict", message: "This staff member is already assigned to this batch." },
      };
    }
    return { ok: true, assignment: toAssignmentRecord(result.row) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "This staff member is already assigned to this batch." },
      };
    }
    throw err;
  }
}

export type UnassignTrainerResult =
  | { ok: true; assignment: BatchTrainerAssignmentRecord }
  | { ok: false; error: BatchAssignmentActionError };

/** No hard delete — status = "removed" is the only removal path. A
 * branch-limited caller may only unassign within their own assigned
 * branch(es); an out-of-scope assignment id returns the identical
 * ASSIGNMENT_NOT_FOUND. */
export async function unassignTrainerFromBatch(
  actorContext: AuthContext,
  assignmentId: string,
): Promise<UnassignTrainerResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(assignmentId);
  if (!parsedId.success) {
    return { ok: false, error: ASSIGNMENT_NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ assignment: batchTrainerAssignments, branchId: batches.branchId })
      .from(batchTrainerAssignments)
      .innerJoin(batches, eq(batches.id, batchTrainerAssignments.batchId))
      .where(
        and(
          eq(batchTrainerAssignments.id, assignmentId),
          eq(batchTrainerAssignments.academyId, academyId),
        ),
      )
      .for("update");
    if (!existing) return { outcome: "not_found" as const };

    if (isBranchLimited(membershipRole)) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { outcome: "not_found" as const };
      }
    }

    if (existing.assignment.status !== "active") {
      return { outcome: "already_removed" as const };
    }

    const [updated] = await tx
      .update(batchTrainerAssignments)
      .set({ status: "removed" })
      .where(eq(batchTrainerAssignments.id, assignmentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "unassignTrainerFromBatch",
        entityType: "batch_trainer_assignment",
        entityId: assignmentId,
        branchId: existing.branchId,
        before: { status: existing.assignment.status },
        after: { status: "removed" },
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  });

  if (result.outcome === "not_found") return { ok: false, error: ASSIGNMENT_NOT_FOUND };
  if (result.outcome === "already_removed") {
    return {
      ok: false,
      error: { code: "invalid_transition", message: "This trainer assignment has already been removed." },
    };
  }
  return { ok: true, assignment: toAssignmentRecord(result.row) };
}

export interface BatchTrainerAssignmentRosterRow extends BatchTrainerAssignmentRecord {
  staffFullName: string;
}

export type ListBatchTrainerAssignmentsResult =
  | { ok: true; assignments: BatchTrainerAssignmentRosterRow[]; canManage: boolean }
  | { ok: false; error: BatchAssignmentActionError };

/** Roster read: every trainer assignment (active and removed, for a full
 * history view) for one batch, scoped the same way getBatch is. Joined to
 * staff_profiles for a display name — UI-only convenience, not used by any
 * authorization decision. */
export async function listBatchTrainerAssignments(
  actorContext: AuthContext,
  batchId: string,
): Promise<ListBatchTrainerAssignmentsResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };

  const batch = await getScopedBatch(db, academyId, membershipRole, actorContext.userId, batchId);
  if (!batch) return { ok: false, error: BATCH_NOT_FOUND };

  const rows = await db
    .select({
      assignment: batchTrainerAssignments,
      staffFullName: staffProfiles.fullName,
    })
    .from(batchTrainerAssignments)
    .innerJoin(staffProfiles, eq(staffProfiles.id, batchTrainerAssignments.staffProfileId))
    .where(eq(batchTrainerAssignments.batchId, batchId));

  return {
    ok: true,
    assignments: rows.map((row) => ({
      ...toAssignmentRecord(row.assignment),
      staffFullName: row.staffFullName,
    })),
    canManage: canManage(permissionLevel),
  };
}

// ===========================================================================
// Student enrollments
// ===========================================================================

export const enrollStudentSchema = z.object({
  batchId: z.string().uuid("Select a batch"),
  studentId: z.string().uuid("Select a student"),
});

export type EnrollStudentInput = z.input<typeof enrollStudentSchema>;

export interface BatchEnrollmentRecord {
  id: string;
  academyId: string;
  batchId: string;
  studentId: string;
  enrolledAt: Date;
  status: "active" | "withdrawn" | "completed";
  createdAt: Date;
}

function toEnrollmentRecord(row: typeof batchEnrollments.$inferSelect): BatchEnrollmentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    batchId: row.batchId,
    studentId: row.studentId,
    enrolledAt: row.enrolledAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export type EnrollStudentResult =
  | { ok: true; enrollment: BatchEnrollmentRecord }
  | { ok: false; error: BatchAssignmentActionError };

/**
 * PLAN.md §4: `enrollStudentInBatch`. Only "full"/"manage" may enroll.
 * Defensively verifies the student belongs to the same academy as the
 * batch — see this file's module comment on the cross-academy integrity
 * check (payments.ts's subscriptionId/academyId cross-check pattern).
 */
export async function enrollStudentInBatch(
  actorContext: AuthContext,
  input: EnrollStudentInput,
): Promise<EnrollStudentResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = enrollStudentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const batch = await getScopedBatch(
        tx,
        academyId,
        membershipRole,
        actorContext.userId,
        data.batchId,
      );
      if (!batch) {
        return { outcome: "batch_not_found" as const };
      }

      // Cross-academy integrity check: fetch the student by id alone, then
      // compare its own academyId to the batch's — same shape as
      // recordSubscriptionPayment's subscriptionId/academyId cross-check
      // (lib/subscriptions/payments.ts), rather than folding the academyId
      // into the WHERE clause and letting a mismatch silently look like
      // "student doesn't exist."
      const [student] = await tx
        .select({ id: students.id, academyId: students.academyId })
        .from(students)
        .where(eq(students.id, data.studentId))
        .limit(1);
      if (!student || student.academyId !== academyId) {
        return { outcome: "student_not_found" as const };
      }

      const [existingActive] = await tx
        .select({ id: batchEnrollments.id })
        .from(batchEnrollments)
        .where(
          and(
            eq(batchEnrollments.batchId, data.batchId),
            eq(batchEnrollments.studentId, data.studentId),
            eq(batchEnrollments.status, "active"),
          ),
        )
        .for("update");
      if (existingActive) {
        return { outcome: "conflict" as const };
      }

      const [row] = await tx
        .insert(batchEnrollments)
        .values({
          academyId,
          batchId: data.batchId,
          studentId: data.studentId,
        })
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "enrollStudentInBatch",
          entityType: "batch_enrollment",
          entityId: row.id,
          branchId: batch.branchId,
          after: toEnrollmentRecord(row),
        },
        tx,
      );

      return { outcome: "ok" as const, row };
    });

    if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
    if (result.outcome === "student_not_found") return { ok: false, error: STUDENT_NOT_FOUND };
    if (result.outcome === "conflict") {
      return {
        ok: false,
        error: { code: "conflict", message: "This student is already actively enrolled in this batch." },
      };
    }
    return { ok: true, enrollment: toEnrollmentRecord(result.row) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "This student is already actively enrolled in this batch." },
      };
    }
    throw err;
  }
}

export type WithdrawStudentResult =
  | { ok: true; enrollment: BatchEnrollmentRecord }
  | { ok: false; error: BatchAssignmentActionError };

/** No hard delete — status = "withdrawn" is the only removal path for an
 * active enrollment; re-enrollment afterward inserts a fresh row (see this
 * file's module comment on the partial unique index). Branch-limited
 * callers may only withdraw within their own assigned branch(es). */
export async function withdrawStudentFromBatch(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<WithdrawStudentResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) {
    return { ok: false, error: ENROLLMENT_NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ enrollment: batchEnrollments, branchId: batches.branchId })
      .from(batchEnrollments)
      .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
      .where(
        and(eq(batchEnrollments.id, enrollmentId), eq(batchEnrollments.academyId, academyId)),
      )
      .for("update");
    if (!existing) return { outcome: "not_found" as const };

    if (isBranchLimited(membershipRole)) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { outcome: "not_found" as const };
      }
    }

    if (existing.enrollment.status !== "active") {
      return { outcome: "invalid_transition" as const, status: existing.enrollment.status };
    }

    const [updated] = await tx
      .update(batchEnrollments)
      .set({ status: "withdrawn" })
      .where(eq(batchEnrollments.id, enrollmentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "withdrawStudentFromBatch",
        entityType: "batch_enrollment",
        entityId: enrollmentId,
        branchId: existing.branchId,
        before: { status: existing.enrollment.status },
        after: { status: "withdrawn" },
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  });

  if (result.outcome === "not_found") return { ok: false, error: ENROLLMENT_NOT_FOUND };
  if (result.outcome === "invalid_transition") {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `This enrollment is already ${result.status} — it can no longer be withdrawn.`,
      },
    };
  }
  return { ok: true, enrollment: toEnrollmentRecord(result.row) };
}

/**
 * ---------------------------------------------------------------------
 * Permanent enrollment deletion — narrow, eligibility-gated, distinct
 * from withdrawStudentFromBatch
 * ---------------------------------------------------------------------
 * `batch_enrollments.id` has no inbound FK anywhere in the schema (grep
 * confirmed), so deleting a row can never violate a foreign key — but
 * `exam_results` and `certificates` both carry the same (student_id,
 * batch_id) pair independently (denormalized, not FK-linked to the
 * enrollment row itself), so a student's real academic participation in a
 * batch can still be reachable even after the enrollment row that
 * recorded it is gone. Deletion is refused whenever either exists for
 * this exact (student_id, batch_id) pair — the same "zero protected
 * history" boundary this codebase's other five entity-delete functions
 * already use, applied here at the (student, batch) granularity instead
 * of a single owning row. Eligible regardless of the enrollment's own
 * status (active/withdrawn/completed) — unlike withdraw, which only ever
 * applies to an active row, delete is about permanently erasing a
 * mistaken/test record, not about ending a real one.
 */
export interface EnrollmentDeletionEligibility {
  enrollmentId: string;
  eligible: boolean;
  reasons: string[];
  examResultCount: number;
  certificateCount: number;
}

export type GetEnrollmentDeletionEligibilityResult =
  | { ok: true; eligibility: EnrollmentDeletionEligibility }
  | { ok: false; error: BatchAssignmentActionError };

async function countEnrollmentHistory(
  executor: DbClient,
  studentId: string,
  batchId: string,
): Promise<{ examResultCount: number; certificateCount: number }> {
  const [[examResultRow], [certificateRow]] = await Promise.all([
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(examResults)
      .where(and(eq(examResults.studentId, studentId), eq(examResults.batchId, batchId))),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(certificates)
      .where(and(eq(certificates.studentId, studentId), eq(certificates.batchId, batchId))),
  ]);
  return {
    examResultCount: examResultRow?.count ?? 0,
    certificateCount: certificateRow?.count ?? 0,
  };
}

function buildEnrollmentDeletionReasons(counts: { examResultCount: number; certificateCount: number }): string[] {
  const reasons: string[] = [];
  if (counts.examResultCount > 0) {
    reasons.push(`${counts.examResultCount} exam result${counts.examResultCount === 1 ? "" : "s"} exist for this student in this batch`);
  }
  if (counts.certificateCount > 0) {
    reasons.push(`${counts.certificateCount} certificate${counts.certificateCount === 1 ? "" : "s"} exist for this student in this batch`);
  }
  return reasons;
}

/** Read-only preview for the UI's Delete button — `deleteBatchEnrollment`
 * below re-runs the identical check itself, inside the deletion
 * transaction, as the actual authority. */
export async function getEnrollmentDeletionEligibility(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<GetEnrollmentDeletionEligibilityResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canDeleteEnrollment(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) {
    return { ok: false, error: ENROLLMENT_NOT_FOUND };
  }

  const [existing] = await db
    .select({ enrollment: batchEnrollments, branchId: batches.branchId })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .where(and(eq(batchEnrollments.id, enrollmentId), eq(batchEnrollments.academyId, academyId)))
    .limit(1);
  if (!existing) {
    return { ok: false, error: ENROLLMENT_NOT_FOUND };
  }
  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(existing.branchId)) {
      return { ok: false, error: ENROLLMENT_NOT_FOUND };
    }
  }

  const counts = await countEnrollmentHistory(db, existing.enrollment.studentId, existing.enrollment.batchId);
  const reasons = buildEnrollmentDeletionReasons(counts);

  return {
    ok: true,
    eligibility: { enrollmentId: existing.enrollment.id, eligible: reasons.length === 0, reasons, ...counts },
  };
}

export type DeleteEnrollmentResult =
  | { ok: true; enrollmentId: string }
  | { ok: false; error: BatchAssignmentActionError };

/**
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — a mark could be entered or a
 * certificate issued between the UI's preview and this call, and this is
 * the check that actually decides whether the delete proceeds. Audited
 * before the row is removed, same convention as this codebase's other
 * entity-delete functions.
 */
export async function deleteBatchEnrollment(
  actorContext: AuthContext,
  enrollmentId: string,
): Promise<DeleteEnrollmentResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canDeleteEnrollment(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) {
    return { ok: false, error: ENROLLMENT_NOT_FOUND };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ enrollment: batchEnrollments, branchId: batches.branchId })
      .from(batchEnrollments)
      .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
      .where(and(eq(batchEnrollments.id, enrollmentId), eq(batchEnrollments.academyId, academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: ENROLLMENT_NOT_FOUND };
    }
    if (isBranchLimited(membershipRole)) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { ok: false, error: ENROLLMENT_NOT_FOUND };
      }
    }

    const counts = await countEnrollmentHistory(tx, existing.enrollment.studentId, existing.enrollment.batchId);
    const reasons = buildEnrollmentDeletionReasons(counts);
    if (reasons.length > 0) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: `This enrollment cannot be permanently deleted because ${reasons.join(", ")}. Withdraw it instead.`,
        },
      };
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteBatchEnrollment",
        entityType: "batch_enrollment",
        entityId: enrollmentId,
        branchId: existing.branchId,
        before: toEnrollmentRecord(existing.enrollment),
      },
      tx,
    );

    await tx.delete(batchEnrollments).where(eq(batchEnrollments.id, enrollmentId));

    return { ok: true, enrollmentId };
  });
}

export interface BatchEnrollmentRosterRow extends BatchEnrollmentRecord {
  studentFullName: string;
  studentNumber: string;
}

export type ListBatchEnrollmentsResult =
  | {
      ok: true;
      enrollments: (BatchEnrollmentRosterRow & { deletionEligibility: { eligible: boolean; reasons: string[] } })[];
      canManage: boolean;
      /** Narrower than `canManage` — Trainer can withdraw within their own
       * assigned branch but must never see a Delete action at all
       * (permission-absent, not disabled — see `canDeleteEnrollment`). */
      canDelete: boolean;
    }
  | { ok: false; error: BatchAssignmentActionError };

/** Roster read: every enrollment (all statuses, for a full history view)
 * for one batch, scoped the same way getBatch is. Joined to students for a
 * display name/number — UI-only convenience, not used by any authorization
 * decision. Delete-eligibility is computed server-side here (one grouped
 * query for the whole roster, never per-row in the UI) and handed down as
 * plain data for the roster's Delete button to render. */
export async function listBatchEnrollments(
  actorContext: AuthContext,
  batchId: string,
): Promise<ListBatchEnrollmentsResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };

  const batch = await getScopedBatch(db, academyId, membershipRole, actorContext.userId, batchId);
  if (!batch) return { ok: false, error: BATCH_NOT_FOUND };

  const rows = await db
    .select({
      enrollment: batchEnrollments,
      studentFullName: students.fullName,
      studentNumber: students.studentNumber,
    })
    .from(batchEnrollments)
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .where(eq(batchEnrollments.batchId, batchId));

  const studentIds = rows.map((row) => row.enrollment.studentId);
  const [examResultRows, certificateRows] = studentIds.length
    ? await Promise.all([
        db
          .select({ studentId: examResults.studentId, count: sql<number>`count(*)::int` })
          .from(examResults)
          .where(and(eq(examResults.batchId, batchId), inArray(examResults.studentId, studentIds)))
          .groupBy(examResults.studentId),
        db
          .select({ studentId: certificates.studentId, count: sql<number>`count(*)::int` })
          .from(certificates)
          .where(and(eq(certificates.batchId, batchId), inArray(certificates.studentId, studentIds)))
          .groupBy(certificates.studentId),
      ])
    : [[], []];
  const examResultByStudent = new Map(examResultRows.map((r) => [r.studentId, r.count]));
  const certificateByStudent = new Map(certificateRows.map((r) => [r.studentId, r.count]));

  return {
    ok: true,
    enrollments: rows.map((row) => {
      const counts = {
        examResultCount: examResultByStudent.get(row.enrollment.studentId) ?? 0,
        certificateCount: certificateByStudent.get(row.enrollment.studentId) ?? 0,
      };
      const reasons = buildEnrollmentDeletionReasons(counts);
      return {
        ...toEnrollmentRecord(row.enrollment),
        studentFullName: row.studentFullName,
        studentNumber: row.studentNumber,
        deletionEligibility: { eligible: reasons.length === 0, reasons },
      };
    }),
    canManage: canManage(permissionLevel),
    canDelete: canDeleteEnrollment(membershipRole, permissionLevel),
  };
}

// ===========================================================================
// "Which batches is *this* trainer assigned to" convenience read
// ===========================================================================

export type ListMyAssignedBatchesResult =
  | { ok: true; batchIds: string[] }
  | { ok: false; error: BatchAssignmentActionError };

/**
 * The "within this item itself" use of `getAssignedBatchIds` called out in
 * this file's module comment: a Trainer viewing which batches they are
 * *actually* assigned to teach (via batch_trainer_assignments), a narrower
 * set than "every batch in my assigned branch(es)" (via
 * staff_branch_assignments — what `listBatches`/`getBatch` in batches.ts
 * scope by). Any role may call this; it simply returns an empty list for a
 * caller with no staff_profiles row or no active assignments.
 */
export async function listMyAssignedBatches(
  actorContext: AuthContext,
): Promise<ListMyAssignedBatchesResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const batchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
  return { ok: true, batchIds };
}

// ===========================================================================
// Simple course/enrollment model — display enrichment + single-course-at-a-
// time editing, both built entirely on the existing Student -> Batch ->
// Course relationship above (batch_enrollments + batches.course_id). No new
// table, no new relationship — see lib/academies/courses.ts's
// listCourseEnrollments for the course-centric counterpart of this same
// join, kept here instead since this direction (student -> their course(s))
// is naturally an enrollment-domain read.
// ===========================================================================

export interface StudentActiveCourse {
  batchId: string;
  batchName: string;
  courseName: string;
}

/**
 * Batch-fetches each given student's ACTIVE enrollment(s) (course + batch
 * name), for the `/academy/students` list's "Course" column. Not
 * separately access-gated — every caller today already resolved
 * `searchStudents`/`checkAcademyAccessForContext` before reaching this, and
 * it takes an academyId directly (not an AuthContext) purely as a display
 * enrichment, same shape as e.g. listBatchEnrollments's joined display
 * fields (studentFullName/studentNumber) being UI convenience, not their
 * own authorization decision.
 */
export async function getActiveCoursesForStudents(
  academyId: string,
  studentIds: string[],
): Promise<Map<string, StudentActiveCourse[]>> {
  const result = new Map<string, StudentActiveCourse[]>();
  if (studentIds.length === 0) return result;

  const rows = await db
    .select({
      studentId: batchEnrollments.studentId,
      batchId: batches.id,
      batchName: batches.name,
      courseName: courses.name,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(courses, eq(courses.id, batches.courseId))
    .where(
      and(
        eq(batchEnrollments.academyId, academyId),
        eq(batchEnrollments.status, "active"),
        inArray(batchEnrollments.studentId, studentIds),
      ),
    );

  for (const row of rows) {
    const existing = result.get(row.studentId) ?? [];
    existing.push({ batchId: row.batchId, batchName: row.batchName, courseName: row.courseName });
    result.set(row.studentId, existing);
  }
  return result;
}

export type UpdateStudentEnrollmentResult = { ok: true } | { ok: false; error: BatchAssignmentActionError };

/**
 * "Change this student's course" — the admin-facing edit action referenced
 * by PLAN's "update a student's enrollment if the existing system supports
 * editing students." Reuses `enrollStudentInBatch`/`withdrawStudentFromBatch`
 * unmodified: withdraws every currently-active enrollment for the student,
 * then (if a new batch was chosen) enrolls into it — plain orchestration of
 * two already-existing, already-tested actions, no new enrollment logic.
 * Passing an empty/undefined `newBatchId` just withdraws, leaving the
 * student with no active course (this action's own access/scope checks are
 * inherited entirely from the two functions it calls).
 */
export async function updateStudentEnrollment(
  actorContext: AuthContext,
  studentId: string,
  newBatchId: string | undefined,
): Promise<UpdateStudentEnrollmentResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedStudentId = z.string().uuid().safeParse(studentId);
  if (!parsedStudentId.success) return { ok: false, error: STUDENT_NOT_FOUND };

  const activeEnrollments = await db
    .select({ id: batchEnrollments.id, batchId: batchEnrollments.batchId })
    .from(batchEnrollments)
    .where(
      and(
        eq(batchEnrollments.studentId, studentId),
        eq(batchEnrollments.academyId, academyId),
        eq(batchEnrollments.status, "active"),
      ),
    );

  for (const enrollment of activeEnrollments) {
    if (enrollment.batchId === newBatchId) {
      // Already enrolled in the requested batch — nothing to change.
      return { ok: true };
    }
    const withdrawResult = await withdrawStudentFromBatch(actorContext, enrollment.id);
    if (!withdrawResult.ok) return withdrawResult;
  }

  if (!newBatchId) {
    return { ok: true };
  }

  const enrollResult = await enrollStudentInBatch(actorContext, { batchId: newBatchId, studentId });
  if (!enrollResult.ok) return enrollResult;

  return { ok: true };
}
