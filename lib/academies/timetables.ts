import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { batches, branches, courses, staffBranchAssignments, staffProfiles, timetables } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime, type TimetableDay } from "@/lib/academies/timetable-constants";
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
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
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

// DAYS_OF_WEEK / DAY_LABELS / formatTimetableTime live in
// lib/academies/timetable-constants.ts — a pure, server/client-safe module
// — imported above and re-exported here so every existing server-side
// importer of this file keeps working unchanged. Client components (weekly
// grid, filters, print view) import directly from timetable-constants.ts
// instead of here, so they never pull this file's `pg`-dependent server
// code into the browser bundle (the exact mistake caught and fixed for the
// Books module's stock-status logic — see lib/academies/book-stock.ts).
export { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime, type TimetableDay };

// ===========================================================================
// Conflict detection (§9-10 of the approved review) — same resource + same
// day + overlapping time = conflict. Deliberately never compares across
// different `day_of_week` values. Checked inside the same transaction as
// the insert/update, before it commits, so a losing concurrent request sees
// the winner's already-committed row (same "check inside the transaction,
// not before it" shape as book-sales.ts's stock locking, though this uses a
// plain scoped SELECT rather than `FOR UPDATE` — see this function's own
// risk note in the approved review: a true race still needs a DB-level
// EXCLUDE constraint to close completely, which was deliberately deferred
// to a separate follow-up, not bundled into this change).
// ===========================================================================

export type TimetableConflictKind = "batch" | "instructor" | "room";

interface ConflictCandidate {
  academyId: string;
  branchId: string;
  batchId: string;
  dayOfWeek: (typeof DAYS_OF_WEEK)[number];
  startTime: string;
  endTime: string;
  room: string | null;
  trainerStaffProfileId: string | null;
  /** Excludes the entry itself when checking an UPDATE — otherwise every
   * update would "conflict" with its own prior row. */
  excludeEntryId?: string;
}

interface ConflictInfo {
  kind: TimetableConflictKind;
  /** The specific existing row this candidate collided with — enough detail
   * to build a message like "Wednesday conflicts with Batch 03 from
   * 10:00–12:00." rather than a generic "Conflict" (approved review §8). */
  entry: {
    batchId: string;
    startTime: string;
    endTime: string;
    trainerStaffProfileId: string | null;
    room: string | null;
  };
}

/**
 * Returns which resource conflicts first (batch checked before instructor
 * before room — batch overlap is the one case that's always meaningful,
 * since every entry has a batch; instructor/room are only checked when set,
 * since two unassigned entries never conflict with each other), along with
 * the conflicting row's own detail, or `null` if none do. Overlap test:
 * `existing.start < candidate.end AND candidate.start < existing.end`
 * (half-open interval overlap), scoped to the same academy and the same
 * day_of_week — this is what guarantees Monday never conflicts with
 * Wednesday.
 */
async function findTimetableConflict(
  executor: DbClient,
  candidate: ConflictCandidate,
): Promise<ConflictInfo | null> {
  function overlapScope(resourceCondition: ReturnType<typeof eq>) {
    const conditions = [
      eq(timetables.academyId, candidate.academyId),
      eq(timetables.dayOfWeek, candidate.dayOfWeek),
      sql`${timetables.startTime} < ${candidate.endTime}`,
      sql`${candidate.startTime} < ${timetables.endTime}`,
      resourceCondition,
    ];
    if (candidate.excludeEntryId) conditions.push(ne(timetables.id, candidate.excludeEntryId));
    return and(...conditions);
  }

  const conflictColumns = {
    batchId: timetables.batchId,
    startTime: timetables.startTime,
    endTime: timetables.endTime,
    trainerStaffProfileId: timetables.trainerStaffProfileId,
    room: timetables.room,
  };

  const [batchConflict] = await executor
    .select(conflictColumns)
    .from(timetables)
    .where(overlapScope(eq(timetables.batchId, candidate.batchId)))
    .limit(1);
  if (batchConflict) return { kind: "batch", entry: batchConflict };

  if (candidate.trainerStaffProfileId) {
    const [instructorConflict] = await executor
      .select(conflictColumns)
      .from(timetables)
      .where(overlapScope(eq(timetables.trainerStaffProfileId, candidate.trainerStaffProfileId)))
      .limit(1);
    if (instructorConflict) return { kind: "instructor", entry: instructorConflict };
  }

  if (candidate.room && candidate.room.trim().length > 0) {
    // Case/whitespace-insensitive match, scoped to the same branch — "Room
    // A" at Branch 1 never conflicts with "Room A" at Branch 2.
    const normalizedRoom = candidate.room.trim().toLowerCase();
    const [roomConflict] = await executor
      .select(conflictColumns)
      .from(timetables)
      .where(
        and(
          overlapScope(eq(timetables.branchId, candidate.branchId)),
          sql`lower(trim(${timetables.room})) = ${normalizedRoom}`,
        ),
      )
      .limit(1);
    if (roomConflict) return { kind: "room", entry: roomConflict };
  }

  return null;
}

/** Resolves a `ConflictInfo` into the specific, actionable message from the
 * approved review's §8 examples — a batch/instructor name lookup only ever
 * runs on the (rare) conflict path, never on a successful create. */
async function buildConflictMessage(
  executor: DbClient,
  dayOfWeek: (typeof DAYS_OF_WEEK)[number],
  conflict: ConflictInfo,
): Promise<string> {
  const dayLabel = DAY_LABELS[dayOfWeek];
  const timeRange = `${formatTimetableTime(conflict.entry.startTime)}–${formatTimetableTime(conflict.entry.endTime)}`;

  if (conflict.kind === "room") {
    return `${dayLabel} conflicts because ${conflict.entry.room} is already booked from ${timeRange}.`;
  }

  const [batch] = await executor
    .select({ name: batches.name })
    .from(batches)
    .where(eq(batches.id, conflict.entry.batchId))
    .limit(1);
  const batchName = batch?.name ?? "another batch";

  if (conflict.kind === "batch") {
    return `${dayLabel} conflicts with ${batchName} from ${timeRange}.`;
  }

  // instructor
  const [staff] = conflict.entry.trainerStaffProfileId
    ? await executor
        .select({ fullName: staffProfiles.fullName })
        .from(staffProfiles)
        .where(eq(staffProfiles.id, conflict.entry.trainerStaffProfileId))
        .limit(1)
    : [];
  const instructorName = staff?.fullName ?? "the instructor";
  return `${dayLabel} conflicts because ${instructorName} is already teaching ${batchName} from ${timeRange}.`;
}

// Fields shared by both the single-day and weekly creation schemas — kept
// in one place so they can never drift between the two (same
// branch/batch/time/room/instructor validation either way; the only real
// difference is one day vs. an array of days).
const timetableEntryBaseFields = {
  branchId: z.string().uuid("Select a branch"),
  batchId: z.string().uuid("Select a batch"),
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
};

export const createTimetableEntrySchema = z
  .object({
    ...timetableEntryBaseFields,
    dayOfWeek: z.enum(DAYS_OF_WEEK),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "End time must be after start time.",
    path: ["endTime"],
  });

export type CreateTimetableEntryInput = z.input<typeof createTimetableEntrySchema>;

/** §4/§12 of the approved review — a user checking the same day twice (or a
 * non-UI caller sending duplicates) must never produce duplicate rows; the
 * dedup happens before the "at least one day" check so an all-duplicate
 * submission is judged by its actual distinct day count. */
export const createWeeklyTimetableSchema = z
  .object({
    ...timetableEntryBaseFields,
    daysOfWeek: z
      .array(z.enum(DAYS_OF_WEEK))
      .transform((days) => [...new Set(days)])
      .refine((days) => days.length > 0, { message: "Select at least one teaching day." }),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "End time must be after start time.",
    path: ["endTime"],
  });

export type CreateWeeklyTimetableInput = z.input<typeof createWeeklyTimetableSchema>;

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

export type CreateWeeklyTimetableResult =
  | { ok: true; entries: TimetableEntryRecord[] }
  | { ok: false; error: TimetableActionError };

/**
 * The real creation path — §2-6 of the approved review. One row per
 * selected day, all inside one transaction: the batch is validated once,
 * the instructor (if any) is verified to belong to THIS academy once (a
 * genuine gap found during review — previously only checked "is a UUID"),
 * then every selected day is conflict-checked against the EXISTING data
 * before anything is inserted. If any day conflicts, the whole transaction
 * returns without writing a single row — Monday/Tuesday are never created
 * only for Wednesday to fail later. Only once every day has passed does the
 * actual multi-row insert happen.
 */
export async function createWeeklyTimetableEntries(
  actorContext: AuthContext,
  input: CreateWeeklyTimetableInput,
): Promise<CreateWeeklyTimetableResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createWeeklyTimetableSchema.safeParse(input);
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
      .select({ id: batches.id, branchId: batches.branchId })
      .from(batches)
      .where(and(eq(batches.id, data.batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!batch) return { outcome: "batch_not_found" as const };
    // A batch that exists but belongs to a DIFFERENT branch within the same
    // academy must be refused identically to a nonexistent batch — the
    // caller's branch scope for data.branchId was already verified above,
    // but that says nothing about which branch the batch itself belongs to.
    if (batch.branchId !== data.branchId) return { outcome: "batch_not_found" as const };

    // Previously-missing tenant check (approved review §9/§A): a staff
    // profile id was only ever validated as "a UUID" — never that it
    // belongs to THIS academy. Fixed here, once, for every day in the batch.
    if (data.trainerStaffProfileId) {
      const [staff] = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .where(and(eq(staffProfiles.id, data.trainerStaffProfileId), eq(staffProfiles.academyId, academyId)))
        .limit(1);
      if (!staff) return { outcome: "instructor_not_found" as const };
    }

    // Validate EVERY selected day before inserting anything — this is the
    // atomicity guarantee from §6/§4 of the approved review.
    for (const day of data.daysOfWeek) {
      const conflict = await findTimetableConflict(tx, {
        academyId,
        branchId: data.branchId,
        batchId: data.batchId,
        dayOfWeek: day,
        startTime: data.startTime,
        endTime: data.endTime,
        room: data.room,
        trainerStaffProfileId: data.trainerStaffProfileId,
      });
      if (conflict) {
        const message = await buildConflictMessage(tx, day, conflict);
        return { outcome: "conflict" as const, message };
      }
    }

    const rows = await tx
      .insert(timetables)
      .values(
        data.daysOfWeek.map((day) => ({
          academyId,
          branchId: data.branchId,
          batchId: data.batchId,
          dayOfWeek: day,
          startTime: data.startTime,
          endTime: data.endTime,
          room: data.room,
          trainerStaffProfileId: data.trainerStaffProfileId,
        })),
      )
      .returning();

    for (const row of rows) {
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
    }

    return { outcome: "ok" as const, rows };
  });

  if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
  if (result.outcome === "instructor_not_found") {
    return { ok: false, error: { code: "validation", message: "Selected instructor not found." } };
  }
  if (result.outcome === "conflict") {
    return { ok: false, error: { code: "conflict", message: result.message } };
  }
  return { ok: true, entries: result.rows.map(toRecord) };
}

export type CreateTimetableEntryResult =
  | { ok: true; entry: TimetableEntryRecord }
  | { ok: false; error: TimetableActionError };

/**
 * Thin wrapper over `createWeeklyTimetableEntries` with exactly one day
 * (approved review §10/Q2) — preserves this function's existing public
 * signature and return shape unchanged (every existing caller/test keeps
 * working), while inheriting the same validation, the same conflict
 * detection, and the instructor-academy-scoping fix automatically, so the
 * single-day and weekly paths can never drift apart into two different
 * behaviors for the same rules. Deliberately does NOT pre-parse `input`
 * itself (that's what `createWeeklyTimetableEntries` does, AFTER its own
 * permission check) — preserves the original "permission checked before
 * input is validated" ordering exactly, rather than validating untrusted
 * input before the caller is even known to be authorized.
 */
export async function createTimetableEntry(
  actorContext: AuthContext,
  input: CreateTimetableEntryInput,
): Promise<CreateTimetableEntryResult> {
  const { dayOfWeek, ...rest } = input;
  const result = await createWeeklyTimetableEntries(actorContext, {
    ...rest,
    daysOfWeek: dayOfWeek === undefined ? [] : [dayOfWeek],
  });
  if (!result.ok) return result;
  return { ok: true, entry: result.entries[0] };
}

export interface TimetableEntryWithBatch extends TimetableEntryRecord {
  batchName: string;
  /** Never a column on `timetables` itself — always derived via
   * `batch.course_id` (see this file's own module comment). Exposed here so
   * the weekly grid/filters/print view can filter by course without a
   * second query. */
  courseId: string;
  courseName: string;
  branchName: string;
  trainerName: string | null;
}

export type ListAcademyTimetableResult =
  | { ok: true; entries: TimetableEntryWithBatch[]; canManage: boolean }
  | { ok: false; error: TimetableActionError };

/** Academy-wide timetable view for `/academy/timetable` (PLAN.md §3 names
 * this one route, not a per-batch route) — every entry across every batch,
 * joined to the batch/course/branch/instructor names for display (course is
 * never its own column on `timetables` — it's always derived via
 * `batch.course_id`, since a batch already uniquely ties a course to a
 * branch; see the approved review's data-model section for why), filtered
 * to a branch-limited caller's assigned branch(es) the same way
 * listTimetableEntries is. */
export async function listAcademyTimetable(
  actorContext: AuthContext,
): Promise<ListAcademyTimetableResult> {
  const resolved = await resolveScopeAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const rows = await db
    .select({
      entry: timetables,
      batchName: batches.name,
      courseId: courses.id,
      courseName: courses.name,
      branchName: branches.name,
      trainerName: staffProfiles.fullName,
    })
    .from(timetables)
    .innerJoin(batches, eq(batches.id, timetables.batchId))
    .innerJoin(courses, eq(courses.id, batches.courseId))
    .innerJoin(branches, eq(branches.id, timetables.branchId))
    .leftJoin(staffProfiles, eq(staffProfiles.id, timetables.trainerStaffProfileId))
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
    entries: visible.map((row) => ({
      ...toRecord(row.entry),
      batchName: row.batchName,
      courseId: row.courseId,
      courseName: row.courseName,
      branchName: row.branchName,
      trainerName: row.trainerName,
    })),
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

    // Same previously-missing tenant check as createWeeklyTimetableEntries —
    // only applies when the patch actually sets a new instructor.
    if (patch.trainerStaffProfileId) {
      const [staff] = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .where(and(eq(staffProfiles.id, patch.trainerStaffProfileId), eq(staffProfiles.academyId, academyId)))
        .limit(1);
      if (!staff) return { outcome: "instructor_not_found" as const };
    }

    const nextDayOfWeek = patch.dayOfWeek ?? existing.dayOfWeek;
    const conflict = await findTimetableConflict(tx, {
      academyId,
      branchId: existing.branchId,
      batchId: existing.batchId,
      dayOfWeek: nextDayOfWeek,
      startTime: nextStart,
      endTime: nextEnd,
      room: patch.room !== undefined ? patch.room : existing.room,
      trainerStaffProfileId:
        patch.trainerStaffProfileId !== undefined ? patch.trainerStaffProfileId : existing.trainerStaffProfileId,
      excludeEntryId: entryId,
    });
    if (conflict) {
      const message = await buildConflictMessage(tx, nextDayOfWeek, conflict);
      return { outcome: "conflict" as const, message };
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
  if (result.outcome === "instructor_not_found") {
    return { ok: false, error: { code: "validation", message: "Selected instructor not found." } };
  }
  if (result.outcome === "conflict") {
    return { ok: false, error: { code: "conflict", message: result.message } };
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
