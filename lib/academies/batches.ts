import { and, eq, inArray, sql } from "drizzle-orm";
import { getAssignedBranchIds } from "@/lib/academies/branch-access";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchCourses,
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  branches,
  certificates,
  courses,
  examResults,
  exams,
  timetables,
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
 * PLAN.md Phase 3, Item 43 — "`createBatch`."
 *
 * Unlike programs/courses (academy-wide, no `branch_id`), a batch carries a
 * real `branch_id` — this is the one entity in this item that needs the
 * branch-scoped/tenant-scoped IDOR pattern from lib/academies/branches.ts /
 * register-student.ts: join the caller's staff_profiles row to
 * staff_branch_assignments to get their assigned branch_ids, then filter
 * every read/write by that set for the two branch-limited roles
 * (Admissions Officer, Trainer).
 *
 * Master Permission Matrix "Courses / batches" row:
 * Full(owner)/Full(admin)/Manage(manager)/View(admissions_officer)/
 * —(finance_officer)/"Manage assigned"(trainer). Unlike programs/courses,
 * Trainer's "manage" level DOES apply here — batches are exactly the
 * branch-scoped entity "assigned" describes — so Trainer may create/
 * update/archive a batch, but only within their own assigned branch(es);
 * Admissions Officer's "view" level means list/get only, also scoped to
 * their assigned branch(es).
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/** Stricter than `canManage`/archive: Trainer holds "manage" on this
 * action for their own assigned batches (see this file's module comment),
 * but permanent deletion is deliberately narrower than archive — only
 * Owner/Admin/Manager (the three academy-wide roles) may ever delete a
 * batch, matching the same restriction already applied to Programs/
 * Courses (canManagePrograms/canManageCourses exclude Trainer outright). */
function canDeleteBatch(role: AcademyRole, level: AcademyPermissionLevel): boolean {
  return canManage(level) && role !== "trainer";
}

export interface BatchActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "ineligible";
  message: string;
}

const FORBIDDEN: BatchActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's batches.",
};

// Same generic-message IDOR-safety convention as branches.ts's NOT_FOUND:
// nonexistent, cross-academy, and unassigned-for-a-branch-limited-caller
// must all be indistinguishable, including via a guessed id.
const NOT_FOUND: BatchActionError = {
  code: "not_found",
  message: "Batch not found.",
};

const COURSE_NOT_FOUND: BatchActionError = {
  code: "not_found",
  message: "Course not found.",
};

const BRANCH_NOT_FOUND: BatchActionError = {
  code: "not_found",
  message: "Branch not found.",
};

export const createBatchSchema = z.object({
  branchId: z.string().uuid("Select a branch"),
  // One or more courses (Review Summary "Batches hold several courses").
  // The first is kept as the batch's primary course in batches.course_id.
  courseIds: z
    .array(z.string().uuid("Select a course"))
    .transform((ids) => [...new Set(ids)])
    .refine((ids) => ids.length > 0, { message: "Pick at least one course." })
    .refine((ids) => ids.length <= 20, { message: "A batch can hold at most 20 courses." }),
  name: z.string().trim().min(1, "Batch name is required").max(200),
  code: z.string().trim().min(1, "Batch code is required").max(50),
  // Plain "YYYY-MM-DD" strings, same convention as register-student.ts's
  // dateOfBirth for a `date` (not `timestamp`) column.
  startDate: z.string().trim().min(1, "Start date is required").max(20),
  endDate: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type CreateBatchInput = z.input<typeof createBatchSchema>;
export type UpdateBatchInput = CreateBatchInput;

export interface BatchRecord {
  id: string;
  academyId: string;
  branchId: string;
  /** The batch's primary (first) course, kept for readers that need one. */
  courseId: string;
  /** Every course the batch runs, primary first. */
  courseIds: string[];
  name: string;
  code: string;
  startDate: string;
  endDate: string | null;
  status: "planned" | "active" | "completed" | "archived";
  createdAt: Date;
}

function toRecord(row: typeof batches.$inferSelect, courseIds?: string[]): BatchRecord {
  const ids = courseIds && courseIds.length > 0 ? courseIds : [row.courseId];
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    courseId: row.courseId,
    courseIds: [row.courseId, ...ids.filter((id) => id !== row.courseId)],
    name: row.name,
    code: row.code,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

/** Same join pattern as lib/academies/branches.ts's private
 * `getAssignedBranchIds` (read-only reference, not imported — each
 * academy-scoped action file keeps its own copy per that file's own
 * documented convention). */
/** Course ids per batch from batch_courses, in the order they were added. */
export async function loadBatchCourseIds(executor: DbClient, batchIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (batchIds.length === 0) return map;
  const rows = await executor
    .select({ batchId: batchCourses.batchId, courseId: batchCourses.courseId })
    .from(batchCourses)
    .where(inArray(batchCourses.batchId, batchIds))
    .orderBy(batchCourses.createdAt);
  for (const row of rows) map.set(row.batchId, [...(map.get(row.batchId) ?? []), row.courseId]);
  return map;
}

/** Whether a course is in use within one batch (enrollments of any status,
 * timetable entries or exams) — such a course can't be removed from it. */
async function courseUsedInBatch(executor: DbClient, batchId: string, courseId: string): Promise<boolean> {
  const [enrollment] = await executor
    .select({ id: batchEnrollments.id })
    .from(batchEnrollments)
    .where(and(eq(batchEnrollments.batchId, batchId), eq(batchEnrollments.courseId, courseId)))
    .limit(1);
  if (enrollment) return true;
  const [entry] = await executor
    .select({ id: timetables.id })
    .from(timetables)
    .where(and(eq(timetables.batchId, batchId), eq(timetables.courseId, courseId)))
    .limit(1);
  if (entry) return true;
  const [exam] = await executor
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.batchId, batchId), eq(exams.courseId, courseId)))
    .limit(1);
  return Boolean(exam);
}


interface ResolvedBatchAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
  academyWide: boolean;
}

type ResolveBatchAccessResult =
  | { ok: true; access: ResolvedBatchAccess }
  | { ok: false; error: BatchActionError };

async function resolveBatchAccess(actorContext: AuthContext): Promise<ResolveBatchAccessResult> {
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

async function courseExistsInAcademy(
  executor: DbClient,
  academyId: string,
  courseId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.academyId, academyId)))
    .limit(1);
  return Boolean(row);
}

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

export interface BatchDeletionEligibilitySummary {
  eligible: boolean;
  reasons: string[];
}

export type ListBatchesResult =
  | {
      ok: true;
      batches: (BatchRecord & { deletionEligibility: BatchDeletionEligibilitySummary })[];
      canManage: boolean;
      /** Narrower than `canManage` — see `canDeleteBatch`'s own comment.
       * The UI renders the Delete action only when this is true (never a
       * disabled Delete for a role that can never reach it at all, per
       * DESIGN.md §"Rule for building any screen": permission-absent
       * controls are omitted entirely, not shown disabled). */
      canDelete: boolean;
    }
  | { ok: false; error: BatchActionError };

/**
 * Academy-wide roles (full/manage) get every batch in the academy;
 * branch-limited roles (Admissions Officer, Trainer) get only batches
 * whose `branch_id` is one of their assigned branches, per staff_
 * branch_assignments — same shape as lib/academies/branches.ts's
 * listBranches.
 */
export async function listBatches(actorContext: AuthContext): Promise<ListBatchesResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  let rows: (typeof batches.$inferSelect)[];
  if (!academyWide) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    rows =
      assignedIds.length === 0
        ? []
        : await db
            .select()
            .from(batches)
            .where(and(eq(batches.academyId, academyId), inArray(batches.branchId, assignedIds)));
  } else {
    rows = await db.select().from(batches).where(eq(batches.academyId, academyId));
  }

  const countsByBatchId = await countBatchDependentsBulk(rows.map((row) => row.id));
  const courseIdsByBatch = await loadBatchCourseIds(db, rows.map((row) => row.id));

  return {
    ok: true,
    batches: rows.map((row) => {
      const counts = countsByBatchId.get(row.id) ?? {
        enrollmentCount: 0,
        examCount: 0,
        examResultCount: 0,
        certificateCount: 0,
        cancelledCertificateCount: 0,
      };
      const reasons = buildBatchDeletionReasons(counts);
      return {
        ...toRecord(row, courseIdsByBatch.get(row.id)),
        deletionEligibility: { eligible: reasons.length === 0, reasons },
      };
    }),
    canManage: canManage(permissionLevel),
    canDelete: canDeleteBatch(membershipRole, permissionLevel),
  };
}

export type GetBatchResult =
  | { ok: true; batch: BatchRecord }
  | { ok: false; error: BatchActionError };

/** Single-batch read, tenant- and (for branch-limited roles) branch-scoped.
 * IDOR-safe: nonexistent id, cross-academy batch, and an unassigned-branch
 * batch for a branch-limited caller all return the identical NOT_FOUND —
 * including for a guessed id — never a distinguishing "forbidden". */
export async function getBatch(
  actorContext: AuthContext,
  batchId: string,
): Promise<GetBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, academyWide } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  if (!academyWide) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(row.branchId)) {
      return { ok: false, error: NOT_FOUND };
    }
  }

  const courseIds = await loadBatchCourseIds(db, [row.id]);
  return { ok: true, batch: toRecord(row, courseIds.get(row.id)) };
}

class CourseNotFoundSignal extends Error {}
class CourseInUseSignal extends Error {
  constructor(public readonly courseName: string) {
    super("Course in use.");
  }
}
class BranchNotFoundSignal extends Error {}

export type CreateBatchResult =
  | { ok: true; batch: BatchRecord }
  | { ok: false; error: BatchActionError };

/**
 * PLAN.md §4: `createBatch`. Only "full"/"manage" may create — Admissions
 * Officer ("view") is refused here even though it has read access to this
 * row. Trainer (branch-limited, "manage") may create only into one of
 * their own assigned branches — any other branchId (including a
 * cross-academy or nonexistent one) is refused with the same generic
 * `not_found` a branch-limited caller hitting an unassigned branch would
 * get elsewhere in this codebase, never a distinguishing `forbidden`.
 */
export async function createBatch(
  actorContext: AuthContext,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createBatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const branchOk = await branchExistsInAcademy(tx, academyId, data.branchId);
      if (!branchOk) {
        throw new BranchNotFoundSignal();
      }

      if (!academyWide) {
        const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
        if (!assignedIds.includes(data.branchId)) {
          throw new BranchNotFoundSignal();
        }
      }

      for (const courseId of data.courseIds) {
        if (!(await courseExistsInAcademy(tx, academyId, courseId))) {
          throw new CourseNotFoundSignal();
        }
      }

      const [row] = await tx
        .insert(batches)
        .values({
          academyId,
          branchId: data.branchId,
          courseId: data.courseIds[0],
          name: data.name,
          code: data.code,
          startDate: data.startDate,
          endDate: data.endDate,
        })
        .returning();

      await tx
        .insert(batchCourses)
        .values(data.courseIds.map((courseId) => ({ academyId, batchId: row.id, courseId })));

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createBatch",
          entityType: "batch",
          entityId: row.id,
          branchId: row.branchId,
          after: toRecord(row, data.courseIds),
        },
        tx,
      );

      return row;
    });

    return { ok: true, batch: toRecord(result, data.courseIds) };
  } catch (err) {
    if (err instanceof BranchNotFoundSignal) {
      return { ok: false, error: BRANCH_NOT_FOUND };
    }
    if (err instanceof CourseNotFoundSignal) {
      return { ok: false, error: COURSE_NOT_FOUND };
    }
    if (err instanceof CourseInUseSignal) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `${err.courseName} can't be removed from this batch because students, classes or exams use it there.`,
        },
      };
    }
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A batch with that code already exists for this academy." },
      };
    }
    throw err;
  }
}

export type UpdateBatchResult =
  | { ok: true; batch: BatchRecord }
  | { ok: false; error: BatchActionError };

/** Same gating as createBatch; a branch-limited caller may also not move a
 * batch they can already manage into a branch they aren't assigned to. */
export async function updateBatch(
  actorContext: AuthContext,
  batchId: string,
  input: UpdateBatchInput,
): Promise<UpdateBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = createBatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
        .limit(1);
      if (!existing) return null;

      if (!academyWide) {
        const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
        if (!assignedIds.includes(existing.branchId)) {
          // Existing batch is outside the caller's scope — IDOR, not_found.
          return null;
        }
      }

      const branchOk = await branchExistsInAcademy(tx, academyId, data.branchId);
      if (!branchOk) {
        throw new BranchNotFoundSignal();
      }
      if (!academyWide) {
        const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
        if (!assignedIds.includes(data.branchId)) {
          throw new BranchNotFoundSignal();
        }
      }

      for (const courseId of data.courseIds) {
        if (!(await courseExistsInAcademy(tx, academyId, courseId))) {
          throw new CourseNotFoundSignal();
        }
      }

      // Add new courses; remove dropped ones only when nothing in this batch
      // uses them yet (enrollments, classes, exams keep their course).
      const currentIds = (await loadBatchCourseIds(tx, [batchId])).get(batchId) ?? [existing.courseId];
      const removed = currentIds.filter((id) => !data.courseIds.includes(id));
      const added = data.courseIds.filter((id) => !currentIds.includes(id));
      for (const courseId of removed) {
        if (await courseUsedInBatch(tx, batchId, courseId)) {
          const [course] = await tx.select({ name: courses.name }).from(courses).where(eq(courses.id, courseId)).limit(1);
          throw new CourseInUseSignal(course?.name ?? "This course");
        }
      }
      if (added.length > 0) {
        await tx.insert(batchCourses).values(added.map((courseId) => ({ academyId, batchId, courseId })));
      }
      // Keep the primary course pointing at a course the batch still has.
      const primary = data.courseIds.includes(existing.courseId) ? existing.courseId : data.courseIds[0];

      const [updated] = await tx
        .update(batches)
        .set({
          branchId: data.branchId,
          courseId: primary,
          name: data.name,
          code: data.code,
          startDate: data.startDate,
          endDate: data.endDate,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId))
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "updateBatch",
          entityType: "batch",
          entityId: batchId,
          branchId: updated.branchId,
          before: toRecord(existing, currentIds),
          after: toRecord(updated, data.courseIds),
        },
        tx,
      );

      if (removed.length > 0) {
        await tx
          .delete(batchCourses)
          .where(and(eq(batchCourses.batchId, batchId), inArray(batchCourses.courseId, removed)));
      }

      return updated;
    });

    if (!result) {
      return { ok: false, error: NOT_FOUND };
    }
    return { ok: true, batch: toRecord(result, data.courseIds) };
  } catch (err) {
    if (err instanceof BranchNotFoundSignal) {
      return { ok: false, error: BRANCH_NOT_FOUND };
    }
    if (err instanceof CourseNotFoundSignal) {
      return { ok: false, error: COURSE_NOT_FOUND };
    }
    if (err instanceof CourseInUseSignal) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `${err.courseName} can't be removed from this batch because students, classes or exams use it there.`,
        },
      };
    }
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A batch with that code already exists for this academy." },
      };
    }
    throw err;
  }
}

export type ArchiveBatchResult =
  | { ok: true; batch: BatchRecord }
  | { ok: false; error: BatchActionError };

/** No hard delete — `status = archived` is the only removal path.
 * Branch-limited callers may only archive a batch in their own assigned
 * branch(es); an out-of-scope batch id returns the identical NOT_FOUND. */
export async function archiveBatch(
  actorContext: AuthContext,
  batchId: string,
): Promise<ArchiveBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    if (!academyWide) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return null;
      }
    }

    const [updated] = await tx
      .update(batches)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(batches.id, batchId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "archiveBatch",
        entityType: "batch",
        entityId: batchId,
        branchId: updated.branchId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, batch: toRecord(result) };
}

/** Mirror of archiveBatch, flipped — restores to "active" regardless of
 * whatever status the batch had before archiving (this table doesn't track
 * that), since "active" is the normal usable state. Idempotent, same
 * branch-scoping rule as archiveBatch. */
export async function restoreBatch(
  actorContext: AuthContext,
  batchId: string,
): Promise<ArchiveBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    if (!academyWide) {
      const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
      if (!assignedIds.includes(existing.branchId)) {
        return null;
      }
    }

    const [updated] = await tx
      .update(batches)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(batches.id, batchId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "restoreBatch",
        entityType: "batch",
        entityId: batchId,
        branchId: updated.branchId,
        before: toRecord(existing),
        after: toRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, batch: toRecord(result) };
}

/**
 * ---------------------------------------------------------------------
 * Permanent batch deletion — narrow, eligibility-gated, distinct from
 * archiveBatch
 * ---------------------------------------------------------------------
 * Direct inbound FKs to `batches` (lib/db/schema.ts): batchTrainerAssignments,
 * batchEnrollments, timetables, exams (batchId), examResults (batchId,
 * denormalized), certificates (batchId). Enrollments/exams/results/
 * certificates are protected — any row blocks deletion outright, matching
 * this task's explicit "batch with enrollment/exam/result/certificate
 * blocked" rule (an exam always implies zero-or-more exam_results, but
 * both are reported separately here for a clearer reason list, same style
 * as the student/staff eligibility messages).
 *
 * batchTrainerAssignments and timetables are treated as safely disposable
 * — scheduling/staffing metadata with no standalone meaning once the batch
 * itself is gone, the same judgment lib/academies/delete-academy.ts's own
 * disposable-data list already made for `timetables` at the whole-academy
 * scale. They are deleted explicitly, by name, inside the same transaction
 * — never a blind cascade.
 */
export interface BatchDeletionEligibility {
  batchId: string;
  batchName: string;
  eligible: boolean;
  reasons: string[];
  enrollmentCount: number;
  examCount: number;
  examResultCount: number;
  certificateCount: number;
  /** How many of `certificateCount` are specifically cancelled — broken
   * out only so the blocking reason can say so explicitly (see
   * `buildBatchDeletionReasons`'s own comment on why a cancelled
   * certificate still blocks deletion). */
  cancelledCertificateCount: number;
}

export type GetBatchDeletionEligibilityResult =
  | { ok: true; eligibility: BatchDeletionEligibility }
  | { ok: false; error: BatchActionError };

type BatchDependentCounts = {
  enrollmentCount: number;
  examCount: number;
  examResultCount: number;
  certificateCount: number;
  cancelledCertificateCount: number;
};

/** Bulk per-batch dependent counts, for the batches list's Delete button —
 * four grouped queries for the whole visible list rather than N+1. */
async function countBatchDependentsBulk(batchIds: string[]): Promise<Map<string, BatchDependentCounts>> {
  if (batchIds.length === 0) return new Map();
  const [enrollmentRows, examRows, examResultRows, certificateRows, cancelledCertificateRows] = await Promise.all([
    db.select({ batchId: batchEnrollments.batchId, count: sql<number>`count(*)::int` }).from(batchEnrollments).where(inArray(batchEnrollments.batchId, batchIds)).groupBy(batchEnrollments.batchId),
    db.select({ batchId: exams.batchId, count: sql<number>`count(*)::int` }).from(exams).where(inArray(exams.batchId, batchIds)).groupBy(exams.batchId),
    db.select({ batchId: examResults.batchId, count: sql<number>`count(*)::int` }).from(examResults).where(inArray(examResults.batchId, batchIds)).groupBy(examResults.batchId),
    db.select({ batchId: certificates.batchId, count: sql<number>`count(*)::int` }).from(certificates).where(inArray(certificates.batchId, batchIds)).groupBy(certificates.batchId),
    db
      .select({ batchId: certificates.batchId, count: sql<number>`count(*)::int` })
      .from(certificates)
      .where(and(inArray(certificates.batchId, batchIds), eq(certificates.status, "cancelled")))
      .groupBy(certificates.batchId),
  ]);
  const enrollmentByBatch = new Map(enrollmentRows.map((r) => [r.batchId, r.count]));
  const examByBatch = new Map(examRows.map((r) => [r.batchId, r.count]));
  const examResultByBatch = new Map(examResultRows.map((r) => [r.batchId, r.count]));
  const certificateByBatch = new Map(certificateRows.map((r) => [r.batchId, r.count]));
  const cancelledCertificateByBatch = new Map(cancelledCertificateRows.map((r) => [r.batchId, r.count]));

  const result = new Map<string, BatchDependentCounts>();
  for (const batchId of batchIds) {
    result.set(batchId, {
      enrollmentCount: enrollmentByBatch.get(batchId) ?? 0,
      examCount: examByBatch.get(batchId) ?? 0,
      examResultCount: examResultByBatch.get(batchId) ?? 0,
      certificateCount: certificateByBatch.get(batchId) ?? 0,
      cancelledCertificateCount: cancelledCertificateByBatch.get(batchId) ?? 0,
    });
  }
  return result;
}

async function countBatchDependents(
  executor: DbClient,
  batchId: string,
): Promise<BatchDependentCounts> {
  const [[enrollmentRow], [examRow], [examResultRow], [certificateRow], [cancelledCertificateRow]] = await Promise.all([
    executor.select({ count: sql<number>`count(*)::int` }).from(batchEnrollments).where(eq(batchEnrollments.batchId, batchId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(exams).where(eq(exams.batchId, batchId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(examResults).where(eq(examResults.batchId, batchId)),
    executor.select({ count: sql<number>`count(*)::int` }).from(certificates).where(eq(certificates.batchId, batchId)),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(certificates)
      .where(and(eq(certificates.batchId, batchId), eq(certificates.status, "cancelled"))),
  ]);
  return {
    enrollmentCount: enrollmentRow?.count ?? 0,
    examCount: examRow?.count ?? 0,
    examResultCount: examResultRow?.count ?? 0,
    certificateCount: certificateRow?.count ?? 0,
    cancelledCertificateCount: cancelledCertificateRow?.count ?? 0,
  };
}

function buildBatchDeletionReasons(counts: {
  enrollmentCount: number;
  examCount: number;
  examResultCount: number;
  certificateCount: number;
  cancelledCertificateCount: number;
}): string[] {
  const reasons: string[] = [];
  if (counts.enrollmentCount > 0) {
    reasons.push(`${counts.enrollmentCount} student enrollment${counts.enrollmentCount === 1 ? "" : "s"} exist`);
  }
  if (counts.examCount > 0) {
    reasons.push(`${counts.examCount} exam${counts.examCount === 1 ? "" : "s"} exist`);
  }
  if (counts.examResultCount > 0) {
    reasons.push(`${counts.examResultCount} exam result${counts.examResultCount === 1 ? "" : "s"} exist`);
  }
  if (counts.certificateCount > 0) {
    const activeCount = counts.certificateCount - counts.cancelledCertificateCount;
    // Explicit about cancelled certificates specifically — cancelling one
    // does NOT free up the batch for deletion, since a cancelled
    // certificate must stay permanently verifiable (DESIGN.md's
    // "cancelled/invalid" state on /verify/[code], never a 404) just like
    // an issued one, and certificates.batch_id is a NOT NULL FK with no
    // cascade — the batch row has to keep existing for that to work.
    if (counts.cancelledCertificateCount > 0 && activeCount > 0) {
      reasons.push(
        `${counts.certificateCount} certificates exist for this batch (${activeCount} issued, ${counts.cancelledCertificateCount} cancelled) — certificates remain permanently verifiable even after cancellation, so this batch can't be deleted while any exist`,
      );
    } else if (counts.cancelledCertificateCount > 0) {
      reasons.push(
        `${counts.cancelledCertificateCount} cancelled certificate${counts.cancelledCertificateCount === 1 ? "" : "s"} still exist${counts.cancelledCertificateCount === 1 ? "s" : ""} for this batch — certificates remain permanently verifiable even after cancellation, so this batch can't be deleted while any exist`,
      );
    } else {
      reasons.push(`${counts.certificateCount} certificate${counts.certificateCount === 1 ? "" : "s"} exist for this batch`);
    }
  }
  return reasons;
}

/** Read-only preview for the UI's Delete button — `deleteBatch` below
 * re-runs the identical check itself, inside the deletion transaction, as
 * the actual authority. */
export async function getBatchDeletionEligibility(
  actorContext: AuthContext,
  batchId: string,
): Promise<GetBatchDeletionEligibilityResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canDeleteBatch(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [batch] = await db
    .select({ id: batches.id, name: batches.name, branchId: batches.branchId })
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!batch) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!academyWide && !(await getAssignedBranchIds(db, academyId, actorContext.userId)).includes(batch.branchId)) {
    return { ok: false, error: NOT_FOUND };
  }

  const counts = await countBatchDependents(db, batch.id);
  const reasons = buildBatchDeletionReasons(counts);

  return {
    ok: true,
    eligibility: {
      batchId: batch.id,
      batchName: batch.name,
      eligible: reasons.length === 0,
      reasons,
      ...counts,
    },
  };
}

export type DeleteBatchResult =
  | { ok: true; batchId: string }
  | { ok: false; error: BatchActionError };

/**
 * Eligibility is re-verified from scratch INSIDE this transaction, on a
 * row locked with `for("update")` — a student could be enrolled or an exam
 * created between the UI's preview and this call, and this is the check
 * that actually decides whether the delete proceeds. Audited before the
 * row is removed, same convention as deleteAcademy/deleteExam/
 * deleteProgram/deleteCourse. Multi-branch: a member without all-branch
 * access may only delete a batch in one of their assigned branches —
 * anything else is the same NOT_FOUND as a missing batch.
 */
export async function deleteBatch(
  actorContext: AuthContext,
  batchId: string,
  confirmedName: string,
): Promise<DeleteBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel, academyWide } = resolved.access;

  if (!canDeleteBatch(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: NOT_FOUND };
    }
    if (!academyWide && !(await getAssignedBranchIds(tx, academyId, actorContext.userId)).includes(existing.branchId)) {
      return { ok: false, error: NOT_FOUND };
    }

    // Re-checked against the row's CURRENT name, under the same lock —
    // never trusts a name the caller fetched earlier via the eligibility
    // preview, same convention as lib/academies/delete-academy.ts's
    // deleteAcademy.
    if (confirmedName !== existing.name) {
      return {
        ok: false,
        error: { code: "validation", message: "Type the exact batch name to confirm permanent deletion." },
      };
    }

    const counts = await countBatchDependents(tx, existing.id);
    const reasons = buildBatchDeletionReasons(counts);
    if (reasons.length > 0) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: `This batch cannot be permanently deleted because ${reasons.join(", ")}. Archive it instead.`,
        },
      };
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteBatch",
        entityType: "batch",
        entityId: batchId,
        branchId: existing.branchId,
        before: toRecord(existing),
      },
      tx,
    );

    // Disposable dependent data only — guaranteed by the eligibility check
    // above that no enrollment/exam/result/certificate exists to reach
    // through either of these.
    await tx.delete(batchTrainerAssignments).where(eq(batchTrainerAssignments.batchId, batchId));
    await tx.delete(timetables).where(eq(timetables.batchId, batchId));
    await tx.delete(batchCourses).where(eq(batchCourses.batchId, batchId));
    await tx.delete(batches).where(eq(batches.id, batchId));

    return { ok: true, batchId };
  });
}
