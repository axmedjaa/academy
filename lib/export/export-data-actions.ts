"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import { academicReportFiltersSchema } from "@/lib/academies/academic-reports";
import { financeReportFiltersSchema } from "@/lib/academies/finance-reports";
import { studentReportFiltersSchema } from "@/lib/academies/student-reports";
import {
  exportData,
  type ExportDataError,
  type ExportEntityType,
  type ExportFormat,
} from "@/lib/export/export-data";

/**
 * "use server" wrapper for PLAN.md Phase 5, Item 60's `exportData` — same
 * split as every other `*-actions.ts` file in this codebase (parse input +
 * authenticate here, pure logic in lib/export/export-data.ts). One action
 * covers all five entity types rather than five near-identical files, since
 * the only thing that differs between them is which Zod schema validates
 * `filters` — the Cross-Cutting Architecture Decisions rule ("every server
 * action has a Zod schema for its input") is satisfied per-branch below,
 * reusing the report entities' own already-exported filter schemas
 * (`financeReportFiltersSchema`/`studentReportFiltersSchema`/
 * `academicReportFiltersSchema` — each already accepts string dates via
 * `z.coerce.date()`) rather than redeclaring them. `audit_log`/
 * `student_list` have no pre-existing exported schema of their own (their
 * pages pass already-narrow, already-`?`-optional string filters straight
 * through to the pure function, same as
 * lib/academies/audit-logs-actions.ts's own `filtersSchema` and
 * app/academy/students/page.tsx's inline filter parsing) — this file adds
 * one for each, mirroring those two existing shapes exactly.
 */

const auditLogExportFiltersSchema = z.object({
  actorUserId: z.string().uuid().optional(),
  actorRole: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  branchId: z.string().uuid().optional(),
  result: z.enum(["success", "failure"]).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
});

const studentListExportFiltersSchema = z.object({
  searchTerm: z.string().trim().min(1).max(200).optional(),
  branchId: z.string().uuid().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const formatSchema = z.enum(["csv", "json"]).optional();

export type ExportDataActionError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "TOO_MANY_ROWS"; message: string };

export interface ExportDataActionSuccess {
  ok: true;
  content: string;
  filename: string;
  format: ExportFormat;
  rowCount: number;
}

export type ExportDataActionState = ExportDataActionSuccess | { ok: false; error: ExportDataActionError };

const UNAUTHENTICATED: ExportDataActionState = {
  ok: false,
  error: { code: "UNAUTHENTICATED", message: "Sign in required." },
};

function invalidFormat(): ExportDataActionState {
  return { ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid export format." } };
}

function mapError(error: ExportDataError): ExportDataActionState {
  if (error.code === "too_many_rows") {
    return { ok: false, error: { code: "TOO_MANY_ROWS", message: error.message } };
  }
  if (error.code === "validation") {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: error.message } };
  }
  // "blocked" / "forbidden" / "not_found" all surface as the same generic
  // denial shape here — same "don't leak which reason" convention every
  // other *-actions.ts file in this codebase already follows.
  return { ok: false, error: { code: "UNAUTHORIZED", message: error.message } };
}

function toResult(result: Awaited<ReturnType<typeof exportData>>): ExportDataActionState {
  if (!result.ok) return mapError(result.error);
  return {
    ok: true,
    content: result.content,
    filename: result.filename,
    format: result.format,
    rowCount: result.rowCount,
  };
}

/**
 * `/academy/finance-reports` and `/academy/reports`'s Finance tab — both
 * render `FinanceReportsView`, which is where this is called from.
 */
export async function exportFinanceReportAction(
  rawFilters: unknown = {},
  rawFormat?: unknown,
): Promise<ExportDataActionState> {
  const context = await getAuthContext();
  if (!context) return UNAUTHENTICATED;

  const parsedFormat = formatSchema.safeParse(rawFormat);
  if (!parsedFormat.success) return invalidFormat();

  const parsedFilters = financeReportFiltersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: parsedFilters.error.issues[0]?.message ?? "Invalid filters." } };
  }

  const result = await exportData(context, "finance_report", parsedFilters.data, parsedFormat.data);
  return toResult(result);
}

/** `/academy/reports`'s Student tab. */
export async function exportStudentReportAction(
  rawFilters: unknown = {},
  rawFormat?: unknown,
): Promise<ExportDataActionState> {
  const context = await getAuthContext();
  if (!context) return UNAUTHENTICATED;

  const parsedFormat = formatSchema.safeParse(rawFormat);
  if (!parsedFormat.success) return invalidFormat();

  const parsedFilters = studentReportFiltersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: parsedFilters.error.issues[0]?.message ?? "Invalid filters." } };
  }

  const result = await exportData(context, "student_report", parsedFilters.data, parsedFormat.data);
  return toResult(result);
}

/** `/academy/reports`'s Academic tab. */
export async function exportAcademicReportAction(
  rawFilters: unknown = {},
  rawFormat?: unknown,
): Promise<ExportDataActionState> {
  const context = await getAuthContext();
  if (!context) return UNAUTHENTICATED;

  const parsedFormat = formatSchema.safeParse(rawFormat);
  if (!parsedFormat.success) return invalidFormat();

  const parsedFilters = academicReportFiltersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: parsedFilters.error.issues[0]?.message ?? "Invalid filters." } };
  }

  const result = await exportData(context, "academic_report", parsedFilters.data, parsedFormat.data);
  return toResult(result);
}

/** `/academy/audit-logs`. */
export async function exportAuditLogAction(
  rawFilters: unknown = {},
  rawFormat?: unknown,
): Promise<ExportDataActionState> {
  const context = await getAuthContext();
  if (!context) return UNAUTHENTICATED;

  const parsedFormat = formatSchema.safeParse(rawFormat);
  if (!parsedFormat.success) return invalidFormat();

  const parsedFilters = auditLogExportFiltersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: parsedFilters.error.issues[0]?.message ?? "Invalid filters." } };
  }

  const result = await exportData(context, "audit_log", parsedFilters.data, parsedFormat.data);
  return toResult(result);
}

/**
 * `/academy/students` — not currently wired to a page (PLAN.md Item 60's
 * task brief scopes the UI wiring to four specific pages, none of which is
 * `/academy/students`), but `exportData`'s own scope explicitly includes
 * "Student list" (PLAN.md/DESIGN.md §11.6), so this action exists for that
 * entity type's completeness and is covered by export-data.test.ts.
 */
export async function exportStudentListAction(
  rawFilters: unknown = {},
  rawFormat?: unknown,
): Promise<ExportDataActionState> {
  const context = await getAuthContext();
  if (!context) return UNAUTHENTICATED;

  const parsedFormat = formatSchema.safeParse(rawFormat);
  if (!parsedFormat.success) return invalidFormat();

  const parsedFilters = studentListExportFiltersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: parsedFilters.error.issues[0]?.message ?? "Invalid filters." } };
  }

  const result = await exportData(context, "student_list", parsedFilters.data, parsedFormat.data);
  return toResult(result);
}

// Re-exported purely so callers/tests can reference the entity-type union
// without importing lib/export/export-data.ts directly for just this type.
export type { ExportEntityType };
