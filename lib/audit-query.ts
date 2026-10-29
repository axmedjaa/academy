import { and, count, desc, eq, gte, ilike, lte, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import { LIST_PAGE_SIZE_MAX } from "@/lib/ui/pagination";

// PLAN.md "Pagination, Search & Export Limits" (Planning Gaps Resolution §9)
// — the project-wide rule, applied here since this is the first real list
// page that needs it: default 15 / max 100 / offset-based (page, pageSize).
/** Rows per page and the most any client-callable list action accepts. */
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = LIST_PAGE_SIZE_MAX;
export const AUDIT_LOG_MAX_PAGE_SIZE = LIST_PAGE_SIZE_MAX;
/** Ceiling for server-only batch reads (CSV/JSON export), never a displayed page. */
export const AUDIT_LOG_BATCH_PAGE_SIZE = 100;

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
  /**
   * Free-text search (the Platform audit log's search box): a
   * case-insensitive substring match on the action, the entity type, the
   * entity id, or the actor's email.
   */
  search?: string;
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
  if (filters.search) {
    // Escape LIKE wildcards so the text is matched literally.
    const pattern = `%${filters.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const searchCondition = or(
      ilike(auditLogs.action, pattern),
      ilike(auditLogs.entityType, pattern),
      sql`${auditLogs.entityId}::text ilike ${pattern}`,
      inArray(auditLogs.actorUserId, db.select({ id: users.id }).from(users).where(ilike(users.email, pattern))),
    );
    if (searchCondition) conditions.push(searchCondition);
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
  return Math.min(Math.max(requested, 1), AUDIT_LOG_BATCH_PAGE_SIZE);
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

/**
 * Both audit-log pages (`/academy/audit-logs`, `/platform/audit-logs`)
 * previously rendered only `row.actorRole` ("manager", "academy_owner", ...)
 * with no way to tell apart two different people holding the same role —
 * every "manager" row looked identical, which reads as "I can only see my
 * own actions" even though every actor's rows were always present (the
 * query itself was never scoped to the caller's own `actorUserId` anywhere
 * in this codebase; `auditLogs.actorUserId` was simply never surfaced in the
 * UI). This resolves the real identity behind each row's `actorUserId`, the
 * same "batch-fetch by id, build a Map" pattern already used for recent
 * payments' student names (lib/academies/dashboard.ts) — one extra indexed
 * query, not a join, so `fetchAuditLogs`'s own return shape (relied on by
 * its existing tests and the CSV export) stays untouched.
 */
export async function resolveAuditActorEmails(
  rows: AuditLogRow[],
  executor: DbClient = db,
): Promise<Record<string, string>> {
  const actorUserIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => id !== null))];
  if (actorUserIds.length === 0) return {};

  const actorRows = await executor
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, actorUserIds));

  return Object.fromEntries(actorRows.map((row) => [row.id, row.email]));
}
