import { and, eq, inArray, sql } from "drizzle-orm";
import { getAssignedBranchIds } from "@/lib/academies/branch-access";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  auditLogs,
  batchCourses,
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  certificates,
  courses,
  enrollmentFeeSchedules,
  examResults,
  FEE_INTERVAL_MONTHS_OPTIONS,
  feePeriods,
  paymentAllocations,
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
import {
  createInitialEnrollmentFeeSchedule,
  generateFeePeriodsForEnrollment,
  resolveCurrency,
  todayDateOnlyInAcademyTimezone,
} from "@/lib/academies/fee-periods";
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
  academyWide: boolean;
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
      academyWide: access.academyWide,
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
  academyWide: boolean,
  userId: string,
  batchId: string,
): Promise<typeof batches.$inferSelect | null> {
  const [row] = await executor
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!row) return null;

  if (!academyWide) {
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

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
        academyWide,
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

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

    if (!academyWide) {
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
  const { academyId, permissionLevel, academyWide } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };

  const batch = await getScopedBatch(db, academyId, academyWide, actorContext.userId, batchId);
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

// z.union of literals (not z.number().refine) — see fee-periods.ts's
// identical intervalMonthsSchema for why; kept as its own copy here rather
// than imported, since this file authorizes and creates the schedule
// directly (see createInitialEnrollmentFeeSchedule's own module comment on
// why enrollment doesn't call into fee-periods.ts's permission-gated
// setEnrollmentFeeSchedule).
const enrollmentIntervalMonthsSchema = z.union(
  FEE_INTERVAL_MONTHS_OPTIONS.map((value) => z.literal(value)) as [
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
  { message: "Payment plan interval must be one of: 1, 2, 3, 4, 6, or 12 months." },
);

/**
 * A payment plan is a REQUIRED part of enrollment (approved architecture
 * decision: "There must never be a successful enrollment without its
 * required initial payment plan") — `amountCents`/`intervalMonths` are not
 * optional. `anchorDate` IS optional: it defaults to the enrollment
 * moment's own calendar date (see `enrollStudentInBatch` below) — the
 * first payment period always starts the day the student is actually
 * enrolled and is immediately due, regardless of when the batch itself
 * started. (An earlier revision defaulted this to the batch's own
 * `start_date` instead; that produced a first period dated weeks or months
 * in the future — "Upcoming, not yet due" — for a batch that hadn't
 * started yet, which is the exact bug this default now fixes. A caller may
 * still pass an explicit `anchorDate` to anchor elsewhere on purpose.)
 */
const paymentPlanSchema = z.object({
  intervalMonths: enrollmentIntervalMonthsSchema,
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD")
    .optional(),
  anchorDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "A valid start date is required")
    .optional(),
});

export type PaymentPlanInput = z.input<typeof paymentPlanSchema>;

export const enrollStudentSchema = z.object({
  batchId: z.string().uuid("Select a batch"),
  studentId: z.string().uuid("Select a student"),
  /** The batch courses to enroll in, each with its own enrollment and fee
   * plan. May be omitted only when the batch runs exactly one course. */
  courseIds: z
    .array(z.string().uuid("Select a course"))
    .optional()
    .transform((ids) => [...new Set(ids ?? [])]),
  /** Applied to each course: the total fee per course and its installments. */
  paymentPlan: paymentPlanSchema,
});

export type EnrollStudentInput = z.input<typeof enrollStudentSchema>;

export interface BatchEnrollmentRecord {
  id: string;
  academyId: string;
  batchId: string;
  /** The batch course this enrollment is for. */
  courseId: string;
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
    courseId: row.courseId,
    studentId: row.studentId,
    enrolledAt: row.enrolledAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export type EnrollStudentResult =
  /** `enrollment` is the first of `enrollments` (one per course). */
  | { ok: true; enrollment: BatchEnrollmentRecord; enrollments: BatchEnrollmentRecord[] }
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

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
        academyWide,
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

      // The courses must belong to this batch (validated here, and by the
      // (batch_id, course_id) foreign key). With no course named, a batch
      // that runs exactly one course enrolls in that course.
      const batchCourseRows = await tx
        .select({ courseId: batchCourses.courseId, name: courses.name })
        .from(batchCourses)
        .innerJoin(courses, eq(courses.id, batchCourses.courseId))
        .where(and(eq(batchCourses.batchId, data.batchId), eq(batchCourses.academyId, academyId)));
      const courseIds =
        data.courseIds.length > 0 ? data.courseIds : batchCourseRows.length === 1 ? [batchCourseRows[0].courseId] : [];
      if (courseIds.length === 0) {
        return { outcome: "course_required" as const };
      }
      const courseName = new Map(batchCourseRows.map((row) => [row.courseId, row.name]));
      if (courseIds.some((id) => !courseName.has(id))) {
        return { outcome: "course_not_in_batch" as const };
      }

      // One active enrollment per student, batch and course.
      const existingActive = await tx
        .select({ courseId: batchEnrollments.courseId })
        .from(batchEnrollments)
        .where(
          and(
            eq(batchEnrollments.batchId, data.batchId),
            eq(batchEnrollments.studentId, data.studentId),
            eq(batchEnrollments.status, "active"),
            inArray(batchEnrollments.courseId, courseIds),
          ),
        )
        .for("update");
      if (existingActive.length > 0) {
        return {
          outcome: "conflict" as const,
          courses: existingActive.map((row) => courseName.get(row.courseId) ?? "this course"),
        };
      }

      const currency = await resolveCurrency(tx, academyId, data.paymentPlan.currency);
      const created: (typeof batchEnrollments.$inferSelect)[] = [];
      for (const courseId of courseIds) {
        const [row] = await tx
          .insert(batchEnrollments)
          .values({
            academyId,
            batchId: data.batchId,
            courseId,
            studentId: data.studentId,
          })
          .returning();

        // Atomically create the enrollment's initial payment plan in the SAME
        // transaction — approved architecture decision: "There must never be
        // a successful enrollment without its required initial payment
        // plan." If any insert fails, the whole transaction (every course's
        // enrollment included) rolls back. This is a bare,
        // permission-agnostic insert — see
        // createInitialEnrollmentFeeSchedule's own module comment for why it
        // deliberately does NOT go through setEnrollmentFeeSchedule's
        // ACADEMY_FEE_PERIODS_ACTION gate: authorization for this step is
        // this file's own ACADEMY_COURSES_BATCHES_ACTION check above, already
        // passed. Each course gets its own schedule (fees are per course).
        const schedule = await createInitialEnrollmentFeeSchedule(tx, {
          academyId,
          enrollmentId: row.id,
          intervalMonths: data.paymentPlan.intervalMonths,
          amountCents: data.paymentPlan.amountCents,
          currency,
          // Defaults to today — Somalia-local calendar date, not the
          // server's own (likely UTC) timezone — see
          // todayDateOnlyInAcademyTimezone's own doc comment. The first fee
          // period is generated from this anchor immediately below.
          anchorDate: data.paymentPlan.anchorDate ?? todayDateOnlyInAcademyTimezone(),
          createdBy: actorContext.userId,
        });

        // Eagerly generate the first fee period so the enrollment's payment
        // summary already sees `expected > 0` right after commit — the real,
        // already-owed first period, never a fake payment.
        await generateFeePeriodsForEnrollment(tx, row.id, academyId);

        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: membershipRole,
            academyId,
            action: "enrollStudentInBatch",
            entityType: "batch_enrollment",
            entityId: row.id,
            branchId: batch.branchId,
            after: { ...toEnrollmentRecord(row), paymentPlan: { intervalMonths: schedule.intervalMonths, amountCents: schedule.amountCents, currency: schedule.currency, anchorDate: schedule.anchorDate } },
          },
          tx,
        );
        created.push(row);
      }

      return { outcome: "ok" as const, rows: created };
    });

    if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
    if (result.outcome === "student_not_found") return { ok: false, error: STUDENT_NOT_FOUND };
    if (result.outcome === "course_required") {
      return { ok: false, error: { code: "validation", message: "Pick at least one course from this batch." } };
    }
    if (result.outcome === "course_not_in_batch") {
      return { ok: false, error: { code: "validation", message: "That course isn't part of this batch." } };
    }
    if (result.outcome === "conflict") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `This student is already enrolled in ${result.courses.join(", ")} in this batch.`,
        },
      };
    }
    const enrollments = result.rows.map(toEnrollmentRecord);
    return { ok: true, enrollment: enrollments[0], enrollments };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "This student is already enrolled in that course in this batch." },
      };
    }
    throw err;
  }
}

export type WithdrawStudentResult =
  | { ok: true; enrollment: BatchEnrollmentRecord }
  | { ok: false; error: BatchAssignmentActionError };

/** The locked, verified enrollment handed to a withdrawal's in-transaction
 * step (see `withdrawStudentFromBatch`'s `withinTransaction`). */
export interface LockedWithdrawal {
  academyId: string;
  branchId: string;
  enrollmentId: string;
  studentId: string;
  membershipRole: AcademyRole;
}

/** Thrown inside the transaction to roll it back with a caller's error. */
class WithdrawStepRefused extends Error {
  constructor(readonly error: BatchAssignmentActionError) {
    super(error.message);
  }
}

/** No hard delete — status = "withdrawn" is the only removal path for an
 * active enrollment; re-enrollment afterward inserts a fresh row (see this
 * file's module comment on the partial unique index). Branch-limited
 * callers may only withdraw within their own assigned branch(es). */
export async function withdrawStudentFromBatch(
  actorContext: AuthContext,
  enrollmentId: string,
  /** Why the student left (design A02 withdraw dialog). Optional here —
   * the batch roster withdraws without one — and stored only in the audit
   * entry's context, so no schema change. */
  options: {
    reason?: string;
    /** Runs inside the withdrawal's own transaction, after the enrollment
     * row is locked and checked (academy, branch, still active) and before
     * it is set to withdrawn. Returning an error rolls the whole withdrawal
     * back — used by withdraw-with-refund (lib/academies/course-refunds.ts)
     * so the refund and the withdrawal commit together or not at all. */
    withinTransaction?: (tx: DbClient, locked: LockedWithdrawal) => Promise<BatchAssignmentActionError | null>;
  } = {},
): Promise<WithdrawStudentResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(enrollmentId);
  if (!parsedId.success) {
    return { ok: false, error: ENROLLMENT_NOT_FOUND };
  }
  const reason = options.reason?.trim() || undefined;
  if (reason && reason.length > WITHDRAW_REASON_MAX) {
    return {
      ok: false,
      error: { code: "validation", message: `Keep the reason under ${WITHDRAW_REASON_MAX} characters.` },
    };
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

    if (!academyWide) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { outcome: "not_found" as const };
      }
    }

    if (existing.enrollment.status !== "active") {
      return { outcome: "invalid_transition" as const, status: existing.enrollment.status };
    }

    if (options.withinTransaction) {
      const refused = await options.withinTransaction(tx, {
        academyId,
        branchId: existing.branchId,
        enrollmentId,
        studentId: existing.enrollment.studentId,
        membershipRole,
      });
      if (refused) throw new WithdrawStepRefused(refused);
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
        ...(reason ? { context: { reason } } : {}),
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  }).catch((error: unknown) => {
    if (error instanceof WithdrawStepRefused) return { outcome: "refused" as const, error: error.error };
    throw error;
  });

  if (result.outcome === "refused") return { ok: false, error: result.error };
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

export const WITHDRAW_REASON_MAX = 500;

export interface EnrollmentWithdrawal {
  /** When the enrollment was withdrawn (the withdraw audit entry's time). */
  withdrawnAt: Date;
  /** The reason given, when one was recorded. */
  reason: string | null;
}

/**
 * When, and why, each of these enrollments was withdrawn — read from the
 * `withdrawStudentFromBatch` audit entries, since `batch_enrollments` has
 * no withdrawn-at or reason column. Scoped to the caller's academy; ids the
 * academy has no withdraw entry for (completed enrollments, or withdrawals
 * that predate audit logging) are simply absent from the map.
 */
export async function listEnrollmentWithdrawals(
  actorContext: AuthContext,
  enrollmentIds: string[],
): Promise<Map<string, EnrollmentWithdrawal>> {
  const ids = enrollmentIds.filter((id) => z.string().uuid().safeParse(id).success);
  if (ids.length === 0) return new Map();
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return new Map();

  const rows = await db
    .select({ entityId: auditLogs.entityId, createdAt: auditLogs.createdAt, context: auditLogs.context })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.academyId, resolved.access.academyId),
        eq(auditLogs.entityType, "batch_enrollment"),
        eq(auditLogs.action, "withdrawStudentFromBatch"),
        inArray(auditLogs.entityId, ids),
      ),
    )
    .orderBy(auditLogs.createdAt);

  const byEnrollment = new Map<string, EnrollmentWithdrawal>();
  for (const row of rows) {
    if (!row.entityId) continue;
    const context = row.context as { reason?: unknown } | null;
    // The latest entry wins (an enrollment is withdrawn at most once).
    byEnrollment.set(row.entityId, {
      withdrawnAt: row.createdAt,
      reason: typeof context?.reason === "string" ? context.reason : null,
    });
  }
  return byEnrollment;
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
  paymentActivityCount: number;
}

export type GetEnrollmentDeletionEligibilityResult =
  | { ok: true; eligibility: EnrollmentDeletionEligibility }
  | { ok: false; error: BatchAssignmentActionError };

async function countEnrollmentHistory(
  executor: DbClient,
  studentId: string,
  batchId: string,
  enrollmentId: string,
): Promise<{ examResultCount: number; certificateCount: number; paymentActivityCount: number }> {
  const [[examResultRow], [certificateRow], [paymentRow]] = await Promise.all([
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(examResults)
      .where(and(eq(examResults.studentId, studentId), eq(examResults.batchId, batchId))),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(certificates)
      .where(and(eq(certificates.studentId, studentId), eq(certificates.batchId, batchId))),
    // Financial-history safety (approved architecture: "never destroy
    // historical financial records"): a fee-period payment allocated
    // against this enrollment blocks permanent deletion, same as an exam
    // result or certificate does — withdraw instead, never delete.
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentAllocations)
      .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
      .where(eq(feePeriods.enrollmentId, enrollmentId)),
  ]);
  return {
    examResultCount: examResultRow?.count ?? 0,
    certificateCount: certificateRow?.count ?? 0,
    paymentActivityCount: paymentRow?.count ?? 0,
  };
}

function buildEnrollmentDeletionReasons(counts: {
  examResultCount: number;
  certificateCount: number;
  paymentActivityCount: number;
}): string[] {
  const reasons: string[] = [];
  if (counts.examResultCount > 0) {
    reasons.push(`${counts.examResultCount} exam result${counts.examResultCount === 1 ? "" : "s"} exist for this student in this batch`);
  }
  if (counts.certificateCount > 0) {
    reasons.push(`${counts.certificateCount} certificate${counts.certificateCount === 1 ? "" : "s"} exist for this student in this batch`);
  }
  if (counts.paymentActivityCount > 0) {
    reasons.push(
      `${counts.paymentActivityCount} payment${counts.paymentActivityCount === 1 ? " has" : "s have"} been recorded against this enrollment's fee schedule`,
    );
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

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
  if (!academyWide) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(existing.branchId)) {
      return { ok: false, error: ENROLLMENT_NOT_FOUND };
    }
  }

  const counts = await countEnrollmentHistory(db, existing.enrollment.studentId, existing.enrollment.batchId, existing.enrollment.id);
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

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
    if (!academyWide) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return { ok: false, error: ENROLLMENT_NOT_FOUND };
      }
    }

    const counts = await countEnrollmentHistory(tx, existing.enrollment.studentId, existing.enrollment.batchId, enrollmentId);
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

    // Every enrollment now carries an enrollment_fee_schedules row (and
    // usually fee_periods too — see enrollStudentInBatch) that references
    // this row by FK. `paymentActivityCount === 0` was just confirmed above
    // (a nonzero count would have already returned "ineligible"), so no
    // payment_allocations reference any of this enrollment's fee periods —
    // safe to remove the unused schedule/periods before the enrollment
    // itself, in the same order the FKs require.
    await tx.delete(feePeriods).where(eq(feePeriods.enrollmentId, enrollmentId));
    await tx.delete(enrollmentFeeSchedules).where(eq(enrollmentFeeSchedules.enrollmentId, enrollmentId));
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
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };

  const batch = await getScopedBatch(db, academyId, academyWide, actorContext.userId, batchId);
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
  const enrollmentIds = rows.map((row) => row.enrollment.id);
  const [examResultRows, certificateRows, paymentRows] = studentIds.length
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
        // Payment activity is scoped per ENROLLMENT (not student+batch) —
        // a re-enrolled student's earlier withdrawn enrollment keeps its
        // own fee history separate from a fresh one.
        db
          .select({ enrollmentId: feePeriods.enrollmentId, count: sql<number>`count(*)::int` })
          .from(paymentAllocations)
          .innerJoin(feePeriods, eq(paymentAllocations.feePeriodId, feePeriods.id))
          .where(inArray(feePeriods.enrollmentId, enrollmentIds))
          .groupBy(feePeriods.enrollmentId),
      ])
    : [[], [], []];
  const examResultByStudent = new Map(examResultRows.map((r) => [r.studentId, r.count]));
  const certificateByStudent = new Map(certificateRows.map((r) => [r.studentId, r.count]));
  const paymentActivityByEnrollment = new Map(paymentRows.map((r) => [r.enrollmentId, r.count]));

  return {
    ok: true,
    enrollments: rows.map((row) => {
      const counts = {
        examResultCount: examResultByStudent.get(row.enrollment.studentId) ?? 0,
        certificateCount: certificateByStudent.get(row.enrollment.studentId) ?? 0,
        paymentActivityCount: paymentActivityByEnrollment.get(row.enrollment.id) ?? 0,
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
  courseId: string;
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
      courseId: batchEnrollments.courseId,
      courseName: courses.name,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(courses, eq(courses.id, batchEnrollments.courseId))
    .where(
      and(
        eq(batchEnrollments.academyId, academyId),
        eq(batchEnrollments.status, "active"),
        inArray(batchEnrollments.studentId, studentIds),
      ),
    );

  for (const row of rows) {
    const existing = result.get(row.studentId) ?? [];
    existing.push({ batchId: row.batchId, batchName: row.batchName, courseId: row.courseId, courseName: row.courseName });
    result.set(row.studentId, existing);
  }
  return result;
}

export type UpdateStudentEnrollmentResult = { ok: true } | { ok: false; error: BatchAssignmentActionError };

/**
 * Enroll an existing student in one or more courses of a batch — used by
 * Admissions, the Students list and Student detail. A student can hold
 * several enrollments (different courses, different batches), so this
 * only ever ADDS: it never withdraws the student's other enrollments
 * (withdrawal is per enrollment, via `withdrawStudentFromBatch`). It is
 * plain orchestration of `enrollStudentInBatch`, whose permission, scope,
 * duplicate and payment-plan rules all apply unchanged.
 */
export async function updateStudentEnrollment(
  actorContext: AuthContext,
  studentId: string,
  newBatchId: string | undefined,
  paymentPlan?: PaymentPlanInput,
  courseIds: string[] = [],
): Promise<UpdateStudentEnrollmentResult> {
  const parsedStudentId = z.string().uuid().safeParse(studentId);
  if (!parsedStudentId.success) return { ok: false, error: STUDENT_NOT_FOUND };

  if (!newBatchId) {
    return { ok: false, error: { code: "validation", message: "Choose a batch to enroll in." } };
  }
  if (!paymentPlan) {
    return {
      ok: false,
      error: { code: "validation", message: "A payment plan is required to enroll in a new course." },
    };
  }

  const enrollResult = await enrollStudentInBatch(actorContext, { batchId: newBatchId, studentId, paymentPlan, courseIds });
  if (!enrollResult.ok) return enrollResult;

  return { ok: true };
}
