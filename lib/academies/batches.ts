import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batchTrainerAssignments,
  batches,
  branches,
  certificates,
  courses,
  examResults,
  exams,
  staffBranchAssignments,
  staffProfiles,
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
  courseId: z.string().uuid("Select a course"),
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
  courseId: string;
  name: string;
  code: string;
  startDate: string;
  endDate: string | null;
  status: "planned" | "active" | "completed" | "archived";
  createdAt: Date;
}

function toRecord(row: typeof batches.$inferSelect): BatchRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    courseId: row.courseId,
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

interface ResolvedBatchAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  let rows: (typeof batches.$inferSelect)[];
  if (isBranchLimited(membershipRole)) {
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
      return { ...toRecord(row), deletionEligibility: { eligible: reasons.length === 0, reasons } };
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
  const { academyId, membershipRole } = resolved.access;

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

  if (isBranchLimited(membershipRole)) {
    const assignedIds = await getAssignedBranchIds(db, academyId, actorContext.userId);
    if (!assignedIds.includes(row.branchId)) {
      return { ok: false, error: NOT_FOUND };
    }
  }

  return { ok: true, batch: toRecord(row) };
}

class CourseNotFoundSignal extends Error {}
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

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

      if (isBranchLimited(membershipRole)) {
        const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
        if (!assignedIds.includes(data.branchId)) {
          throw new BranchNotFoundSignal();
        }
      }

      const courseOk = await courseExistsInAcademy(tx, academyId, data.courseId);
      if (!courseOk) {
        throw new CourseNotFoundSignal();
      }

      const [row] = await tx
        .insert(batches)
        .values({
          academyId,
          branchId: data.branchId,
          courseId: data.courseId,
          name: data.name,
          code: data.code,
          startDate: data.startDate,
          endDate: data.endDate,
        })
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createBatch",
          entityType: "batch",
          entityId: row.id,
          branchId: row.branchId,
          after: toRecord(row),
        },
        tx,
      );

      return row;
    });

    return { ok: true, batch: toRecord(result) };
  } catch (err) {
    if (err instanceof BranchNotFoundSignal) {
      return { ok: false, error: BRANCH_NOT_FOUND };
    }
    if (err instanceof CourseNotFoundSignal) {
      return { ok: false, error: COURSE_NOT_FOUND };
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

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

      if (isBranchLimited(membershipRole)) {
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
      if (isBranchLimited(membershipRole)) {
        const assignedIds = await getAssignedBranchIds(tx, academyId, actorContext.userId);
        if (!assignedIds.includes(data.branchId)) {
          throw new BranchNotFoundSignal();
        }
      }

      const courseOk = await courseExistsInAcademy(tx, academyId, data.courseId);
      if (!courseOk) {
        throw new CourseNotFoundSignal();
      }

      const [updated] = await tx
        .update(batches)
        .set({
          branchId: data.branchId,
          courseId: data.courseId,
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
  } catch (err) {
    if (err instanceof BranchNotFoundSignal) {
      return { ok: false, error: BRANCH_NOT_FOUND };
    }
    if (err instanceof CourseNotFoundSignal) {
      return { ok: false, error: COURSE_NOT_FOUND };
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

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

    if (isBranchLimited(membershipRole)) {
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

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

    if (isBranchLimited(membershipRole)) {
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
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canDeleteBatch(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [batch] = await db
    .select({ id: batches.id, name: batches.name })
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!batch) {
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
 * deleteProgram/deleteCourse. No branch-scoping check is needed here (see
 * `canDeleteBatch`'s own comment) — every role that ever reaches this
 * point is academy-wide, never branch-limited.
 */
export async function deleteBatch(
  actorContext: AuthContext,
  batchId: string,
  confirmedName: string,
): Promise<DeleteBatchResult> {
  const resolved = await resolveBatchAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

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
    await tx.delete(batches).where(eq(batches.id, batchId));

    return { ok: true, batchId };
  });
}
