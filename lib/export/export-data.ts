import { recordAudit } from "@/lib/audit";
import type { AuditLogRow } from "@/lib/audit-query";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  getAcademicReports,
  type AcademicReportFiltersInput,
  type AcademicReportsData,
} from "@/lib/academies/academic-reports";
import {
  getAcademyAuditLogs,
  type AcademyAuditLogFilters,
} from "@/lib/academies/audit-logs";
import {
  getFinanceReports,
  type FinanceReportFiltersInput,
  type FinanceReportsData,
} from "@/lib/academies/finance-reports";
import {
  getStudentReports,
  type StudentReportFiltersInput,
  type StudentReportsData,
} from "@/lib/academies/student-reports";
import {
  searchStudents,
  type StudentSearchFilters,
  type StudentRecord,
} from "@/lib/academies/students";
import type { AuthContext } from "@/lib/auth/auth-context";
import { toCsv } from "@/lib/export/csv";

/**
 * PLAN.md Phase 5, Item 60 — `exportData(actorContext, entityType, filters,
 * format)`. DESIGN.md §11.6 ("Export Scope"): "CSV export appears only on:
 * Reports (platform + academy), the Student list, Finance screens, and
 * Audit Logs (platform + academy)... An export always returns exactly the
 * rows the on-screen list/report shows for that user's role and branch
 * scope — never more."
 *
 * ---------------------------------------------------------------------
 * Entity types — one per existing list/query function, never a raw
 * duplicate query
 * ---------------------------------------------------------------------
 * PLAN.md names the export surface as "Reports/Student list/Finance/Audit
 * logs." "Reports" (`/academy/reports`, the Wave 3 hub) has three
 * independent sub-views — Student, Academic, Finance — each backed by its
 * own Item 61a aggregation function; "Finance" also appears as its own
 * standalone page (`/academy/finance-reports`) backed by the SAME
 * `getFinanceReports` (Item 55) the hub's Finance tab reuses verbatim. So
 * the closed union below has five members, not four — `finance_report`
 * covers BOTH `/academy/finance-reports` and the hub's Finance tab (one
 * function, one entity type, two pages rendering the same report), while
 * `student_report`/`academic_report` cover the hub's other two tabs, and
 * `audit_log`/`student_list` cover the two remaining named surfaces:
 *
 * - `finance_report`  -> `getFinanceReports`      (Item 55)
 * - `student_report`  -> `getStudentReports`      (Item 61a)
 * - `academic_report` -> `getAcademicReports`     (Item 61a)
 * - `audit_log`       -> `getAcademyAuditLogs`    (Item 42, -> `fetchAuditLogs`)
 * - `student_list`    -> `searchStudents`         (Item 39)
 *
 * Every branch below calls exactly one of these five EXISTING functions
 * with the caller's own `actorContext` and the given filters, then
 * flattens/serializes whatever that function returned. None of their
 * permission/tenant/branch-scoping logic is reimplemented here, and a
 * `blocked`/`forbidden`/`validation` error from the underlying function is
 * returned to the caller completely unchanged — this module never turns a
 * partial result into a full one, or a failure into a success.
 *
 * ---------------------------------------------------------------------
 * Row-count cap (Planning Gaps Resolution — "Pagination, Search & Export
 * Limits"): "Max export row count: 10,000 rows per export call; beyond
 * that, `exportData` is rejected with a message asking the user to narrow
 * filters, not a silent truncation."
 * ---------------------------------------------------------------------
 * `audit_log` and `student_list` are the only two entity types backed by a
 * paginated, per-row list function (`fetchAuditLogs`/`searchStudents`, each
 * capped at 100 rows/page by their own module). `collectAllRows` below
 * drives that same paginated function page-by-page — never a second, raw
 * unpaginated query — accumulating rows until either every row has been
 * fetched or the function's own reported `totalCount` exceeds
 * `EXPORT_MAX_ROWS`, at which point it stops immediately (no further pages
 * fetched) and `exportData` returns a `too_many_rows` error instead of a
 * truncated file. `finance_report`/`student_report`/`academic_report` are
 * bounded aggregate summaries (one row per currency/branch/batch/grade-band
 * — never one row per underlying transaction/student/result), so they never
 * approach this cap and carry no pagination loop at all.
 *
 * ---------------------------------------------------------------------
 * Audit logging
 * ---------------------------------------------------------------------
 * Every SUCCESSFUL export writes one `recordAudit` row with
 * `action: "data.export"` and `entityType` set to the exported entity type
 * (`"finance_report"`, `"student_list"`, etc.) — PLAN.md/DESIGN.md's
 * `exportData` requirement, tested in export-data.test.ts. A rejected call
 * (`blocked`/`forbidden`/`validation`/`too_many_rows`) is never audited
 * here, matching every other read in this codebase (`getFinanceReports`,
 * `searchStudents`, etc.): none of them audit a denied read either, only
 * this module's own successful, data-producing calls are new enough to
 * need an audit trail at all.
 *
 * `academyId`/`actorRole` for the audit row come from a fresh
 * `checkAcademyAccessForContext(actorContext)` call — NOT from
 * `actorContext.academyId`/`actorContext.academyRole`, which
 * lib/auth/auth-context.ts's own module comment documents as always
 * `undefined` (populated by a later phase this codebase hasn't reached for
 * that specific field). This is an extra call to the same shared
 * access-resolution helper every underlying function already calls
 * internally for its own gating — same "page/action re-resolves access
 * itself rather than threading it through" precedent already used
 * throughout this codebase (e.g. app/academy/finance-reports/page.tsx's own
 * module comment) — not a second implementation of any permission rule.
 */

export const EXPORT_MAX_ROWS = 10_000;
const LIST_PAGE_SIZE = 100;

export type ExportEntityType =
  | "finance_report"
  | "student_report"
  | "academic_report"
  | "audit_log"
  | "student_list";

export type ExportFormat = "csv" | "json";

export interface ExportDataError {
  // "not_found" is only reachable in practice via `student_list`'s
  // underlying `searchStudents` error type (`StudentActionError`) — a
  // search never actually returns it (that code is `getStudent`'s alone),
  // but the union is widened here so a future change to that shared error
  // type can never fail to compile against this one. "ineligible" is the
  // same story for StudentActionError's newer deleteStudent-only code —
  // searchStudents/exportStudentList never produce it either, but it must
  // still typecheck against this union for the same reason.
  code: "blocked" | "forbidden" | "validation" | "not_found" | "too_many_rows" | "ineligible";
  message: string;
}

export interface ExportDataSuccess {
  ok: true;
  entityType: ExportEntityType;
  format: ExportFormat;
  content: string;
  rowCount: number;
  filename: string;
}

export type ExportDataResult = ExportDataSuccess | { ok: false; error: ExportDataError };

const TOO_MANY_ROWS_MESSAGE =
  "This export would include more than 10,000 rows. Narrow your filters and try again.";

function serialize(rows: Record<string, unknown>[], columns: readonly string[], format: ExportFormat): string {
  return format === "json" ? JSON.stringify(rows, null, 2) : toCsv(rows, [...columns]);
}

function buildFilename(entityType: ExportEntityType, format: ExportFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${entityType}-${stamp}.${format}`;
}

/**
 * Resolves `{ academyId, actorRole }` for the audit row only — see this
 * module's top comment for why `actorContext.academyId`/`academyRole`
 * can't be used directly. Never used to gate the export itself.
 */
async function resolveAuditMetadata(
  actorContext: AuthContext,
): Promise<{ academyId: string | undefined; actorRole: string | undefined }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { academyId: undefined, actorRole: undefined };
  }
  return { academyId: access.academyId, actorRole: access.membershipRole };
}

async function finalize(
  actorContext: AuthContext,
  entityType: ExportEntityType,
  rows: Record<string, unknown>[],
  columns: readonly string[],
  format: ExportFormat,
): Promise<ExportDataSuccess> {
  const { academyId, actorRole } = await resolveAuditMetadata(actorContext);

  await recordAudit({
    actorUserId: actorContext.userId,
    actorRole,
    academyId,
    action: "data.export",
    entityType,
    context: { format, rowCount: rows.length },
  });

  return {
    ok: true,
    entityType,
    format,
    content: serialize(rows, columns, format),
    rowCount: rows.length,
    filename: buildFilename(entityType, format),
  };
}

// ---------------------------------------------------------------------
// finance_report -> getFinanceReports
// ---------------------------------------------------------------------

export const FINANCE_REPORT_COLUMNS = ["section", "metric", "currency", "amountCents", "count"] as const;

/** Exported for export-data.test.ts's row-shape assertions. */
export function flattenFinanceReport(report: FinanceReportsData): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  if (report.studentPayments.visible) {
    for (const t of report.studentPayments.outstandingCharges.totalsByCurrency) {
      rows.push({ section: "studentPayments", metric: "outstandingCharges", currency: t.currency, amountCents: t.amountCents, count: t.count });
    }
    for (const t of report.studentPayments.paymentsReceived.totalsByCurrency) {
      rows.push({ section: "studentPayments", metric: "paymentsReceived", currency: t.currency, amountCents: t.amountCents, count: t.count });
    }
    rows.push({
      section: "studentPayments",
      metric: "pendingApprovalsCount",
      currency: null,
      amountCents: null,
      count: report.studentPayments.pendingApprovalsCount,
    });
  }

  if (report.income.visible) {
    for (const t of report.income.totalsByCurrency) {
      rows.push({ section: "income", metric: "total", currency: t.currency, amountCents: t.amountCents, count: t.count });
    }
  }

  if (report.expenses.visible) {
    for (const t of report.expenses.totalsByCurrency) {
      rows.push({ section: "expenses", metric: "total", currency: t.currency, amountCents: t.amountCents, count: t.count });
    }
    rows.push({
      section: "expenses",
      metric: "pendingApprovalsCount",
      currency: null,
      amountCents: null,
      count: report.expenses.pendingApprovalsCount,
    });
  }

  return rows;
}

async function exportFinanceReport(
  actorContext: AuthContext,
  filters: FinanceReportFiltersInput,
  format: ExportFormat,
): Promise<ExportDataResult> {
  const result = await getFinanceReports(actorContext, filters);
  if (!result.ok) return { ok: false, error: result.error };
  return finalize(actorContext, "finance_report", flattenFinanceReport(result.report), FINANCE_REPORT_COLUMNS, format);
}

// ---------------------------------------------------------------------
// student_report -> getStudentReports
// ---------------------------------------------------------------------

export const STUDENT_REPORT_COLUMNS = ["section", "key", "label", "count"] as const;

/** Exported for export-data.test.ts's row-shape assertions. */
export function flattenStudentReport(report: StudentReportsData): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const r of report.statusBreakdown) {
    rows.push({ section: "statusBreakdown", key: r.status, label: r.status, count: r.count });
  }
  for (const r of report.branchDistribution) {
    rows.push({ section: "branchDistribution", key: r.branchId, label: r.branchName, count: r.count });
  }
  for (const r of report.enrollmentTrend) {
    rows.push({ section: "enrollmentTrend", key: r.period, label: r.period, count: r.count });
  }
  for (const r of report.enrollmentStatusBreakdown) {
    rows.push({ section: "enrollmentStatusBreakdown", key: r.status, label: r.status, count: r.count });
  }
  return rows;
}

async function exportStudentReport(
  actorContext: AuthContext,
  filters: StudentReportFiltersInput,
  format: ExportFormat,
): Promise<ExportDataResult> {
  const result = await getStudentReports(actorContext, filters);
  if (!result.ok) return { ok: false, error: result.error };
  return finalize(actorContext, "student_report", flattenStudentReport(result.report), STUDENT_REPORT_COLUMNS, format);
}

// ---------------------------------------------------------------------
// academic_report -> getAcademicReports
// ---------------------------------------------------------------------

export const ACADEMIC_REPORT_COLUMNS = [
  "section",
  "batchId",
  "batchName",
  "courseId",
  "courseName",
  "passCount",
  "failCount",
  "pendingCount",
  "passRate",
  "gradeBandLabel",
  "count",
] as const;

/** Exported for export-data.test.ts's row-shape assertions. */
export function flattenAcademicReport(report: AcademicReportsData): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const r of report.passFailByBatch) {
    rows.push({
      section: "passFailByBatch",
      batchId: r.batchId,
      batchName: r.batchName,
      courseId: r.courseId,
      courseName: r.courseName,
      passCount: r.passCount,
      failCount: r.failCount,
      pendingCount: r.pendingCount,
      passRate: r.passRate,
      gradeBandLabel: null,
      count: null,
    });
  }
  for (const r of report.gradeDistribution) {
    rows.push({
      section: "gradeDistribution",
      batchId: null,
      batchName: null,
      courseId: null,
      courseName: null,
      passCount: null,
      failCount: null,
      pendingCount: null,
      passRate: null,
      gradeBandLabel: r.gradeBandLabel,
      count: r.count,
    });
  }
  return rows;
}

async function exportAcademicReport(
  actorContext: AuthContext,
  filters: AcademicReportFiltersInput,
  format: ExportFormat,
): Promise<ExportDataResult> {
  const result = await getAcademicReports(actorContext, filters);
  if (!result.ok) return { ok: false, error: result.error };
  return finalize(actorContext, "academic_report", flattenAcademicReport(result.report), ACADEMIC_REPORT_COLUMNS, format);
}

// ---------------------------------------------------------------------
// audit_log -> getAcademyAuditLogs (-> fetchAuditLogs)
// ---------------------------------------------------------------------

export const AUDIT_LOG_COLUMNS = [
  "id",
  "createdAt",
  "actorUserId",
  "actorRole",
  "academyId",
  "branchId",
  "action",
  "entityType",
  "entityId",
  "result",
  "failureReason",
  "reason",
  "requestId",
  "ip",
  "userAgent",
  "before",
  "after",
  "context",
] as const;

type CollectPageResult<T> =
  | { ok: true; rows: T[]; totalCount: number }
  | { ok: false; error: ExportDataError };

/**
 * Drives `fetchPage` (a thin closure over the caller's own paginated,
 * tenant/permission-scoped list function) page by page, accumulating rows
 * until either the whole result set has been fetched or the function's own
 * reported `totalCount` exceeds `EXPORT_MAX_ROWS` — see this module's top
 * comment. Stops at the first page once `totalCount` is known to be over
 * the cap, never fetching further pages just to discard them. If a later
 * page's fetch itself fails (e.g. access changed mid-export — the academy
 * was suspended between pages), that failure is propagated as-is rather
 * than silently returning the partial rows gathered so far — this module
 * never turns a failure into a partial success.
 */
async function collectAllRows<T>(
  fetchPage: (page: number, pageSize: number) => Promise<CollectPageResult<T>>,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: ExportDataError }> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const result = await fetchPage(page, LIST_PAGE_SIZE);
    if (!result.ok) return result;
    if (result.totalCount > EXPORT_MAX_ROWS) {
      return { ok: false, error: { code: "too_many_rows", message: TOO_MANY_ROWS_MESSAGE } };
    }
    all.push(...result.rows);
    if (result.rows.length === 0 || all.length >= result.totalCount) {
      return { ok: true, rows: all };
    }
    page += 1;
  }
}

async function exportAuditLog(
  actorContext: AuthContext,
  filters: AcademyAuditLogFilters,
  format: ExportFormat,
): Promise<ExportDataResult> {
  // Page 1's own permission/tenant-scoping decision is what gates this
  // whole export — a `blocked`/`forbidden` result here is returned
  // unchanged, and no page is ever fetched before this one succeeds.
  const first = await getAcademyAuditLogs(actorContext, filters, { page: 1, pageSize: LIST_PAGE_SIZE });
  if (!first.ok) return { ok: false, error: first.error };

  const collected = await collectAllRows<AuditLogRow>(async (page, pageSize) => {
    if (page === 1) return { ok: true, ...first.data };
    const next = await getAcademyAuditLogs(actorContext, filters, { page, pageSize });
    // Same actorContext/filters as the already-successful first page —
    // this can only fail here if access changed mid-export (e.g. the
    // academy was suspended between pages). Propagated as a real failure,
    // never as a silently truncated export.
    if (!next.ok) {
      return { ok: false, error: next.error };
    }
    return { ok: true, ...next.data };
  });

  if (!collected.ok) return { ok: false, error: collected.error };

  return finalize(
    actorContext,
    "audit_log",
    collected.rows as unknown as Record<string, unknown>[],
    AUDIT_LOG_COLUMNS,
    format,
  );
}

// ---------------------------------------------------------------------
// student_list -> searchStudents
// ---------------------------------------------------------------------

export const STUDENT_LIST_COLUMNS = [
  "id",
  "academyId",
  "branchId",
  "studentNumber",
  "fullName",
  "dateOfBirth",
  "gender",
  "phone",
  "email",
  "guardianName",
  "guardianPhone",
  "status",
  "createdBy",
  "createdAt",
  "updatedAt",
] as const;

async function exportStudentList(
  actorContext: AuthContext,
  filters: StudentSearchFilters,
  format: ExportFormat,
): Promise<ExportDataResult> {
  // Page 1's own permission/tenant/branch-scoping decision is what gates
  // this whole export — a `blocked`/`forbidden` result here is returned
  // unchanged, and no page is ever fetched before this one succeeds.
  const first = await searchStudents(actorContext, filters, { page: 1, pageSize: LIST_PAGE_SIZE });
  if (!first.ok) return { ok: false, error: first.error };

  const collected = await collectAllRows<StudentRecord>(async (page, pageSize) => {
    if (page === 1) return { ok: true, ...first.data };
    const next = await searchStudents(actorContext, filters, { page, pageSize });
    // Same actorContext/filters as the already-successful first page —
    // this can only fail here if access changed mid-export. Propagated as
    // a real failure, never as a silently truncated export.
    if (!next.ok) {
      return { ok: false, error: next.error };
    }
    return { ok: true, ...next.data };
  });

  if (!collected.ok) return { ok: false, error: collected.error };

  return finalize(
    actorContext,
    "student_list",
    collected.rows as unknown as Record<string, unknown>[],
    STUDENT_LIST_COLUMNS,
    format,
  );
}

// ---------------------------------------------------------------------
// exportData — the public entry point, overloaded per entity type so each
// caller gets the right filter type checked at compile time.
// ---------------------------------------------------------------------

export async function exportData(
  actorContext: AuthContext,
  entityType: "finance_report",
  filters: FinanceReportFiltersInput,
  format?: ExportFormat,
): Promise<ExportDataResult>;
export async function exportData(
  actorContext: AuthContext,
  entityType: "student_report",
  filters: StudentReportFiltersInput,
  format?: ExportFormat,
): Promise<ExportDataResult>;
export async function exportData(
  actorContext: AuthContext,
  entityType: "academic_report",
  filters: AcademicReportFiltersInput,
  format?: ExportFormat,
): Promise<ExportDataResult>;
export async function exportData(
  actorContext: AuthContext,
  entityType: "audit_log",
  filters: AcademyAuditLogFilters,
  format?: ExportFormat,
): Promise<ExportDataResult>;
export async function exportData(
  actorContext: AuthContext,
  entityType: "student_list",
  filters: StudentSearchFilters,
  format?: ExportFormat,
): Promise<ExportDataResult>;
export async function exportData(
  actorContext: AuthContext,
  entityType: ExportEntityType,
  filters: unknown,
  format: ExportFormat = "csv",
): Promise<ExportDataResult> {
  switch (entityType) {
    case "finance_report":
      return exportFinanceReport(actorContext, filters as FinanceReportFiltersInput, format);
    case "student_report":
      return exportStudentReport(actorContext, filters as StudentReportFiltersInput, format);
    case "academic_report":
      return exportAcademicReport(actorContext, filters as AcademicReportFiltersInput, format);
    case "audit_log":
      return exportAuditLog(actorContext, filters as AcademyAuditLogFilters, format);
    case "student_list":
      return exportStudentList(actorContext, filters as StudentSearchFilters, format);
  }
}
