"use server";

import { getAuthContext } from "@/lib/auth/auth-context";
import {
  getFinanceReports as getFinanceReportsForActor,
  type FinanceReportFiltersInput,
  type FinanceReportsActionError,
  type FinanceReportsData,
} from "@/lib/academies/finance-reports";

/**
 * PLAN.md Phase 4, Item 55's `getFinanceReports` server action — thin
 * `"use server"` wrapper over lib/academies/finance-reports.ts, same
 * convention as every other `*-actions.ts` file in this codebase. Unlike
 * the create/record actions elsewhere in Phase 4, this one has no form-data
 * parsing helper: it's a read with a small, already-typed filter object
 * (`FinanceReportFiltersInput`), called directly from a client filter
 * component (app/academy/finance-reports/finance-reports-filters.tsx) on
 * every filter change — there's no `revalidatePath` here either, since
 * nothing is mutated.
 */
const UNAUTHENTICATED: FinanceReportsActionError = {
  code: "blocked",
  message: "You must be signed in.",
};

export type GetFinanceReportsActionResult =
  | { ok: true; report: FinanceReportsData }
  | { ok: false; error: FinanceReportsActionError };

export async function getFinanceReportsAction(
  filters: FinanceReportFiltersInput = {},
): Promise<GetFinanceReportsActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  return getFinanceReportsForActor(context, filters);
}
