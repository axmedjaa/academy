import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  batchEnrollments,
  batches,
  examResults,
  exams,
  gradeConfigurations,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBatchIds } from "@/lib/academies/batch-assignments";
import {
  ACADEMY_EXAMS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * PLAN.md Phase 3, Item 48 — "`exams`/`exam_results` migration +
 * `createExam`/`enterMarks` with trainer-batch scoping."
 *
 * ---------------------------------------------------------------------
 * Scope: what this item builds vs. what it deliberately does not
 * ---------------------------------------------------------------------
 * The Result Lifecycle table (PLAN.md, Lifecycle & State-Transition
 * Tables) has SEVEN transitions; this item builds exactly the first two
 * ("— -> Draft" via `createExam`, "Draft -> Marks Entered" via
 * `enterMarks`). `submitResults`/`approveResult`/`rejectResult`/
 * `publishResults`/`requestResultCorrection` (Marks Entered onward) are
 * Item 49, a separate later item — not built here, per this item's own
 * brief. `listExams`/`getExam`/`listExamResults` are read helpers this
 * item adds for the minimal `/academy/exams` UI and for Item 49 to reuse.
 *
 * ---------------------------------------------------------------------
 * grade_configuration_id timing — see lib/db/schema.ts's comment on
 * `examResults` for the full reasoning; summarized here:
 * ---------------------------------------------------------------------
 * `createExam` implicitly creates a `Draft` `exam_results` row per
 * *actively enrolled* student in the exam's batch (Result Lifecycle
 * table's own words), and that column is NOT NULL — so `createExam`, not
 * `enterMarks`, is what must resolve the academy's currently `active`
 * grade_configuration and stamp it onto every row it creates. This is a
 * hard precondition: `createExam` refuses outright (a `validation` error)
 * if the academy has no `active` grade_configuration yet, rather than
 * silently creating an exam with no valid results underneath it.
 * `enterMarks` never rewrites this column for a pre-existing row (it's a
 * placeholder that Item 49's `publishResults` is expected to re-stamp with
 * whatever is active at the actual moment of publish, per that column's
 * "snapshotted at publish time" wording) — the one exception is the
 * late-enrollment edge case documented on `enterMarks` below, where it
 * must insert a fresh row itself and so needs the same value from the same
 * source, under the same precondition.
 *
 * `pass_fail`/`grade_band_label` are left at their schema defaults
 * (`pending`/`null`) by every write in this file — evaluating marks against
 * grade_bands is publish/approval-adjacent machinery (Item 49), not marks
 * entry, per PLAN.md's own default value and its "Published results are
 * locked" framing of when these fields actually get their real values.
 *
 * ---------------------------------------------------------------------
 * Permission row: NEW, not reused — "Exam mark entry"
 * ---------------------------------------------------------------------
 * See lib/auth/academy-permissions.ts's `ACADEMY_EXAMS_ACTION` comment for
 * the full reasoning. Two distinct gates in this file:
 *   - `canManage` (full/manage: Owner/Admin/Manager) — `createExam` only.
 *     A Trainer's "enter_marks" level fails this check outright: per the
 *     matrix's literal wording ("Enter marks (assigned batches only)"), a
 *     Trainer may never create an exam, only enter marks into one that
 *     already exists.
 *   - `canEnterMarks` (full/manage/enter_marks) — `enterMarks` only. Wider
 *     than `canManage` by exactly the Trainer level, matching the Result
 *     Lifecycle table's Draft -> Marks Entered actor column ("Trainer
 *     (assigned batch only) / Manager / Admin / Owner").
 *
 * ---------------------------------------------------------------------
 * Trainer-batch scoping — NOT the branch-based scoping used elsewhere
 * ---------------------------------------------------------------------
 * Every other branch-limited row in this codebase (Courses/batches,
 * Students, Staff, Student ID cards, ...) scopes a Trainer/Admissions
 * Officer via `staff_branch_assignments` (which *branch* they're assigned
 * to). This row is different: the matrix's "assigned" scope for "Exam mark
 * entry" means "batches this Trainer is assigned to teach" via
 * `batch_trainer_assignments` — exactly what lib/academies/
 * batch-assignments.ts's exported `getAssignedBatchIds(executor, userId,
 * academyId)` builds (that file's own module comment names this exact use
 * case as its forward-looking reason for existing). `enterMarks` imports
 * and calls that function directly; it does not add "trainer" to any
 * `BRANCH_LIMITED_ROLES`-style set or touch `staffBranchAssignments` at
 * all. A Trainer whose exam's batch isn't in that set gets the identical
 * generic `EXAM_NOT_FOUND` a nonexistent or cross-academy exam id would —
 * the same IDOR-safe convention every scoped lookup in this codebase uses,
 * so a guessed exam id on an out-of-scope batch can't be distinguished
 * from one that doesn't exist.
 *
 * ---------------------------------------------------------------------
 * (exam_id, student_id) uniqueness — update-in-place, with a late-
 * enrollment upsert fallback
 * ---------------------------------------------------------------------
 * Because `createExam` already creates one `Draft` `exam_results` row per
 * actively-enrolled student, the normal `enterMarks` path for a given
 * student is an UPDATE of that pre-existing row (marks_obtained, status ->
 * `marks_entered`, entered_by -> the actual person entering marks) — never
 * a fresh insert, and so never a real conflict on the unique index in the
 * common case. The one case where no row exists yet is a student enrolled
 * *after* `createExam` already ran: `enterMarks` treats that as a genuine
 * edge case, not an error — it verifies the student has an active
 * `batch_enrollments` row for this exam's batch, then inserts a fresh
 * `exam_results` row itself (going straight to `marks_entered`, skipping
 * `draft`, since marks are being entered in the same call that creates the
 * row), using the same active-grade-configuration precondition
 * `createExam` uses. `isUniqueViolation()` is still applied around the
 * whole transaction (same pattern as lib/academies/batch-assignments.ts)
 * as a last-resort race guard for two concurrent `enterMarks` calls
 * targeting the same not-yet-existing row — an edge case genuinely
 * possible here (unlike, say, `assignTrainerToBatch`'s conflict, which is
 * the *expected*, common-case error), so it's surfaced as `conflict`
 * asking the caller to retry, not silently swallowed.
 *
 * Re-entering marks for a student who already has a `draft` or
 * `marks_entered` row is a plain idempotent update (last write wins) — not
 * a conflict. Once a row has moved past `marks_entered` (submitted or
 * later — Item 49's territory), `enterMarks` refuses with `invalid_state`:
 * this file owns exactly one transition (Draft -> Marks Entered) and must
 * not silently resurrect a row Item 49's workflow has already moved on.
 *
 * ---------------------------------------------------------------------
 * marks_obtained <= max_marks — an addition beyond the literal spec
 * ---------------------------------------------------------------------
 * PLAN.md's column list for `exam_results` never states this rule
 * explicitly. Added here defensively (judgment call, documented per this
 * codebase's convention of adding a reasonable integrity check where none
 * is stated — see e.g. grade_bands' exclusion constraint pre-check): a
 * mark that exceeds the exam's own `max_marks` is never meaningful. Not
 * expressible as a plain Postgres `check` constraint (it's cross-table —
 * `exam_results.marks_obtained` vs. `exams.max_marks` — which would need a
 * trigger, not a `check()` builder), so it's enforced here in
 * `enterMarks`, before any row is written, and rejects the whole call with
 * a `validation` error rather than silently clamping the value.
 *
 * ---------------------------------------------------------------------
 * exams.status: a light touch, not this item's main concern
 * ---------------------------------------------------------------------
 * `exams.status` (scheduled/marks_entry/completed/archived) is a separate
 * enum from `exam_results.status` and PLAN.md never names an action that
 * flips it. Judgment call: `enterMarks` bumps a `scheduled` exam to
 * `marks_entry` the first time marks are entered (a natural, low-risk
 * reflection of "marks entry has begun" that doesn't block anything) —
 * `completed`/`archived` are left alone entirely; nothing in this item's
 * scope (createExam/enterMarks) has a reason to set either.
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage";
}

/** Wider than `canManage` by exactly the Trainer level — see this file's
 * module comment on the two distinct gates this item uses. */
function canEnterMarksLevel(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage" || level === "enter_marks";
}

export interface ExamActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict" | "invalid_state" | "ineligible";
  message: string;
}

const FORBIDDEN: ExamActionError = {
  code: "forbidden",
  message: "You don't have permission to manage this academy's exams.",
};

// Same generic-message IDOR-safety convention as every other scoped lookup
// in this codebase: nonexistent, cross-academy, and out-of-scope-for-a-
// trainer all indistinguishable, including for a guessed id.
const EXAM_NOT_FOUND: ExamActionError = {
  code: "not_found",
  message: "Exam not found.",
};

const BATCH_NOT_FOUND: ExamActionError = {
  code: "not_found",
  message: "Batch not found.",
};

const NO_ACTIVE_GRADE_CONFIG: ExamActionError = {
  code: "validation",
  message:
    "This academy has no active grade configuration yet. Activate one before creating exams or entering marks.",
};

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

interface ResolvedExamAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveExamAccessResult =
  | { ok: true; access: ResolvedExamAccess }
  | { ok: false; error: ExamActionError };

async function resolveExamAccess(actorContext: AuthContext): Promise<ResolveExamAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_EXAMS_ACTION);
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

/** Resolves the academy's one `active` grade_configuration, or `null` if it
 * has none — the hard precondition both `createExam` and `enterMarks`'s
 * late-enrollment path share (see this file's module comment). */
async function getActiveGradeConfigurationId(
  executor: DbClient,
  academyId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ id: gradeConfigurations.id })
    .from(gradeConfigurations)
    .where(and(eq(gradeConfigurations.academyId, academyId), eq(gradeConfigurations.status, "active")))
    .limit(1);
  return row?.id ?? null;
}

export const createExamSchema = z.object({
  batchId: z.string().uuid("Select a batch"),
  name: z.string().trim().min(1, "Exam name is required").max(200),
  // PLAN.md states only "NOT NULL" for max_marks (no explicit minimum
  // beyond the DB's own nonnegativity check) — a positive-number
  // requirement is a judgment call, documented per this codebase's
  // convention of adding a reasonable integrity check where PLAN.md is
  // silent: an exam worth zero marks is not meaningful.
  maxMarks: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, {
      message: "maxMarks must be a positive number",
    }),
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
});

export type CreateExamInput = z.input<typeof createExamSchema>;

export interface ExamRecord {
  id: string;
  academyId: string;
  batchId: string;
  name: string;
  maxMarks: number;
  examDate: string | null;
  status: "scheduled" | "marks_entry" | "completed" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

function toExamRecord(row: typeof exams.$inferSelect): ExamRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    batchId: row.batchId,
    name: row.name,
    maxMarks: Number(row.maxMarks),
    examDate: row.examDate,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ExamResultRecord {
  id: string;
  academyId: string;
  examId: string;
  studentId: string;
  batchId: string;
  marksObtained: number | null;
  gradeConfigurationId: string;
  gradeBandLabel: string | null;
  passFail: "pending" | "pass" | "fail";
  status: "draft" | "marks_entered" | "submitted" | "under_review" | "approved" | "rejected" | "published";
  enteredBy: string;
  submittedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toResultRecord(row: typeof examResults.$inferSelect): ExamResultRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    examId: row.examId,
    studentId: row.studentId,
    batchId: row.batchId,
    marksObtained: row.marksObtained !== null ? Number(row.marksObtained) : null,
    gradeConfigurationId: row.gradeConfigurationId,
    gradeBandLabel: row.gradeBandLabel,
    passFail: row.passFail,
    status: row.status,
    enteredBy: row.enteredBy,
    submittedAt: row.submittedAt,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CreateExamResult =
  | { ok: true; exam: ExamRecord; resultCount: number }
  | { ok: false; error: ExamActionError };

/**
 * PLAN.md §4: `createExam`. Only "full"/"manage" (Owner/Admin/Manager) may
 * create — a Trainer's "enter_marks" level is refused here even though it
 * can call `enterMarks` on the resulting exam. Implicitly creates one
 * `Draft` `exam_results` row per actively-enrolled student in the batch
 * (Result Lifecycle table's "— -> Draft" row), stamping each with the
 * academy's current `active` grade_configuration — see this file's module
 * comment for why that happens here and not in `enterMarks`. Refuses
 * outright if the academy has no `active` grade_configuration.
 */
export async function createExam(
  actorContext: AuthContext,
  input: CreateExamInput,
): Promise<CreateExamResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = createExamSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select({ id: batches.id, branchId: batches.branchId })
      .from(batches)
      .where(and(eq(batches.id, data.batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!batch) return { outcome: "batch_not_found" as const };

    const activeGradeConfigurationId = await getActiveGradeConfigurationId(tx, academyId);
    if (!activeGradeConfigurationId) {
      return { outcome: "no_active_grade_config" as const };
    }

    const [examRow] = await tx
      .insert(exams)
      .values({
        academyId,
        batchId: data.batchId,
        name: data.name,
        maxMarks: String(data.maxMarks),
        examDate: data.examDate,
      })
      .returning();

    const enrollments = await tx
      .select({ studentId: batchEnrollments.studentId })
      .from(batchEnrollments)
      .where(and(eq(batchEnrollments.batchId, data.batchId), eq(batchEnrollments.status, "active")));

    const resultRows =
      enrollments.length === 0
        ? []
        : await tx
            .insert(examResults)
            .values(
              enrollments.map((enrollment) => ({
                academyId,
                examId: examRow.id,
                studentId: enrollment.studentId,
                batchId: data.batchId,
                gradeConfigurationId: activeGradeConfigurationId,
                enteredBy: actorContext.userId,
              })),
            )
            .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "createExam",
        entityType: "exam",
        entityId: examRow.id,
        branchId: batch.branchId,
        after: { ...toExamRecord(examRow), draftResultCount: resultRows.length },
      },
      tx,
    );

    return { outcome: "ok" as const, exam: examRow, resultCount: resultRows.length };
  });

  if (result.outcome === "batch_not_found") return { ok: false, error: BATCH_NOT_FOUND };
  if (result.outcome === "no_active_grade_config") return { ok: false, error: NO_ACTIVE_GRADE_CONFIG };
  return { ok: true, exam: toExamRecord(result.exam), resultCount: result.resultCount };
}

export const enterMarksEntrySchema = z.object({
  studentId: z.string().uuid("Invalid studentId"),
  marksObtained: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= 0, {
      message: "marksObtained must be a nonnegative number",
    }),
});

export const enterMarksSchema = z
  .array(enterMarksEntrySchema)
  .min(1, "At least one mark entry is required.");

export type EnterMarksInput = z.input<typeof enterMarksSchema>;

export type EnterMarksResult =
  | { ok: true; results: ExamResultRecord[] }
  | { ok: false; error: ExamActionError };

/**
 * PLAN.md §4: `enterMarks` (partial or full — a caller may enter marks for
 * any subset of the exam's roster in one call). Result Lifecycle table:
 * `Draft -> Marks Entered`, actor "Trainer (assigned batch only) / Manager
 * / Admin / Owner" — gated on `canEnterMarksLevel`, and for a Trainer
 * specifically, further scoped to `getAssignedBatchIds` (see this file's
 * module comment on why that's NOT the branch-based scoping used
 * elsewhere). The whole call is one transaction: if any entry fails
 * validation (wrong exam/batch, marks exceeding max_marks, a result
 * already past `marks_entered`, an unenrolled student), the entire batch
 * of entries is rejected — a deliberate all-or-nothing judgment call, not
 * a best-effort partial write, so a caller never has to reconcile which
 * subset of a submitted roster actually landed.
 */
export async function enterMarks(
  actorContext: AuthContext,
  examId: string,
  input: EnterMarksInput,
): Promise<EnterMarksResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canEnterMarksLevel(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedExamId = z.string().uuid().safeParse(examId);
  if (!parsedExamId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const parsed = enterMarksSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }
  const entries = parsed.data;

  const studentIds = entries.map((entry) => entry.studentId);
  if (new Set(studentIds).size !== studentIds.length) {
    return {
      ok: false,
      error: { code: "validation", message: "Duplicate studentId in the same enterMarks call." },
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [exam] = await tx
        .select()
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
        .for("update");
      if (!exam) return { outcome: "exam_not_found" as const };

      // Trainer-batch scoping — see this file's module comment: NOT
      // staff_branch_assignments, but batch_trainer_assignments via the
      // exact helper Item 44 built for this purpose.
      if (membershipRole === "trainer") {
        const assignedBatchIds = await getAssignedBatchIds(tx, actorContext.userId, academyId);
        if (!assignedBatchIds.includes(exam.batchId)) {
          // Same generic not_found as a nonexistent/cross-academy exam —
          // an IDOR-safe response, never a distinguishing "forbidden".
          return { outcome: "exam_not_found" as const };
        }
      }

      const maxMarks = Number(exam.maxMarks);
      for (const entry of entries) {
        if (entry.marksObtained > maxMarks) {
          return { outcome: "invalid_marks" as const, studentId: entry.studentId, maxMarks };
        }
      }

      const before: ExamResultRecord[] = [];
      const after: ExamResultRecord[] = [];

      for (const entry of entries) {
        const [existing] = await tx
          .select()
          .from(examResults)
          .where(and(eq(examResults.examId, examId), eq(examResults.studentId, entry.studentId)))
          .for("update");

        if (existing) {
          if (existing.status !== "draft" && existing.status !== "marks_entered") {
            return {
              outcome: "invalid_state" as const,
              studentId: entry.studentId,
              status: existing.status,
            };
          }

          before.push(toResultRecord(existing));
          const [updated] = await tx
            .update(examResults)
            .set({
              marksObtained: String(entry.marksObtained),
              status: "marks_entered",
              enteredBy: actorContext.userId,
              updatedAt: new Date(),
            })
            .where(eq(examResults.id, existing.id))
            .returning();
          after.push(toResultRecord(updated));
          continue;
        }

        // Late-enrollment edge case — see this file's module comment.
        const [enrollment] = await tx
          .select({ id: batchEnrollments.id })
          .from(batchEnrollments)
          .where(
            and(
              eq(batchEnrollments.batchId, exam.batchId),
              eq(batchEnrollments.studentId, entry.studentId),
              eq(batchEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (!enrollment) {
          return { outcome: "student_not_enrolled" as const, studentId: entry.studentId };
        }

        const activeGradeConfigurationId = await getActiveGradeConfigurationId(tx, academyId);
        if (!activeGradeConfigurationId) {
          return { outcome: "no_active_grade_config" as const };
        }

        const [inserted] = await tx
          .insert(examResults)
          .values({
            academyId,
            examId,
            studentId: entry.studentId,
            batchId: exam.batchId,
            marksObtained: String(entry.marksObtained),
            gradeConfigurationId: activeGradeConfigurationId,
            status: "marks_entered",
            enteredBy: actorContext.userId,
          })
          .returning();
        after.push(toResultRecord(inserted));
      }

      // A light touch on the exam's own status — see this file's module
      // comment. Never downgrades marks_entry/completed/archived.
      if (exam.status === "scheduled") {
        await tx
          .update(exams)
          .set({ status: "marks_entry", updatedAt: new Date() })
          .where(eq(exams.id, examId));
      }

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "enterMarks",
          entityType: "exam",
          entityId: examId,
          before,
          after,
        },
        tx,
      );

      return { outcome: "ok" as const, results: after };
    });

    if (result.outcome === "exam_not_found") return { ok: false, error: EXAM_NOT_FOUND };
    if (result.outcome === "no_active_grade_config") {
      return { ok: false, error: NO_ACTIVE_GRADE_CONFIG };
    }
    if (result.outcome === "invalid_marks") {
      return {
        ok: false,
        error: {
          code: "validation",
          message: `marksObtained for student ${result.studentId} exceeds this exam's max_marks (${result.maxMarks}).`,
        },
      };
    }
    if (result.outcome === "invalid_state") {
      return {
        ok: false,
        error: {
          code: "invalid_state",
          message: `Marks can no longer be entered for student ${result.studentId} — this result is already ${result.status}.`,
        },
      };
    }
    if (result.outcome === "student_not_enrolled") {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Student ${result.studentId} is not actively enrolled in this exam's batch.`,
        },
      };
    }
    return { ok: true, results: result.results };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "A mark entry for one of these students was just created concurrently — please retry.",
        },
      };
    }
    throw err;
  }
}

export type ListExamsResult =
  | { ok: true; exams: (ExamRecord & { hasResults: boolean })[]; canManage: boolean; canEnterMarks: boolean }
  | { ok: false; error: ExamActionError };

/** Lists exams for the academy, optionally filtered to one batch. A
 * Trainer only ever sees exams on batches they're assigned to teach (via
 * `getAssignedBatchIds`) — the same scoping `enterMarks` enforces, applied
 * here defensively so `/academy/exams` never even lists an out-of-scope
 * exam for a Trainer to attempt against. */
export async function listExams(
  actorContext: AuthContext,
  batchId?: string,
): Promise<ListExamsResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  let allowedBatchIds: string[] | null = null;
  if (membershipRole === "trainer") {
    allowedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
  }

  if (batchId !== undefined) {
    const parsedId = z.string().uuid().safeParse(batchId);
    if (!parsedId.success) return { ok: false, error: BATCH_NOT_FOUND };
    if (allowedBatchIds && !allowedBatchIds.includes(batchId)) {
      return { ok: false, error: BATCH_NOT_FOUND };
    }
    const [batch] = await db
      .select({ id: batches.id })
      .from(batches)
      .where(and(eq(batches.id, batchId), eq(batches.academyId, academyId)))
      .limit(1);
    if (!batch) return { ok: false, error: BATCH_NOT_FOUND };
  }

  const conditions = batchId !== undefined
    ? and(eq(exams.academyId, academyId), eq(exams.batchId, batchId))
    : eq(exams.academyId, academyId);

  const rows = await db.select().from(exams).where(conditions);
  const visible = allowedBatchIds ? rows.filter((row) => allowedBatchIds!.includes(row.batchId)) : rows;

  // Bulk-computed for the "Delete" row action's eligibility (deleteExam
  // below refuses outright unless this is false) — one query for the whole
  // list rather than N+1 per row.
  const idsWithResults =
    visible.length > 0
      ? new Set(
          (
            await db
              .selectDistinct({ examId: examResults.examId })
              .from(examResults)
              .where(inArray(examResults.examId, visible.map((row) => row.id)))
          ).map((row) => row.examId),
        )
      : new Set<string>();

  return {
    ok: true,
    exams: visible.map((row) => ({ ...toExamRecord(row), hasResults: idsWithResults.has(row.id) })),
    canManage: canManage(permissionLevel),
    canEnterMarks: canEnterMarksLevel(permissionLevel),
  };
}

export type GetExamResult =
  | { ok: true; exam: ExamRecord; canManage: boolean; canEnterMarks: boolean }
  | { ok: false; error: ExamActionError };

/** Tenant- and (for a Trainer) batch-scoped single read. IDOR-safe:
 * nonexistent, cross-academy, and out-of-scope-for-a-trainer ids all
 * return the identical generic `EXAM_NOT_FOUND`. */
export async function getExam(actorContext: AuthContext, examId: string): Promise<GetExamResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const [row] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
    .limit(1);
  if (!row) return { ok: false, error: EXAM_NOT_FOUND };

  if (membershipRole === "trainer") {
    const assignedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
    if (!assignedBatchIds.includes(row.batchId)) return { ok: false, error: EXAM_NOT_FOUND };
  }

  return {
    ok: true,
    exam: toExamRecord(row),
    canManage: canManage(permissionLevel),
    canEnterMarks: canEnterMarksLevel(permissionLevel),
  };
}

export interface ExamResultRosterRow extends ExamResultRecord {
  studentFullName: string;
  studentNumber: string;
}

export type ListExamResultsResult =
  | { ok: true; exam: ExamRecord; results: ExamResultRosterRow[]; canEnterMarks: boolean }
  | { ok: false; error: ExamActionError };

/** Roster read for one exam — every `exam_results` row (every status, for a
 * full picture), joined to `students` for a display name/number. Scoped
 * identically to `getExam` (tenant + Trainer batch-scoping). */
export async function listExamResults(
  actorContext: AuthContext,
  examId: string,
): Promise<ListExamResultsResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const [examRow] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
    .limit(1);
  if (!examRow) return { ok: false, error: EXAM_NOT_FOUND };

  if (membershipRole === "trainer") {
    const assignedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
    if (!assignedBatchIds.includes(examRow.batchId)) return { ok: false, error: EXAM_NOT_FOUND };
  }

  const rows = await db
    .select({
      result: examResults,
      studentFullName: students.fullName,
      studentNumber: students.studentNumber,
    })
    .from(examResults)
    .innerJoin(students, eq(students.id, examResults.studentId))
    .where(eq(examResults.examId, examId));

  return {
    ok: true,
    exam: toExamRecord(examRow),
    results: rows.map((row) => ({
      ...toResultRecord(row.result),
      studentFullName: row.studentFullName,
      studentNumber: row.studentNumber,
    })),
    canEnterMarks: canEnterMarksLevel(permissionLevel),
  };
}

export type ArchiveExamResult =
  | { ok: true; exam: ExamRecord }
  | { ok: false; error: ExamActionError };

/**
 * No hard delete — `status = archived` is the removal path, same
 * convention as archiveCourse/archiveProgram/archiveBatch. This file's own
 * module comment on `exams.status` notes createExam/enterMarks never had a
 * reason to touch `completed`/`archived`; this is the first action that
 * does. Archiving only ever changes `exams.status` — it never touches
 * `exam_results` rows (no results are hidden, corrected, or unpublished by
 * this action), so it's safe regardless of what stage the exam's results
 * are at. Idempotent. Same `canManage` gate as createExam (Owner/Admin/
 * Manager only — a Trainer can enter marks but not archive the exam).
 */
export async function archiveExam(
  actorContext: AuthContext,
  examId: string,
): Promise<ArchiveExamResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) {
    return { ok: false, error: EXAM_NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ exam: exams, branchId: batches.branchId })
      .from(exams)
      .innerJoin(batches, eq(batches.id, exams.batchId))
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(exams)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(exams.id, examId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "archiveExam",
        entityType: "exam",
        entityId: examId,
        branchId: existing.branchId,
        before: toExamRecord(existing.exam),
        after: toExamRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: EXAM_NOT_FOUND };
  }
  return { ok: true, exam: toExamRecord(result) };
}

/** Mirror of archiveExam, flipped — restores to "scheduled" regardless of
 * whatever status the exam had before archiving, since "scheduled" is the
 * exam lifecycle's own starting state. Idempotent. */
export async function restoreExam(
  actorContext: AuthContext,
  examId: string,
): Promise<ArchiveExamResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) {
    return { ok: false, error: EXAM_NOT_FOUND };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ exam: exams, branchId: batches.branchId })
      .from(exams)
      .innerJoin(batches, eq(batches.id, exams.batchId))
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .limit(1);
    if (!existing) return null;

    const [updated] = await tx
      .update(exams)
      .set({ status: "scheduled", updatedAt: new Date() })
      .where(eq(exams.id, examId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "restoreExam",
        entityType: "exam",
        entityId: examId,
        branchId: existing.branchId,
        before: toExamRecord(existing.exam),
        after: toExamRecord(updated),
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: EXAM_NOT_FOUND };
  }
  return { ok: true, exam: toExamRecord(result) };
}

/**
 * ---------------------------------------------------------------------
 * Permanent exam deletion — narrow, eligibility-gated, distinct from
 * archiveExam
 * ---------------------------------------------------------------------
 * PLAN.md's "Archive & Deactivation Rules" table (Planning Gaps
 * Resolution §12) states a categorical "archive/deactivate, never delete"
 * rule for Branches, Staff, Students, Courses, Programs, and Batches —
 * `exams` is NOT one of the entities that table names. What PLAN.md does
 * protect unconditionally is *result* data: "No hard deletes on posted
 * financial/result records" (Confirmed Technical Decisions), and Exam
 * Results is explicitly part of the Result Lifecycle table PLAN.md
 * defines. So the line this function draws is: the `exams` container row
 * itself may be permanently removed, but only when doing so can never
 * touch a single `exam_results` row — i.e. only an exam that has never had
 * any student results attached to it at all (in practice: created for a
 * batch with zero actively-enrolled students, since `createExam` stamps
 * one Draft `exam_results` row per actively-enrolled student at creation
 * time — see this file's module comment). This is the same "zero rows in
 * the protected table(s)" eligibility pattern lib/academies/delete-
 * academy.ts already established for academies; deleting exam_results
 * rows to force an exam "eligible" is never done here.
 */
export interface ExamDeletionEligibility {
  examId: string;
  examName: string;
  eligible: boolean;
  hasResults: boolean;
}

export type GetExamDeletionEligibilityResult =
  | { ok: true; eligibility: ExamDeletionEligibility }
  | { ok: false; error: ExamActionError };

async function examHasResults(executor: DbClient, examId: string): Promise<boolean> {
  const [row] = await executor.select({ id: examResults.id }).from(examResults).where(eq(examResults.examId, examId)).limit(1);
  return Boolean(row);
}

/** Read-only preview for the UI's Delete button (enabled/disabled + why) —
 * `deleteExam` below re-runs the identical check itself, inside the
 * deletion transaction, as the actual authority. */
export async function getExamDeletionEligibility(
  actorContext: AuthContext,
  examId: string,
): Promise<GetExamDeletionEligibilityResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole } = resolved.access;

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) return { ok: false, error: EXAM_NOT_FOUND };

  const [existing] = await db
    .select({ id: exams.id, name: exams.name, batchId: exams.batchId })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
    .limit(1);
  if (!existing) return { ok: false, error: EXAM_NOT_FOUND };

  if (membershipRole === "trainer") {
    const assignedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
    if (!assignedBatchIds.includes(existing.batchId)) return { ok: false, error: EXAM_NOT_FOUND };
  }

  const hasResults = await examHasResults(db, examId);

  return {
    ok: true,
    eligibility: { examId: existing.id, examName: existing.name, eligible: !hasResults, hasResults },
  };
}

export type DeleteExamResult =
  | { ok: true; examId: string }
  | { ok: false; error: ExamActionError };

/**
 * Same `canManage` gate as createExam/archiveExam (Owner/Admin/Manager
 * only). Eligibility is re-verified from scratch INSIDE this transaction,
 * on a row locked with `for("update")` — the UI's own preview
 * (`getExamDeletionEligibility`, above) is only ever a display hint; a
 * mark could be entered between that read and this call, and this is the
 * check that actually decides whether the delete proceeds. Audited before
 * the row is removed, same convention as deleteAcademy.
 */
export async function deleteExam(actorContext: AuthContext, examId: string): Promise<DeleteExamResult> {
  const resolved = await resolveExamAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;

  if (!canManage(permissionLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsedId = z.string().uuid().safeParse(examId);
  if (!parsedId.success) {
    return { ok: false, error: EXAM_NOT_FOUND };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ exam: exams, branchId: batches.branchId })
      .from(exams)
      .innerJoin(batches, eq(batches.id, exams.batchId))
      .where(and(eq(exams.id, examId), eq(exams.academyId, academyId)))
      .for("update");
    if (!existing) {
      return { ok: false, error: EXAM_NOT_FOUND };
    }

    if (await examHasResults(tx, examId)) {
      return {
        ok: false,
        error: {
          code: "ineligible",
          message: "This exam cannot be permanently deleted because it has student results attached to it. Archive it instead.",
        },
      };
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: "deleteExam",
        entityType: "exam",
        entityId: examId,
        branchId: existing.branchId,
        before: toExamRecord(existing.exam),
      },
      tx,
    );

    await tx.delete(exams).where(eq(exams.id, examId));

    return { ok: true, examId };
  });
}
