import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { batches, staffBranchAssignments, staffProfiles, timetables } from "@/lib/db/schema";
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
 * PLAN.md Phase 3, Item 45 — "`timetables` migration + CRUD — no attendance
 * fields" / §4's `createTimetableEntry`.
 *
 * Permission row: reused, not new — same reasoning as
 * lib/academies/batch-assignments.ts (Item 44). No distinct "Timetable" row
 * exists anywhere in the Master Permission Matrix or DESIGN.md; a timetable
 * entry is scheduling data *for a batch*, so it falls under the same
 * "Courses / batches" capability (`ACADEMY_COURSES_BATCHES_ACTION`) that
 * `batches.ts`/`batch-assignments.ts` already gate with.
 *
 * Branch scoping: identical join pattern to `batches.ts`/
 * `batch-assignments.ts` (staff_profiles -> staff_branch_assignments), keyed
 * off the entry's own `branch_id`.
 *
 * No soft-delete column: PLAN.md's literal column list for `timetables` has
 * no `status` field, unlike every other Phase 3 table — a recurring weekly
 * slot is scheduling configuration, not a historical/financial record, so
 * this item does not invent a status column beyond PLAN.md's own list (per
 * "make additive/minimum schema changes required by the specifications").
 * `deleteTimetableEntry` is therefore a real hard delete — a deliberate,
 * documented exception to this codebase's usual no-hard-delete convention,
 * justified by the schema itself giving this one table no removal-state
 * column to soft-delete into.
 *
 * CRITICAL — Decision #21: no attendance/check-in concept anywhere in this
 * file, its schema, or its UI.
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

export interface TimetableActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked";
  message: string;
}

const FORBIDDEN: TimetableActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this branch's timetable.",
};

const ENTRY_NOT_FOUND: TimetableActionError = {
  code: "not_found",
  message: "Timetable entry not found.",
};

const BATCH_NOT_FOUND: TimetableActionError = {
  code: "not_found",
  message: "Batch not found.",
};

/** Same per-file join-pattern copy as batches.ts/batch-assignments.ts. */
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

interface ResolvedScopeAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveScopeAccessResult =
  | { ok: true; access: ResolvedScopeAccess }
  | { ok: false; error: TimetableActionError };

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
    access: { academyId: access.academyId, membershipRole: access.membershipRole, permissionLevel },
  };
}

/** Verifies a branch-limited caller may act on the given branchId — the
 * identical branch, not derived from a batch, since a timetable entry's own
 * `branch_id` is the authoritative scope (it need not match the batch's
 * branch, though in practice it always will since a batch belongs to one
 * branch). */
async function assertBranchInScope(
  executor: DbClient,
  academyId: string,
  membershipRole: AcademyRole,
  userId: string,
  branchId: string,
): Promise<boolean> {
  if (!isBranchLimited(membershipRole)) return true;
  const assignedIds = await getAssignedBranchIds(executor, academyId, userId);
  return assignedIds.includes(branchId);
}

const DAYS_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const createTimetableEntrySchema = z
  .object({
    branchId: z.string().uuid("Select a branch"),
    batchId: z.string().uuid("Select a batch"),
    dayOfWeek: z.enum(DAYS_OF_WEEK),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format"),
    endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format"),
    room: z
      .string()
      .trim()
      .max(200)
      .optional()
      .nullable()
      .transform((value) => (value ? value : null)),
    trainerStaffProfileId: z
      .string()
      .uuid()
      .optional()
      .nullable()
      .transform((value) => (value ? value : null)),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "End time must be after start time.",
    path: ["endTime"],
  });

export type CreateTimetableEntryInput = z.input<typeof createTimetableEntrySchema>;

export interface TimetableEntryRecord {
  id: string;
  academyId: string;
  branchId: string;
  batchId: string;
  dayOfWeek: (typeof DAYS_OF_WEEK)[number];
  startTime: string;
  endTime: string;
  room: string | null;
  trainerStaffProfileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: typeof timetables.$inferSelect): TimetableEntryRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    branchId: row.branchId,
    batchId: row.batchId,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    room: row.room,
    trainerStaffProfileId: row.trainerStaffProfileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CreateTimetableEntryResult =
  | { ok: true; entry: TimetableEntryRecord }
  | { ok: false; error: TimetableActionError };

/** PLAN.md §4: `createTimetableEntry`. Only "full"/"manage" may create.
 * `end_time > start_time` is enforced both here (Zod, for a fast client
 * error) and by the DB check constraint (the real guarantee). */
export async function createTimetableEntry(
  actorContext: AuthContext,
  input: CreateTimetableEntryInput,
): Promise<CreateTimetableEntryResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createTimetableEntrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const inScope = await assertBranchInScope(
    db,
    academyId,
    membershipRole,
    actorContext.userId,
    data.branchId,
  );
  if (!inScope) {
    return { ok: false, error: FORBIDDEN };
  }

  const result = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select({ id: batches.id })
      .from(batches)
      .where(and(eq(batches.id, data.batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!batch) return { outcome: "batch_not_found" as const };

    const [row] = await tx
      .insert(timetables)
      .values({
        academyId,
        branchId: data.branchId,
        batchId: data.batchId,
        dayOfWeek: data.dayOfWeek,
        startTime: data.startTime,
        endTime: data.endTime,
        room: data.room,
        trainerStaffProfileId: data.trainerStaffProfileId,
      })
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createTimetableEntry",
        entityType: "timetable",
        entityId: row.id,
        branchId: data.branchId,
        after: toRecord(row),
      },
      tx,
    );

    return { outcome: "ok" as const, row };
  });

  if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
  return { ok: true, entry: toRecord(result.row) };
}

export interface TimetableEntryWithBatch extends TimetableEntryRecord {
  batchName: string;
}

export type ListAcademyTimetableResult =
  | { ok: true; entries: TimetableEntryWithBatch[]; canManage: boolean }
  | { ok: false; error: TimetableActionError };

/** Academy-wide timetable view for `/academy/timetable` (PLAN.md §3 names
 * this one route, not a per-batch route) — every entry across every batch,
 * joined to the batch name for display, filtered to a branch-limited
 * caller's assigned branch(es) the same way listTimetableEntries is. */
export async function listAcademyTimetable(
  actorContext: AuthContext,
): Promise<ListAcademyTimetableResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const rows = await db
    .select({ entry: timetables, batchName: batches.name })
    .from(timetables)
    .innerJoin(batches, eq(batches.id, timetables.batchId))
    .where(eq(timetables.academyId, academyId));

  const visible: typeof rows = [];
  for (const row of rows) {
    const inScope = await assertBranchInScope(
      db,
      academyId,
      membershipRole,
      actorContext.userId,
      row.entry.branchId,
    );
    if (inScope) visible.push(row);
  }

  return {
    ok: true,
    entries: visible.map((row) => ({ ...toRecord(row.entry), batchName: row.batchName })),
    canManage: canManage(permissionLevel),
  };
}

export type ListTimetableEntriesResult =
  | { ok: true; entries: TimetableEntryRecord[]; canManage: boolean }
  | { ok: false; error: TimetableActionError };

/** Lists every timetable entry for one batch, scoped to the caller's
 * academy and (for branch-limited roles) their assigned branch(es). */
export async function listTimetableEntries(
  actorContext: AuthContext,
  batchId: string,
): Promise<ListTimetableEntriesResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(batchId);
  if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };

  const [batch] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
    .limit(1);
  if (!batch) return { ok: false, error: BATCH_NOT_FOUND };

  const rows = await db.select().from(timetables).where(eq(timetables.batchId, batchId));

  const visible: typeof rows = [];
  for (const row of rows) {
    const inScope = await assertBranchInScope(
      db,
      academyId,
      membershipRole,
      actorContext.userId,
      row.branchId,
    );
    if (inScope) visible.push(row);
  }

  return { ok: true, entries: visible.map(toRecord), canManage: canManage(permissionLevel) };
}

export type UpdateTimetableEntryResult =
  | { ok: true; entry: TimetableEntryRecord }
  | { ok: false; error: TimetableActionError };

export const updateTimetableEntrySchema = z
  .object({
    dayOfWeek: z.enum(DAYS_OF_WEEK).optional(),
    startTime: z
      .string()
      .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format")
      .optional(),
    endTime: z
      .string()
      .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format")
      .optional(),
    room: z
      .string()
      .trim()
      .max(200)
      .optional()
      .nullable()
      .transform((value) => (value === undefined ? undefined : value ? value : null)),
    trainerStaffProfileId: z
      .string()
      .uuid()
      .optional()
      .nullable()
      .transform((value) => (value === undefined ? undefined : value ? value : null)),
  });

export type UpdateTimetableEntryInput = z.input<typeof updateTimetableEntrySchema>;

/** PLAN.md gives this table no separate action name for edits beyond
 * `createTimetableEntry` — this is a reasonable, minimal extension (same
 * fields, direct edit, no approval step, matching every other academy-wide
 * CRUD entity in this codebase). Re-validates `end_time > start_time`
 * against the resulting merged row, not just the patch in isolation. */
export async function updateTimetableEntry(
  actorContext: AuthContext,
  entryId: string,
  input: UpdateTimetableEntryInput,
): Promise<UpdateTimetableEntryResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(entryId);
  if (!parsedId.success) return { ok: false, error: ENTRY_NOT_FOUND };

  const parsed = updateTimetableEntrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const patch = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(timetables)
      .where(and(eq(timetables.id, entryId), eq(timetables.academyId, academyId)))
      .for("update");
    if (!existing) return { outcome: "not_found" as const };

    const inScope = await assertBranchInScope(
      tx,
      academyId,
      membershipRole,
      actorContext.userId,
      existing.branchId,
    );
    if (!inScope) return { outcome: "not_found" as const };

    const nextStart = patch.startTime ?? existing.startTime;
    const nextEnd = patch.endTime ?? existing.endTime;
    if (nextEnd <= nextStart) {
      return { outcome: "invalid_range" as const };
    }

    const [row] = await tx
      .update(timetables)
      .set({
        ...(patch.dayOfWeek !== undefined ? { dayOfWeek: patch.dayOfWeek } : {}),
        ...(patch.startTime !== undefined ? { startTime: patch.startTime } : {}),
        ...(patch.endTime !== undefined ? { endTime: patch.endTime } : {}),
        ...(patch.room !== undefined ? { room: patch.room } : {}),
        ...(patch.trainerStaffProfileId !== undefined
          ? { trainerStaffProfileId: patch.trainerStaffProfileId }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(timetables.id, entryId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "updateTimetableEntry",
        entityType: "timetable",
        entityId: entryId,
        branchId: existing.branchId,
        before: toRecord(existing),
        after: toRecord(row),
      },
      tx,
    );

    return { outcome: "ok" as const, row };
  });

  if (result.outcome === "not_found") return { ok: false, error: ENTRY_NOT_FOUND };
  if (result.outcome === "invalid_range") {
    return {
      ok: false,
      error: { code: "validation", message: "End time must be after start time." },
    };
  }
  return { ok: true, entry: toRecord(result.row) };
}

export type DeleteTimetableEntryResult =
  | { ok: true }
  | { ok: false; error: TimetableActionError };

/** Real hard delete — see this file's module comment on why this one table
 * has no soft-delete column to fall back to. */
export async function deleteTimetableEntry(
  actorContext: AuthContext,
  entryId: string,
): Promise<DeleteTimetableEntryResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(entryId);
  if (!parsedId.success) return { ok: false, error: ENTRY_NOT_FOUND };

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(timetables)
      .where(and(eq(timetables.id, entryId), eq(timetables.academyId, academyId)))
      .for("update");
    if (!existing) return { outcome: "not_found" as const };

    const inScope = await assertBranchInScope(
      tx,
      academyId,
      membershipRole,
      actorContext.userId,
      existing.branchId,
    );
    if (!inScope) return { outcome: "not_found" as const };

    await tx.delete(timetables).where(eq(timetables.id, entryId));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteTimetableEntry",
        entityType: "timetable",
        entityId: entryId,
        branchId: existing.branchId,
        before: toRecord(existing),
      },
      tx,
    );

    return { outcome: "ok" as const };
  });

  if (result.outcome === "not_found") return { ok: false, error: ENTRY_NOT_FOUND };
  return { ok: true };
}
