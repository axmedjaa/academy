import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { batchEnrollments, batches, courses, programs, staffProfiles, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_COURSES_BATCHES_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { checkAllowance, type UsageActionError } from "@/lib/subscriptions/usage";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 3, Item 43 — "`createCourse` (`checkAllowance('courses')`)."
 *
 * Same gating shape as lib/academies/programs.ts (read there for the full
 * Trainer judgment call): courses are academy-wide (no `branch_id` column),
 * so despite Trainer's "manage" level on `"academy.courses_batches"`,
 * Trainer is refused create/update/archive here — only Owner/Admin/Manager
 * may manage courses; Trainer and Admissions Officer (both non-"none"
 * levels) get the read-only list.
 *
 * `checkAllowance('courses')` is called inside the same transaction as the
 * insert (usage.ts's own documented seam for this — identical pattern to
 * createBranch/registerStudent) so the limit check and the row that would
 * push the academy over it can never race against each other.
 */
const TRAINER_ROLE: AcademyRole = "trainer";

function canManageCourses(role: AcademyRole, level: AcademyPermissionLevel): boolean {
  return (level === "full" || level === "manage") && role !== TRAINER_ROLE;
}

export interface CourseActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "allowance";
  message: string;
}

const FORBIDDEN: CourseActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's courses.",
};

const NOT_FOUND: CourseActionError = {
  code: "not_found",
  message: "Course not found.",
};

// Same generic-message IDOR-safety convention as BRANCH_NOT_FOUND in
// register-student.ts: "program doesn't exist" and "program belongs to
// another academy" must be indistinguishable to the caller.
const PROGRAM_NOT_FOUND: CourseActionError = {
  code: "not_found",
  message: "Program not found.",
};

// Same IDOR-safe convention, for the new instructorId FK.
const INSTRUCTOR_NOT_FOUND: CourseActionError = {
  code: "not_found",
  message: "Instructor not found.",
};

function optionalText(maxLength = 2000) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

// Plain "YYYY-MM-DD" string, same convention as register-student.ts's
// dateOfBirth / batches.ts's startDate for a `date` (not `timestamp`)
// column — optional (nullable at the DB level; see schema.ts's comment on
// why these two columns aren't NOT NULL), not required, matching every
// other non-identity field on this form (description/code/durationWeeks).
function optionalDate(maxLength = 20) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const createCourseSchema = z
  .object({
    programId: z.string().uuid("Select a program"),
    name: z.string().trim().min(1, "Course name is required").max(200),
    code: optionalText(50),
    description: optionalText(2000),
    durationWeeks: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) => {
        if (value === undefined || value === "") return undefined;
        const parsed = typeof value === "number" ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      })
      .refine((value) => value === undefined || (Number.isInteger(value) && value >= 0), {
        message: "Duration (weeks) must be a nonnegative whole number",
      }),
    startDate: optionalDate(),
    endDate: optionalDate(),
    // Plain externally-hosted-URL text field — same convention as
    // academies.logoRef / student_id_cards.photoFileRef (validated only as
    // "looks like a URL if provided," never uploaded/stored as a file).
    imageRef: optionalText(500),
    instructorId: z
      .string()
      .trim()
      .optional()
      .or(z.literal(""))
      .transform((value) => (value && value.length > 0 ? value : undefined))
      .refine((value) => value === undefined || z.string().uuid().safeParse(value).success, {
        message: "Select a valid instructor",
      }),
  })
  .refine((value) => !value.startDate || !value.endDate || value.endDate >= value.startDate, {
    message: "End date must be on or after the start date",
    path: ["endDate"],
  });

export type CreateCourseInput = z.input<typeof createCourseSchema>;
export type UpdateCourseInput = CreateCourseInput;

export interface CourseRecord {
  id: string;
  academyId: string;
  programId: string;
  name: string;
  code: string | null;
  description: string | null;
  durationWeeks: number | null;
  startDate: string | null;
  endDate: string | null;
  imageRef: string | null;
  instructorId: string | null;
  status: "active" | "archived";
  createdAt: Date;
}

function toRecord(row: typeof courses.$inferSelect): CourseRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    programId: row.programId,
    name: row.name,
    code: row.code,
    description: row.description,
    durationWeeks: row.durationWeeks,
    startDate: row.startDate,
    endDate: row.endDate,
    imageRef: row.imageRef,
    instructorId: row.instructorId,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** Display-only enrichment used by listCourses/getCourse — the instructor's
 * name, resolved via the existing staffProfiles identity (never a second
 * "instructor" concept). `null` when a course has no instructorId set. */
export interface CourseWithInstructor extends CourseRecord {
  instructorName: string | null;
}

async function attachInstructorNames(rows: CourseRecord[]): Promise<CourseWithInstructor[]> {
  const instructorIds = [...new Set(rows.map((r) => r.instructorId).filter((id): id is string => id !== null))];
  if (instructorIds.length === 0) {
    return rows.map((r) => ({ ...r, instructorName: null }));
  }

  const staffRows = await db
    .select({ id: staffProfiles.id, fullName: staffProfiles.fullName })
    .from(staffProfiles)
    .where(inArray(staffProfiles.id, instructorIds));
  const nameById = new Map(staffRows.map((s) => [s.id, s.fullName]));

  return rows.map((r) => ({ ...r, instructorName: r.instructorId ? (nameById.get(r.instructorId) ?? null) : null }));
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

interface ResolvedCourseAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveCourseAccessResult =
  | { ok: true; access: ResolvedCourseAccess }
  | { ok: false; error: CourseActionError };

async function resolveCourseAccess(
  actorContext: AuthContext,
): Promise<ResolveCourseAccessResult> {
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

async function programExistsInAcademy(
  executor: DbClient,
  academyId: string,
  programId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.academyId, academyId)))
    .limit(1);
  return Boolean(row);
}

/** Same IDOR-safe tenant check as programExistsInAcademy — an instructor is
 * just a staffProfiles row, reused unmodified (no new "instructor" table). */
async function instructorExistsInAcademy(
  executor: DbClient,
  academyId: string,
  instructorId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.id, instructorId), eq(staffProfiles.academyId, academyId)))
    .limit(1);
  return Boolean(row);
}

export type ListCoursesResult =
  | { ok: true; courses: CourseWithInstructor[]; canManage: boolean }
  | { ok: false; error: CourseActionError };

export async function listCourses(actorContext: AuthContext): Promise<ListCoursesResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const rows = await db.select().from(courses).where(eq(courses.academyId, academyId));

  return {
    ok: true,
    courses: await attachInstructorNames(rows.map(toRecord)),
    canManage: canManageCourses(membershipRole, permissionLevel),
  };
}

export type GetCourseResult =
  | { ok: true; course: CourseWithInstructor }
  | { ok: false; error: CourseActionError };

export async function getCourse(
  actorContext: AuthContext,
  courseId: string,
): Promise<GetCourseResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(courseId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const [row] = await db
    .select()
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.academyId, academyId)))
    .limit(1);
  if (!row) {
    return { ok: false, error: NOT_FOUND };
  }

  const [withInstructor] = await attachInstructorNames([toRecord(row)]);
  return { ok: true, course: withInstructor };
}

export interface CourseEnrollmentRow {
  studentId: string;
  studentFullName: string;
  studentNumber: string;
  batchId: string;
  batchName: string;
  status: "active" | "withdrawn" | "completed";
}

export type ListCourseEnrollmentsResult =
  | { ok: true; enrollments: CourseEnrollmentRow[] }
  | { ok: false; error: CourseActionError };

/**
 * Admin-only "who's enrolled in this course" view (DESIGN's course-details
 * page). Reuses the existing Student -> Batch -> Course relationship
 * exactly as already built (batch_enrollments + batches.course_id) —
 * aggregates across every batch of this course rather than introducing a
 * direct course<->student table. Every status is included (not just
 * "active") so the admin sees the full picture, same "full history, not
 * just the live state" convention as listBatchEnrollments in
 * lib/academies/batch-assignments.ts.
 */
export async function listCourseEnrollments(
  actorContext: AuthContext,
  courseId: string,
): Promise<ListCourseEnrollmentsResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(courseId);
  if (!parsedId.success) return { ok: false, error: NOT_FOUND };

  const [course] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.academyId, academyId)))
    .limit(1);
  if (!course) return { ok: false, error: NOT_FOUND };

  const rows = await db
    .select({
      studentId: students.id,
      studentFullName: students.fullName,
      studentNumber: students.studentNumber,
      batchId: batches.id,
      batchName: batches.name,
      status: batchEnrollments.status,
    })
    .from(batchEnrollments)
    .innerJoin(batches, eq(batches.id, batchEnrollments.batchId))
    .innerJoin(students, eq(students.id, batchEnrollments.studentId))
    .where(and(eq(batches.courseId, courseId), eq(batches.academyId, academyId)));

  return { ok: true, enrollments: rows };
}

class AllowanceLimitReached extends Error {
  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super("Course allowance limit reached.");
  }
}

class AllowanceCheckFailure extends Error {
  constructor(public readonly usageError: UsageActionError) {
    super(usageError.message);
  }
}

class ProgramNotFoundSignal extends Error {}
class InstructorNotFoundSignal extends Error {}

export type CreateCourseResult =
  | { ok: true; course: CourseRecord }
  | { ok: false; error: CourseActionError };

/**
 * PLAN.md §4: `createCourse` (`checkAllowance('courses')`). `programId`
 * must belong to the caller's own academy — a cross-academy or nonexistent
 * id returns the identical generic `not_found`, never a distinguishing
 * `forbidden`, matching every other tenant-scoped FK check in this
 * codebase (e.g. register-student.ts's branchId check).
 */
export async function createCourse(
  actorContext: AuthContext,
  input: CreateCourseInput,
): Promise<CreateCourseResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManageCourses(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createCourseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const programOk = await programExistsInAcademy(tx, academyId, data.programId);
      if (!programOk) {
        throw new ProgramNotFoundSignal();
      }
      if (data.instructorId && !(await instructorExistsInAcademy(tx, academyId, data.instructorId))) {
        throw new InstructorNotFoundSignal();
      }

      const allowance = await checkAllowance(academyId, "courses", tx);
      if (!allowance.ok) {
        throw new AllowanceCheckFailure(allowance.error);
      }
      if (!allowance.result.allowed) {
        throw new AllowanceLimitReached(allowance.result.current, allowance.result.limit);
      }

      const [row] = await tx
        .insert(courses)
        .values({
          academyId,
          programId: data.programId,
          name: data.name,
          code: data.code,
          description: data.description,
          durationWeeks: data.durationWeeks,
          startDate: data.startDate,
          endDate: data.endDate,
          imageRef: data.imageRef,
          instructorId: data.instructorId,
        })
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createCourse",
          entityType: "course",
          entityId: row.id,
          after: toRecord(row),
        },
        tx,
      );

      return row;
    });

    return { ok: true, course: toRecord(result) };
  } catch (err) {
    if (err instanceof ProgramNotFoundSignal) {
      return { ok: false, error: PROGRAM_NOT_FOUND };
    }
    if (err instanceof InstructorNotFoundSignal) {
      return { ok: false, error: INSTRUCTOR_NOT_FOUND };
    }
    if (err instanceof AllowanceLimitReached) {
      return {
        ok: false,
        error: {
          code: "allowance",
          message: `This academy has reached its plan's course limit (${err.current}/${err.limit}). Archive an existing course or upgrade the plan to add another.`,
        },
      };
    }
    if (err instanceof AllowanceCheckFailure) {
      return { ok: false, error: { code: "validation", message: err.usageError.message } };
    }
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A course with that name already exists for this academy." },
      };
    }
    throw err;
  }
}

export type UpdateCourseResult =
  | { ok: true; course: CourseRecord }
  | { ok: false; error: CourseActionError };

export async function updateCourse(
  actorContext: AuthContext,
  courseId: string,
  input: UpdateCourseInput,
): Promise<UpdateCourseResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManageCourses(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(courseId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const parsed = createCourseSchema.safeParse(input);
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
        .from(courses)
        .where(and(eq(courses.id, courseId), eq(courses.academyId, academyId)))
        .limit(1);
      if (!existing) return null;

      const programOk = await programExistsInAcademy(tx, academyId, data.programId);
      if (!programOk) {
        throw new ProgramNotFoundSignal();
      }
      if (data.instructorId && !(await instructorExistsInAcademy(tx, academyId, data.instructorId))) {
        throw new InstructorNotFoundSignal();
      }

      const [updated] = await tx
        .update(courses)
        .set({
          programId: data.programId,
          name: data.name,
          code: data.code,
          description: data.description,
          durationWeeks: data.durationWeeks,
          startDate: data.startDate ?? null,
          endDate: data.endDate ?? null,
          imageRef: data.imageRef ?? null,
          instructorId: data.instructorId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(courses.id, courseId))
        .returning();

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "updateCourse",
          entityType: "course",
          entityId: courseId,
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
    return { ok: true, course: toRecord(result) };
  } catch (err) {
    if (err instanceof ProgramNotFoundSignal) {
      return { ok: false, error: PROGRAM_NOT_FOUND };
    }
    if (err instanceof InstructorNotFoundSignal) {
      return { ok: false, error: INSTRUCTOR_NOT_FOUND };
    }
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: { code: "conflict", message: "A course with that name already exists for this academy." },
      };
    }
    throw err;
  }
}

export type ArchiveCourseResult =
  | { ok: true; course: CourseRecord }
  | { ok: false; error: CourseActionError };

/** No hard delete — frees the course allowance slot: countCourses
 * (lib/subscriptions/usage.ts) filters on status = "active", so an
 * archived course simply stops being counted. Idempotent. */
export async function archiveCourse(
  actorContext: AuthContext,
  courseId: string,
): Promise<ArchiveCourseResult> {
  const resolved = await resolveCourseAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManageCourses(membershipRole, permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(courseId);
  if (!parsedId.success) {
    return { ok: false, error: NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(courses)
      .where(and(eq(courses.id, courseId), eq(courses.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(courses)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(courses.id, courseId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "archiveCourse",
        entityType: "course",
        entityId: courseId,
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
  return { ok: true, course: toRecord(result) };
}
