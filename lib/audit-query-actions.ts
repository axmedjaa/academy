"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  AUDIT_LOG_MAX_PAGE_SIZE,
  fetchAuditLogs,
  type AuditLogFilters,
  type AuditLogPagination,
  type AuditLogQueryResult,
} from "@/lib/audit-query";

// Cross-Cutting Architecture Decisions: "every server action has a Zod
// schema for its input."
const filtersSchema = z.object({
  actorUserId: z.string().uuid().optional(),
  actorRole: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  academyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  result: z.enum(["success", "failure"]).optional(),
  createdFrom: z.date().optional(),
  createdTo: z.date().optional(),
});

const paginationSchema = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(AUDIT_LOG_MAX_PAGE_SIZE).optional(),
});

export type QueryAuditLogsError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "VALIDATION_ERROR"; message: string };

export type QueryAuditLogsState =
  | { ok: true; data: AuditLogQueryResult }
  | { ok: false; error: QueryAuditLogsError };

const ACCESS_DENIED_MESSAGE = "You don't have permission to view audit logs.";

/**
 * PLAN.md Item 32's named server action: `/platform/audit-logs`' data
 * source. Gated by hasPermission(context, "queryAuditLogs") — grantable to
 * platform_admin per grant (Master Permission Matrix: "View platform audit
 * logs | Full | Per grant"), always available to platform_owner.
 *
 * API & Server-Action Contract: a caller who lacks permission gets the
 * exact same UNAUTHORIZED response no matter what filters they passed —
 * nothing about whether matching rows exist is ever leaked through a
 * different error shape.
 */
export async function queryAuditLogs(
  rawFilters: AuditLogFilters = {},
  rawPagination: AuditLogPagination = {},
): Promise<QueryAuditLogsState> {
  const context = await getAuthContext();
  if (!context) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Sign in required." },
    };
  }

  const allowed = await hasPermission(context, "queryAuditLogs");
  if (!allowed) {
    return {
      ok: false,
      error: { code: "UNAUTHORIZED", message: ACCESS_DENIED_MESSAGE },
    };
  }

  const parsedFilters = filtersSchema.safeParse(rawFilters);
  if (!parsedFilters.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parsedFilters.error.issues[0]?.message ?? "Invalid filter.",
      },
    };
  }

  const parsedPagination = paginationSchema.safeParse(rawPagination);
  if (!parsedPagination.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parsedPagination.error.issues[0]?.message ?? "Invalid pagination.",
      },
    };
  }

  const data = await fetchAuditLogs(parsedFilters.data, parsedPagination.data);
  return { ok: true, data };
}
