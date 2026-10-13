"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  AUDIT_LOG_MAX_PAGE_SIZE,
  type AuditLogPagination,
  type AuditLogQueryResult,
} from "@/lib/audit-query";
import { getMyActivity as getMyActivityForActor, type MyActivityFilters } from "@/lib/my-activity";

// Cross-Cutting Architecture Decisions: "every server action has a Zod
// schema for its input." No `actorUserId`/`academyId`/`branchId`/`actorRole`
// field exists here — same "never give the client a place to put one"
// convention as lib/academies/audit-logs-actions.ts's own filtersSchema.
const filtersSchema = z.object({
  action: z.string().trim().min(1).max(200).optional(),
  result: z.enum(["success", "failure"]).optional(),
  createdFrom: z.date().optional(),
  createdTo: z.date().optional(),
}) satisfies z.ZodType<MyActivityFilters>;

const paginationSchema = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(AUDIT_LOG_MAX_PAGE_SIZE).optional(),
});

export type MyActivityError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "VALIDATION_ERROR"; message: string };

export type MyActivityState =
  | { ok: true; data: AuditLogQueryResult }
  | { ok: false; error: MyActivityError };

const UNAUTHENTICATED_MESSAGE = "Sign in required.";

/**
 * `/account/activity`'s data source. The only gate is authentication —
 * every signed-in user may read this, since it never returns anyone else's
 * rows: `getMyActivity` (lib/my-activity.ts) hard-scopes to
 * `getAuthContext()`'s own resolved `userId`, which this action reads from
 * the session cookie server-side and never from any client-suppliable
 * value (URL param, form field, or otherwise).
 */
export async function getMyActivity(
  rawFilters: MyActivityFilters = {},
  rawPagination: AuditLogPagination = {},
): Promise<MyActivityState> {
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

  const data = await getMyActivityForActor(context, parsedFilters.data, parsedPagination.data);
  return { ok: true, data };
}
