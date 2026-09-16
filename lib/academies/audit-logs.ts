import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_AUDIT_LOG_ACTION, hasAcademyPermission } from "@/lib/auth/academy-permissions";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  fetchAuditLogs,
  type AuditLogFilters,
  type AuditLogPagination,
  type AuditLogQueryResult,
} from "@/lib/audit-query";

/**
 * PLAN.md Phase 2, Item 42 — "`/academy/audit-logs` route (Owner/Admin
 * only)". Server actions/API boundaries §4 names this as `queryAuditLogs`
 * "reused from Phase 1, scoped to the caller's `academy_id`" — but the
 * *existing* `queryAuditLogs` server action (lib/audit-query-actions.ts) is
 * the platform-side one: it gates on `hasPermission(context,
 * "queryAuditLogs")`, a grantable platform capability, and lets the caller
 * pass any `academyId` it likes (that's correct for a platform viewer
 * cross-academy). Neither of those is right for this item: Owner/Admin is
 * an *academy*-role gate (Master Permission Matrix "Academy audit log
 * (view)": Full/Full/—/—/—/—, "n/a (Owner/Admin only, Decision #15)"), and
 * §6's security rule is explicit — "hard-scoped to the caller's own
 * `academy_id` — never accepts a client-supplied academy filter."
 *
 * So this is a *second*, academy-scoped entry point onto the same
 * underlying `fetchAuditLogs` (lib/audit-query.ts, Item 32a) the platform
 * action also calls — reused directly here rather than routed through the
 * platform action, per the task brief. `academyId` is deliberately not a
 * field of `AcademyAuditLogFilters` (see below): the type system, not just
 * a runtime check, makes a client-supplied academy filter impossible to
 * plumb through this path.
 */

const FORBIDDEN_MESSAGE = "You don't have permission to view this academy's audit log.";

export interface AcademyAuditLogActionError {
  code: "forbidden" | "blocked";
  message: string;
}

/**
 * Every `AuditLogFilters` field except `academyId` — the caller (the
 * end user, via the page's filter form) may narrow by actor, action,
 * branch, result, or date range, but can never supply an academy, since
 * that column is hard-set below to the academy resolved by
 * `checkAcademyAccessForContext`.
 */
export type AcademyAuditLogFilters = Omit<AuditLogFilters, "academyId">;

export type AcademyAuditLogsResult =
  | { ok: true; data: AuditLogQueryResult }
  | { ok: false; error: AcademyAuditLogActionError };

/**
 * Pure logic behind the `getAcademyAuditLogs` server action
 * (lib/academies/audit-logs-actions.ts). Resolves the caller's own academy
 * + role via `checkAcademyAccessForContext` (Item 27, not modified here),
 * gates on the new `academy.audit_log` row (Owner/Admin `full`, every other
 * role `none` per lib/auth/academy-permissions.ts), then calls
 * `fetchAuditLogs` directly with `filters.academyId` hard-set to the
 * resolved academy — `filters` here can never carry an `academyId` key at
 * all (see `AcademyAuditLogFilters`), so there is no client input to
 * override even if a caller tried to spread one in.
 *
 * "grace" (Past Due, within the 7-day window) is treated as fully
 * functional, matching every other Item-41-style academy action's
 * precedent (lib/academies/settings.ts) — only "blocked" refuses the read.
 */
export async function getAcademyAuditLogs(
  actorContext: AuthContext,
  filters: AcademyAuditLogFilters = {},
  pagination: AuditLogPagination = {},
): Promise<AcademyAuditLogsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  if (!hasAcademyPermission(access.membershipRole, ACADEMY_AUDIT_LOG_ACTION)) {
    return { ok: false, error: { code: "forbidden", message: FORBIDDEN_MESSAGE } };
  }

  const data = await fetchAuditLogs(
    { ...filters, academyId: access.academyId },
    pagination,
  );

  return { ok: true, data };
}
