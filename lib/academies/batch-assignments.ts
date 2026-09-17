import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batchTrainerAssignments,
  batches,
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

export interface BatchAssignmentActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_transition";
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

export interface BatchEnrollmentRosterRow extends BatchEnrollmentRecord {
  studentFullName: string;
  studentNumber: string;
}

export type ListBatchEnrollmentsResult =
  | { ok: true; enrollments: BatchEnrollmentRosterRow[]; canManage: boolean }
  | { ok: false; error: BatchAssignmentActionError };

/** Roster read: every enrollment (all statuses, for a full history view)
 * for one batch, scoped the same way getBatch is. Joined to students for a
 * display name/number — UI-only convenience, not used by any authorization
 * decision. */
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

  return {
    ok: true,
    enrollments: rows.map((row) => ({
      ...toEnrollmentRecord(row.enrollment),
      studentFullName: row.studentFullName,
      studentNumber: row.studentNumber,
    })),
    canManage: canManage(permissionLevel),
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
