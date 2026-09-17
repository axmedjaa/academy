import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { batches, branches, courses, staffBranchAssignments, staffProfiles } from "@/lib/db/schema";
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

export interface BatchActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
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

export type ListBatchesResult =
  | { ok: true; batches: BatchRecord[]; canManage: boolean }
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

  return {
    ok: true,
    batches: rows.map(toRecord),
    canManage: canManage(permissionLevel),
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
