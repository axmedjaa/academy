"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getPlatformReports,
  getRevenueBreakdown,
  revenueBreakdownToCsv,
  REVENUE_VIEW_CAPABILITY,
  type GetPlatformReportsParams,
  type PlatformReportsResult,
  type RevenueGroupBy,
} from "@/lib/subscriptions/reports";

// PLAN.md Item 32b: "getPlatformReports (with breakdown params)". Zod schema
// per Cross-Cutting Architecture Decisions ("every server action has a Zod
// schema for its input") — same shape/convention as
// lib/audit-query-actions.ts's filtersSchema/paginationSchema.
const paramsSchema = z.object({
  groupBy: z.enum(["month", "plan", "academy", "method"]).optional(),
  trendMonths: z.number().int().min(1).max(36).optional(),
  expiringWithinDays: z.number().int().min(1).max(365).optional(),
});

export type PlatformReportsActionError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "VALIDATION_ERROR"; message: string };

export type GetPlatformReportsActionState =
  | { ok: true; data: PlatformReportsResult }
  | { ok: false; error: PlatformReportsActionError };

/**
 * `/platform/reports`' data source. Gated by
 * hasPermission(context, "getPlatformReports") inside getPlatformReports()
 * itself — grantable to a platform_admin per grant (covering only the
 * non-revenue sections), always available to platform_owner. The revenue
 * sub-section's own ungrantable gate (`platform.revenue.view`) is enforced
 * a second time, independently, inside getPlatformReports() — see
 * lib/subscriptions/reports.ts's module comment.
 *
 * Also used to refetch when the group-by dimension changes on the client
 * (app/platform/reports/reports-manager.tsx) — this refetches the whole
 * report bundle (trend + expiring list included) rather than just the
 * revenue rows, trading a little redundant work for one simple action;
 * fine at platform-admin scale (no different in spirit from
 * lib/subscriptions/usage.ts's batch-fetch-and-reduce-in-memory reasoning).
 */
export async function getPlatformReportsAction(
  rawParams: GetPlatformReportsParams = {},
): Promise<GetPlatformReportsActionState> {
  const context = await getAuthContext();
  if (!context) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Sign in required." },
    };
  }

  const parsed = paramsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid parameters.",
      },
    };
  }

  const result = await getPlatformReports(context, parsed.data);
  if (!result.ok) {
    return {
      ok: false,
      error: { code: "UNAUTHORIZED", message: result.error.message },
    };
  }

  return { ok: true, data: result.data };
}

export type ExportRevenueReportCsvActionState =
  | { ok: true; csv: string }
  | { ok: false; error: PlatformReportsActionError };

/**
 * The Export button's server-side half (see lib/subscriptions/reports.ts's
 * module comment for why this is the export mechanism). Deliberately
 * re-checks REVENUE_VIEW_CAPABILITY itself rather than trusting that the
 * client only ever renders the Export button when authorized — the same
 * defense-in-depth convention every mutating action in this codebase
 * follows (e.g. lib/subscriptions/payments.ts's verify/reject/reverse
 * actions each re-check their own capability rather than trusting the page
 * already did). A platform_admin can never get a CSV out of this action,
 * even by calling it directly, since REVENUE_VIEW_CAPABILITY is ungrantable.
 */
export async function exportRevenueReportCsvAction(
  groupBy?: RevenueGroupBy,
): Promise<ExportRevenueReportCsvActionState> {
  const context = await getAuthContext();
  if (!context) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Sign in required." },
    };
  }

  const allowed = await hasPermission(context, REVENUE_VIEW_CAPABILITY);
  if (!allowed) {
    return {
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "You don't have permission to export platform revenue reports.",
      },
    };
  }

  const parsedGroupBy = z
    .enum(["month", "plan", "academy", "method"])
    .optional()
    .safeParse(groupBy);
  if (!parsedGroupBy.success) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid group-by dimension." },
    };
  }

  const revenue = await getRevenueBreakdown(parsedGroupBy.data);
  return { ok: true, csv: revenueBreakdownToCsv(revenue) };
}
