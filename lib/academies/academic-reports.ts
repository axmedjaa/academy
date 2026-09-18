import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { batches, courses, examResults } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBatchIds } from "@/lib/academies/batch-assignments";
import {
  ACADEMY_EXAMS_ACTION,
  ACADEMY_RESULTS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 5, Item 61a — `getAcademicReports`, the Academic sub-view of
 * the `/academy/reports` hub (DESIGN.md §9.9: "pass/fail rate... results-
 * published counts, grade distribution").
 *
 * ---------------------------------------------------------------------
 * Permission gating — reuses `academy.exams` AND `academy.results`
 * together, mirroring `listResults`/`getResult`'s own dual gate; no new
 * permission row invented
 * ---------------------------------------------------------------------
 * The task brief asks to pick whichever ONE of `ACADEMY_EXAMS_ACTION`/
 * `ACADEMY_RESULTS_ACTION` "already governs viewing this data for most
 * roles." Reading `lib/academies/results.ts` (read-only here) shows neither
 * row alone actually does that: `ACADEMY_RESULTS_ACTION` is only ever set
 * for Owner/Admin/Manager (`"approve"` — see that row's own module comment:
 * Trainer deliberately has no entry on it at all), while
 * `ACADEMY_EXAMS_ACTION` is only set for Owner/Admin/Manager/Trainer (no
 * entry for Admissions Officer/Finance Officer). The actual existing
 * mechanism that governs viewing `exam_results` data today — `listResults`
 * and `getResult`, the two read functions in that file — gates on NEITHER
 * row alone: it accepts a caller whose `ACADEMY_EXAMS_ACTION` level is
 * submit-capable (`full`/`manage`/`enter_marks`) OR whose
 * `ACADEMY_RESULTS_ACTION` level is approve-capable (`"approve"`), i.e.
 * `canSubmitLevel(...) || canApproveLevel(...)`. Picking only one of the two
 * rows for this report would silently diverge from that established
 * viewing gate (excluding Trainer entirely if `ACADEMY_RESULTS_ACTION` were
 * chosen alone, since Trainer never holds any level on that row). This
 * module therefore mirrors `listResults`/`getResult`'s exact combined
 * check — reimplemented here as `canViewAcademicData` rather than imported,
 * since `canSubmitLevel`/`canApproveLevel` are private to results.ts and
 * that file is read-only for this item (same "reimplement the unexported
 * helper, documented" precedent `lib/academies/students.ts` already uses
 * for `lib/academies/branches.ts`'s `getAssignedBranchIds`). No new
 * permission row is added to lib/auth/academy-permissions.ts.
 *
 * ---------------------------------------------------------------------
 * Trainer scoping — reused, not reimplemented
 * ---------------------------------------------------------------------
 * A Trainer only ever sees results for batches they're assigned to teach —
 * same `batch_trainer_assignments`-via-`getAssignedBatchIds` mechanism
 * `listResults`/`submitResults`/`enterMarks` all use (imported directly
 * from `lib/academies/batch-assignments.ts`, which is exported and not on
 * this item's do-not-touch list — no reimplementation needed here). A
 * Trainer with zero assigned batches, or who requests an out-of-scope
 * `batchId` filter, gets an empty report rather than an error, same
 * "unreachable" convention `lib/academies/students.ts`'s `resolveScope`
 * established for the equivalent branch-scoping case.
 *
 * ---------------------------------------------------------------------
 * Pass/fail logic — trusts the stored, immutable `pass_fail`/
 * `grade_band_label` snapshot; does NOT call `evaluateGradeBand`
 * ---------------------------------------------------------------------
 * `lib/academies/certificates.ts`'s eligibility check re-derives a result's
 * outcome with `evaluateGradeBand` as a deliberate belt-and-braces measure
 * before making a one-way, consequential decision (issuing a certificate) —
 * see that function's own module comment. This report makes no decision at
 * all; it only summarizes what `publishResults` (lib/academies/results.ts)
 * already computed and stamped onto each row at publish time, and that
 * file's own module comment is explicit that those four columns
 * (`marks_obtained`, `grade_configuration_id`, `grade_band_label`,
 * `pass_fail`) are immutable from that moment on ("changeable only via an
 * approved correction"). Re-deriving them here via `evaluateGradeBand`
 * would recompute a value the database already guarantees hasn't drifted,
 * for no observable benefit to a read-only aggregate — so this module
 * aggregates the stored `pass_fail`/`grade_band_label` columns directly,
 * scoped to `status = 'published'` rows only (the only rows those columns
 * are guaranteed final for).
 *
 * ---------------------------------------------------------------------
 * Filters
 * ---------------------------------------------------------------------
 * - `dateFrom`/`dateTo`: applied to `exam_results.published_at`, inclusive
 *   on both ends (same convention as `getFinanceReports`) — the natural
 *   date column for "when was this result finalized."
 * - `batchId`: `exam_results.batch_id` directly (the column is
 *   denormalized onto every result row precisely so a batch-scoped query
 *   like this one never needs to join through `exams` — see that column's
 *   own schema comment).
 * - `courseId`: reached via an inner join through `batches.course_id`,
 *   since `exam_results` carries no course reference of its own.
 */

export const academicReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  batchId: z.string().uuid("Invalid batch id").optional(),
  courseId: z.string().uuid("Invalid course id").optional(),
});

export type AcademicReportFiltersInput = z.input<typeof academicReportFiltersSchema>;
type ParsedAcademicReportFilters = z.infer<typeof academicReportFiltersSchema>;

export interface AcademicReportsActionError {
  code: "blocked" | "forbidden" | "validation";
  message: string;
}

const FORBIDDEN: AcademicReportsActionError = {
  code: "forbidden",
  message: "You don't have permission to view this academy's academic reports.",
};

function canSubmitLevel(level: AcademyPermissionLevel): boolean {
  return level === "full" || level === "manage" || level === "enter_marks";
}

function canApproveLevel(level: AcademyPermissionLevel): boolean {
  return level === "approve";
}

export interface PassFailByBatchRow {
  batchId: string;
  batchName: string;
  courseId: string;
  courseName: string;
  passCount: number;
  failCount: number;
  pendingCount: number;
  /** `passCount / (passCount + failCount)`, `null` when that denominator is 0. */
  passRate: number | null;
}

export interface GradeDistributionRow {
  gradeBandLabel: string;
  count: number;
}

export interface AcademicReportsData {
  academyId: string;
  generatedAt: Date;
  filters: {
    dateFrom: Date | null;
    dateTo: Date | null;
    batchId: string | null;
    courseId: string | null;
  };
  resultsPublishedCount: number;
  passFailByBatch: PassFailByBatchRow[];
  gradeDistribution: GradeDistributionRow[];
}

export type GetAcademicReportsResult =
  | { ok: true; report: AcademicReportsData }
  | { ok: false; error: AcademicReportsActionError };

function emptyReport(academyId: string, filters: ParsedAcademicReportFilters): AcademicReportsData {
  return {
    academyId,
    generatedAt: new Date(),
    filters: {
      dateFrom: filters.dateFrom ?? null,
      dateTo: filters.dateTo ?? null,
      batchId: filters.batchId ?? null,
      courseId: filters.courseId ?? null,
    },
    resultsPublishedCount: 0,
    passFailByBatch: [],
    gradeDistribution: [],
  };
}

/**
 * PLAN.md Phase 5, Item 61a `getAcademicReports`. Read-only: no
 * `recordAudit` call, same convention as every other plain read in this
 * codebase.
 */
export async function getAcademicReports(
  actorContext: AuthContext,
  filtersInput: AcademicReportFiltersInput = {},
): Promise<GetAcademicReportsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const parsed = academicReportFiltersSchema.safeParse(filtersInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid filters." },
    };
  }
  const filters = parsed.data;
  const { academyId, membershipRole } = access;

  const examsLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_EXAMS_ACTION);
  const resultsLevel = getAcademyPermissionLevel(membershipRole, ACADEMY_RESULTS_ACTION);
  if (!canSubmitLevel(examsLevel) && !canApproveLevel(resultsLevel)) {
    return { ok: false, error: FORBIDDEN };
  }

  let allowedBatchIds: string[] | null = null;
  if (membershipRole === "trainer") {
    allowedBatchIds = await getAssignedBatchIds(db, actorContext.userId, academyId);
    if (allowedBatchIds.length === 0) {
      return { ok: true, report: emptyReport(academyId, filters) };
    }
    if (filters.batchId && !allowedBatchIds.includes(filters.batchId)) {
      return { ok: true, report: emptyReport(academyId, filters) };
    }
  }

  const conditions: SQL[] = [
    eq(examResults.academyId, academyId),
    eq(examResults.status, "published"),
  ];
  if (allowedBatchIds) conditions.push(inArray(examResults.batchId, allowedBatchIds));
  if (filters.batchId) conditions.push(eq(examResults.batchId, filters.batchId));
  if (filters.courseId) conditions.push(eq(batches.courseId, filters.courseId));
  if (filters.dateFrom) conditions.push(gte(examResults.publishedAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(examResults.publishedAt, filters.dateTo));
  const where = and(...conditions);

  const [byBatchRows, gradeRows, [publishedCountRow]] = await Promise.all([
    db
      .select({
        batchId: examResults.batchId,
        batchName: batches.name,
        courseId: batches.courseId,
        courseName: courses.name,
        passFail: examResults.passFail,
        count: sql<number>`count(*)::int`,
      })
      .from(examResults)
      .innerJoin(batches, eq(batches.id, examResults.batchId))
      .innerJoin(courses, eq(courses.id, batches.courseId))
      .where(where)
      .groupBy(examResults.batchId, batches.name, batches.courseId, courses.name, examResults.passFail),
    db
      .select({
        gradeBandLabel: examResults.gradeBandLabel,
        count: sql<number>`count(*)::int`,
      })
      .from(examResults)
      .innerJoin(batches, eq(batches.id, examResults.batchId))
      .where(where)
      .groupBy(examResults.gradeBandLabel),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(examResults)
      .innerJoin(batches, eq(batches.id, examResults.batchId))
      .where(where),
  ]);

  const byBatch = new Map<string, PassFailByBatchRow>();
  for (const row of byBatchRows) {
    const key = row.batchId;
    if (!byBatch.has(key)) {
      byBatch.set(key, {
        batchId: row.batchId,
        batchName: row.batchName,
        courseId: row.courseId,
        courseName: row.courseName,
        passCount: 0,
        failCount: 0,
        pendingCount: 0,
        passRate: null,
      });
    }
    const entry = byBatch.get(key)!;
    if (row.passFail === "pass") entry.passCount += row.count;
    else if (row.passFail === "fail") entry.failCount += row.count;
    else entry.pendingCount += row.count;
  }
  for (const entry of byBatch.values()) {
    const denominator = entry.passCount + entry.failCount;
    entry.passRate = denominator > 0 ? entry.passCount / denominator : null;
  }

  return {
    ok: true,
    report: {
      academyId,
      generatedAt: new Date(),
      filters: {
        dateFrom: filters.dateFrom ?? null,
        dateTo: filters.dateTo ?? null,
        batchId: filters.batchId ?? null,
        courseId: filters.courseId ?? null,
      },
      resultsPublishedCount: publishedCountRow?.count ?? 0,
      passFailByBatch: [...byBatch.values()],
      gradeDistribution: gradeRows
        .filter((row): row is { gradeBandLabel: string; count: number } => row.gradeBandLabel !== null)
        .map((row) => ({ gradeBandLabel: row.gradeBandLabel, count: row.count })),
    },
  };
}
