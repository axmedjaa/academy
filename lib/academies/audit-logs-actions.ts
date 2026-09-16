"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  AUDIT_LOG_MAX_PAGE_SIZE,
  type AuditLogPagination,
  type AuditLogQueryResult,
} from "@/lib/audit-query";
import {
  getAcademyAuditLogs,
  type AcademyAuditLogFilters,
} from "@/lib/academies/audit-logs";

/**
 * "use server" wrapper for Item 42's academy-scoped audit log read, same
 * split as lib/audit-query-actions.ts (parse/authenticate here, pure logic
 * in lib/academies/audit-logs.ts). No `academyId` field exists anywhere in
 * this schema — Cross-Cutting Architecture Decisions' "every server action
 * has a Zod schema for its input" is satisfied without ever giving the
 * client a place to put one, matching PLAN.md §6's "never accepts a
 * client-supplied academy filter."
 */
const filtersSchema = z.object({
  actorUserId: z.string().uuid().optional(),
  actorRole: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  branchId: z.string().uuid().optional(),
  result: z.enum(["success", "failure"]).optional(),
  createdFrom: z.date().optional(),
  createdTo: z.date().optional(),
}) satisfies z.ZodType<AcademyAuditLogFilters>;

const paginationSchema = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(AUDIT_LOG_MAX_PAGE_SIZE).optional(),
});

export type AcademyAuditLogsError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "VALIDATION_ERROR"; message: string };

export type AcademyAuditLogsState =
  | { ok: true; data: AuditLogQueryResult }
  | { ok: false; error: AcademyAuditLogsError };

const UNAUTHENTICATED_MESSAGE = "Sign in required.";

/**
 * PLAN.md Item 42's `/academy/audit-logs` data source. Never takes an
 * `academyId` parameter — the underlying `getAcademyAuditLogs` resolves the
 * caller's own academy via `checkAcademyAccessForContext` and hard-scopes
 * the query to it. A caller who lacks permission (or whose academy access
 * is blocked) gets the same generic denial regardless of filters, matching
 * the platform action's own "nothing leaks through a different error
 * shape" convention.
 */
export async function getAuditLogsForOwnAcademy(
  rawFilters: AcademyAuditLogFilters = {},
  rawPagination: AuditLogPagination = {},
): Promise<AcademyAuditLogsState> {
  const context = await getAuthContext();
  if (!context) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: UNAUTHENTICATED_MESSAGE },
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

  const result = await getAcademyAuditLogs(context, parsedFilters.data, parsedPagination.data);
  if (!result.ok) {
    return {
      ok: false,
      error: { code: "UNAUTHORIZED", message: result.error.message },
    };
  }

  return { ok: true, data: result.data };
}
