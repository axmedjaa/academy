import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

// PLAN.md "Pagination, Search & Export Limits" (Planning Gaps Resolution §9)
// — the project-wide rule, applied here since this is the first real list
// page that needs it: default 25 / max 100 / offset-based (page, pageSize).
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 25;
export const AUDIT_LOG_MAX_PAGE_SIZE = 100;

export type AuditResult = "success" | "failure";

/**
 * Filters accepted by fetchAuditLogs. Every field is a plain scalar the
 * caller (the queryAuditLogs server action) has already Zod-validated —
 * this function does no validation of its own, matching the project's
 * existing split between a "use server" action (parses/authorizes) and the
 * pure logic it calls (e.g. lib/auth/session-actions.ts -> lib/auth/session.ts).
 */
export interface AuditLogFilters {
  actorUserId?: string;
  actorRole?: string;
  action?: string;
  academyId?: string;
  branchId?: string;
  result?: AuditResult;
  /** Inclusive lower bound on createdAt. */
  createdFrom?: Date;
  /** Inclusive upper bound on createdAt. */
  createdTo?: Date;
}

export interface AuditLogPagination {
  /** 1-based page number. Defaults to 1; values below 1 are clamped to 1. */
  page?: number;
  /**
   * Defaults to AUDIT_LOG_DEFAULT_PAGE_SIZE; clamped to
   * [1, AUDIT_LOG_MAX_PAGE_SIZE] rather than rejected, since a too-large
   * request is not a client error worth failing the whole call over.
   */
  pageSize?: number;
}

export type AuditLogRow = typeof auditLogs.$inferSelect;

export interface AuditLogQueryResult {
  rows: AuditLogRow[];
  page: number;
  pageSize: number;
  totalCount: number;
}

function buildWhereClause(filters: AuditLogFilters): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.actorUserId) {
    conditions.push(eq(auditLogs.actorUserId, filters.actorUserId));
  }
  if (filters.actorRole) {
    conditions.push(eq(auditLogs.actorRole, filters.actorRole));
  }
  if (filters.action) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters.academyId) {
    conditions.push(eq(auditLogs.academyId, filters.academyId));
  }
  if (filters.branchId) {
    conditions.push(eq(auditLogs.branchId, filters.branchId));
  }
  if (filters.result) {
    conditions.push(eq(auditLogs.result, filters.result));
  }
  if (filters.createdFrom) {
    conditions.push(gte(auditLogs.createdAt, filters.createdFrom));
  }
  if (filters.createdTo) {
    conditions.push(lte(auditLogs.createdAt, filters.createdTo));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function normalizePage(page: number | undefined): number {
  if (!page || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

function normalizePageSize(pageSize: number | undefined): number {
  const requested =
    pageSize && Number.isFinite(pageSize) ? Math.floor(pageSize) : AUDIT_LOG_DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(requested, 1), AUDIT_LOG_MAX_PAGE_SIZE);
}

/**
 * Pure query logic behind the `queryAuditLogs` server action (PLAN.md Item
 * 32). No permission check here — the caller (lib/audit-query-actions.ts)
 * is responsible for gating with hasPermission(context, "queryAuditLogs")
 * before ever calling this. Ordered by createdAt descending (most recent
 * first), offset-paginated per the project-wide pagination rule.
 *
 * `executor` defaults to the shared `db` but can be swapped for a
 * transaction client, matching the DbClient pattern used by recordAudit.
 */
export async function fetchAuditLogs(
  filters: AuditLogFilters = {},
  pagination: AuditLogPagination = {},
  executor: DbClient = db,
): Promise<AuditLogQueryResult> {
  const page = normalizePage(pagination.page);
  const pageSize = normalizePageSize(pagination.pageSize);
  const offset = (page - 1) * pageSize;
  const where = buildWhereClause(filters);

  const [rows, totalRows] = await Promise.all([
    executor
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(pageSize)
      .offset(offset),
    executor.select({ value: count() }).from(auditLogs).where(where),
  ]);

  return {
    rows,
    page,
    pageSize,
    totalCount: totalRows[0]?.value ?? 0,
  };
}
