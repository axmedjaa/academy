import {
  fetchAuditLogs,
  type AuditLogFilters,
  type AuditLogPagination,
  type AuditLogQueryResult,
} from "@/lib/audit-query";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * "My Activity" — every authenticated user's own personal view onto the
 * same `audit_logs` table `/academy/audit-logs` and `/platform/audit-logs`
 * already read (lib/audit-query.ts's `fetchAuditLogs`), reused as-is: no
 * second audit system, no new table, no new write path. Those two pages are
 * *oversight* views (Academy Owner/Admin see their whole academy; a
 * platform admin with the `queryAuditLogs` grant sees the whole platform) —
 * this one is the opposite: every signed-in user, regardless of role or
 * permission, but hard-scoped to rows where they are the actor, never any
 * other user's.
 *
 * Every field below except `actorUserId` may come from the caller (the
 * page's own filter form); `actorUserId` is never one of them — it is not
 * even a field of `MyActivityFilters` (Omit, enforced at the type level,
 * same device `lib/academies/audit-logs.ts`'s `AcademyAuditLogFilters`
 * already uses for `academyId`), and is instead always the resolved
 * `actorContext.userId`, applied *after* spreading the caller's filters so
 * nothing resembling a client-supplied value — however it got there — can
 * ever override it.
 */
export type MyActivityFilters = Omit<
  AuditLogFilters,
  "actorUserId" | "actorRole" | "academyId" | "branchId"
>;

/**
 * Pure logic behind the `getMyActivity` server action
 * (lib/my-activity-actions.ts). Unlike `getAcademyAuditLogs`/
 * `queryAuditLogs`, there is no permission gate beyond being signed in —
 * every user is always allowed to see their own activity, so `actorContext`
 * here only supplies whose rows to read, never a capability to check.
 */
export async function getMyActivity(
  actorContext: AuthContext,
  filters: MyActivityFilters = {},
  pagination: AuditLogPagination = {},
): Promise<AuditLogQueryResult> {
  return fetchAuditLogs({ ...filters, actorUserId: actorContext.userId }, pagination);
}
