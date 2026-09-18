import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { batchEnrollments, branches, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAssignedBranchIds, resolveScope } from "@/lib/academies/students";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 5, Item 61a — `getStudentReports`, the Student sub-view of
 * the `/academy/reports` hub (DESIGN.md §9.9: "hub with Student/Academic/
 * Finance sub-views, each: filter bar + table + a simple chart only where
 * the data is genuinely aggregate/trend").
 *
 * ---------------------------------------------------------------------
 * Permission gating — reuses the existing `academy.students` row, no new
 * permission row invented
 * ---------------------------------------------------------------------
 * The task brief for this item is explicit: PLAN.md defines no distinct
 * "reports" permission entry for this sub-view, and this module must not
 * invent one. `lib/academies/students.ts`'s own `STUDENTS_PERMISSION_ACTION`
 * (= `ACADEMY_STUDENTS_ACTION`, `"academy.students"`) is the row that
 * already gates every other read of this exact data (`searchStudents`,
 * `getStudent`, `getAdmissionsView`) — this file gates on that same row,
 * at "any level above none" (Owner/Admin `full`, Manager/Admissions
 * Officer `manage`, Finance Officer/Trainer `view`), exactly mirroring
 * `getFinanceReports`'s own precedent (lib/academies/finance-reports.ts's
 * module comment): a report never grants more — or less — than the
 * role's own existing view right on the underlying entity.
 *
 * ---------------------------------------------------------------------
 * Tenant/branch scoping — reused, not reimplemented
 * ---------------------------------------------------------------------
 * `lib/academies/students.ts`'s `resolveScope`/`getAssignedBranchIds`
 * helpers (tenant-scope every query to the caller's academy, and further
 * narrow Admissions Officer/Trainer to their assigned branch(es) via
 * `staff_branch_assignments`) are exported from that file specifically for
 * this item to import here, rather than a third copy of the same join
 * being written — see that file's own comments on both exports for the
 * "additive, behavior-preserving" reasoning. `resolveScope`'s conditions
 * are plain `students.academyId`/`students.branchId` SQL fragments, so
 * they compose unchanged into this file's own `students`-rooted queries
 * and into the `batch_enrollments` query below (joined through `students`).
 *
 * A branch-limited caller with zero assigned branches, or who requests an
 * out-of-scope `branchId` filter, gets `scope.unreachable: true` — the
 * same "empty report, not an error" outcome `searchStudents` uses for the
 * identical situation.
 *
 * ---------------------------------------------------------------------
 * What this aggregates (DESIGN.md §9.9: "enrollment counts/trend over
 * time, active vs. inactive/withdrawn breakdown, branch distribution")
 * ---------------------------------------------------------------------
 * - `totalStudents` / `statusBreakdown`: counts off `students.status`
 *   (`active`/`archived` — the only two values that enum has; "archived"
 *   is this report's "inactive"), scoped by `dateFrom`/`dateTo` against
 *   `students.createdAt` (registration date) when given.
 * - `branchDistribution`: `students` grouped by branch, same scope/date
 *   filters as the status breakdown.
 * - `enrollmentTrend`: `batch_enrollments` grouped by
 *   `to_char(enrolled_at, 'YYYY-MM')`, ascending — a genuinely aggregate/
 *   trend metric, per DESIGN.md's "chart only where the data is genuinely
 *   aggregate/trend" rule (this is the field the hub page's Student-tab
 *   chart renders).
 * - `enrollmentStatusBreakdown`: `batch_enrollments` grouped by its own
 *   `status` (`active`/`withdrawn`/`completed`) — this is the literal
 *   source of DESIGN.md's "withdrawn" half of the "active vs. inactive/
 *   withdrawn breakdown" phrase (a `students.status` value of `archived`
 *   is the "inactive" half; `batch_enrollments.status` has no "inactive"
 *   value of its own). Both breakdowns are returned side by side rather
 *   than collapsed into one, since they describe two different entities
 *   (a student's own record vs. one of their batch enrollments) that
 *   PLAN.md never unifies into a single status column.
 * - `batch_enrollments` carries its own `academy_id` column directly (no
 *   join needed for tenant scoping), but has no `branch_id` column at all
 *   — same fact `getFinanceReports`'s module comment notes for
 *   `student_charges`/`student_payments` — so branch scoping/filtering
 *   reaches it via an inner join through `students.branch_id`, reusing
 *   `resolveScope`'s conditions unchanged (they're expressed against the
 *   joined `students` columns, not `batch_enrollments`' own).
 *
 * `dateFrom`/`dateTo` are inclusive on both ends, same convention as
 * `getFinanceReports`.
 */

export const studentReportFiltersSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  branchId: z.string().uuid("Invalid branch id").optional(),
});

export type StudentReportFiltersInput = z.input<typeof studentReportFiltersSchema>;
type ParsedStudentReportFilters = z.infer<typeof studentReportFiltersSchema>;

export interface StudentReportsActionError {
  code: "blocked" | "forbidden" | "validation";
  message: string;
}

const FORBIDDEN: StudentReportsActionError = {
  code: "forbidden",
  message: "You don't have permission to view this academy's student reports.",
};

export interface StatusCount {
  status: "active" | "archived";
  count: number;
}

export interface BranchDistributionRow {
  branchId: string;
  branchName: string;
  count: number;
}

export interface EnrollmentTrendPoint {
  /** "YYYY-MM" */
  period: string;
  count: number;
}

export interface EnrollmentStatusCount {
  status: "active" | "withdrawn" | "completed";
  count: number;
}

export interface StudentReportsData {
  academyId: string;
  generatedAt: Date;
  filters: {
    dateFrom: Date | null;
    dateTo: Date | null;
    branchId: string | null;
  };
  totalStudents: number;
  statusBreakdown: StatusCount[];
  branchDistribution: BranchDistributionRow[];
  enrollmentTrend: EnrollmentTrendPoint[];
  enrollmentStatusBreakdown: EnrollmentStatusCount[];
}

export type GetStudentReportsResult =
  | { ok: true; report: StudentReportsData }
  | { ok: false; error: StudentReportsActionError };

const STUDENT_STATUSES = ["active", "archived"] as const;
const ENROLLMENT_STATUSES = ["active", "withdrawn", "completed"] as const;

function emptyReport(academyId: string, filters: ParsedStudentReportFilters): StudentReportsData {
  return {
    academyId,
    generatedAt: new Date(),
    filters: {
      dateFrom: filters.dateFrom ?? null,
      dateTo: filters.dateTo ?? null,
      branchId: filters.branchId ?? null,
    },
    totalStudents: 0,
    statusBreakdown: STUDENT_STATUSES.map((status) => ({ status, count: 0 })),
    branchDistribution: [],
    enrollmentTrend: [],
    enrollmentStatusBreakdown: ENROLLMENT_STATUSES.map((status) => ({ status, count: 0 })),
  };
}

/**
 * PLAN.md Phase 5, Item 61a `getStudentReports`. Read-only: no `recordAudit`
 * call, same convention as `getFinanceReports`/`searchStudents`/every other
 * plain read in this codebase.
 */
export async function getStudentReports(
  actorContext: AuthContext,
  filtersInput: StudentReportFiltersInput = {},
): Promise<GetStudentReportsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const parsed = studentReportFiltersSchema.safeParse(filtersInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid filters." },
    };
  }
  const filters = parsed.data;
  const { academyId, membershipRole } = access;

  const level = getAcademyPermissionLevel(membershipRole, ACADEMY_STUDENTS_ACTION);
  if (level === "none") {
    return { ok: false, error: FORBIDDEN };
  }

  const scope = await resolveScope(academyId, membershipRole, actorContext.userId, filters.branchId);
  if (scope.unreachable) {
    return { ok: true, report: emptyReport(academyId, filters) };
  }

  const studentConditions: SQL[] = [...scope.conditions];
  if (filters.dateFrom) studentConditions.push(gte(students.createdAt, filters.dateFrom));
  if (filters.dateTo) studentConditions.push(lte(students.createdAt, filters.dateTo));
  const studentsWhere = and(...studentConditions);

  const enrollmentConditions: SQL[] = [...scope.conditions];
  if (filters.dateFrom) enrollmentConditions.push(gte(batchEnrollments.enrolledAt, filters.dateFrom));
  if (filters.dateTo) enrollmentConditions.push(lte(batchEnrollments.enrolledAt, filters.dateTo));
  const enrollmentsWhere = and(...enrollmentConditions);

  const [statusRows, branchRows, trendRows, enrollmentStatusRows] = await Promise.all([
    db
      .select({ status: students.status, count: sql<number>`count(*)::int` })
      .from(students)
      .where(studentsWhere)
      .groupBy(students.status),
    db
      .select({
        branchId: students.branchId,
        branchName: branches.name,
        count: sql<number>`count(*)::int`,
      })
      .from(students)
      .innerJoin(branches, eq(branches.id, students.branchId))
      .where(studentsWhere)
      .groupBy(students.branchId, branches.name),
    db
      .select({
        period: sql<string>`to_char(${batchEnrollments.enrolledAt}, 'YYYY-MM')`,
        count: sql<number>`count(*)::int`,
      })
      .from(batchEnrollments)
      .innerJoin(students, eq(batchEnrollments.studentId, students.id))
      .where(enrollmentsWhere)
      .groupBy(sql`to_char(${batchEnrollments.enrolledAt}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${batchEnrollments.enrolledAt}, 'YYYY-MM')`),
    db
      .select({ status: batchEnrollments.status, count: sql<number>`count(*)::int` })
      .from(batchEnrollments)
      .innerJoin(students, eq(batchEnrollments.studentId, students.id))
      .where(enrollmentsWhere)
      .groupBy(batchEnrollments.status),
  ]);

  const statusBreakdown: StatusCount[] = STUDENT_STATUSES.map((status) => ({
    status,
    count: statusRows.find((row) => row.status === status)?.count ?? 0,
  }));
  const enrollmentStatusBreakdown: EnrollmentStatusCount[] = ENROLLMENT_STATUSES.map((status) => ({
    status,
    count: enrollmentStatusRows.find((row) => row.status === status)?.count ?? 0,
  }));

  return {
    ok: true,
    report: {
      academyId,
      generatedAt: new Date(),
      filters: {
        dateFrom: filters.dateFrom ?? null,
        dateTo: filters.dateTo ?? null,
        branchId: filters.branchId ?? null,
      },
      totalStudents: statusBreakdown.reduce((sum, row) => sum + row.count, 0),
      statusBreakdown,
      branchDistribution: branchRows.map((row) => ({
        branchId: row.branchId,
        branchName: row.branchName,
        count: row.count,
      })),
      enrollmentTrend: trendRows.map((row) => ({ period: row.period, count: row.count })),
      enrollmentStatusBreakdown,
    },
  };
}

// Re-exported purely so lib/academies/student-reports.test.ts can assert
// against the same "assigned branch ids" helper this module relies on for
// scoping, without a third re-implementation in the test file itself.
export { getAssignedBranchIds };
