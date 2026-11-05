import type { AuditLogRow } from "@/lib/audit-query";
import { describeChanges, exportAction, exportDateTime, exportLabel, exportRole, recordNameFrom } from "@/lib/export/readable";
import { resolveAcademyNames, resolveBranchNames, resolveStaffNames } from "@/lib/export/resolve-names";

/**
 * Audit log rows -> the readable rows an audit export contains, shared by
 * the academy audit log export (lib/export/export-data.ts) and the
 * platform audit log export (lib/audit-query-actions.ts) so both read the
 * same way.
 *
 * Instead of internal ids and raw JSON, each row names who did what to
 * which record: the staff member's name (or account email), their role,
 * the branch and (platform only) the academy, the action in words, the
 * record's own name or reference where its snapshot has one, and a
 * readable summary of what changed. Request ids and browser user-agent
 * strings are left out; the IP address stays, as it matters when a
 * security reviewer reads an audit trail.
 */

export const ACADEMY_AUDIT_EXPORT_COLUMNS = [
  "Date & Time",
  "Staff Member",
  "Role",
  "Branch",
  "Action",
  "Record Type",
  "Record",
  "Result",
  "Reason",
  "Failure Reason",
  "Changes",
  "IP Address",
] as const;

export const PLATFORM_AUDIT_EXPORT_COLUMNS = [
  "Date & Time",
  "User",
  "Role",
  "Academy",
  "Branch",
  "Action",
  "Record Type",
  "Record",
  "Result",
  "Reason",
  "Failure Reason",
  "Changes",
  "IP Address",
] as const;

/**
 * @param academyId the academy every row belongs to (academy export), or
 *   null for the platform export, which spans academies and shows each
 *   row's academy by name.
 */
export async function toReadableAuditRows(rows: AuditLogRow[], academyId: string | null): Promise<Record<string, string>[]> {
  const [people, branchNames, academyNames] = await Promise.all([
    resolveStaffNames(academyId, rows.map((r) => r.actorUserId)),
    resolveBranchNames(academyId, rows.map((r) => r.branchId)),
    academyId ? Promise.resolve(new Map<string, string>()) : resolveAcademyNames(rows.map((r) => r.academyId)),
  ]);
  return rows.map((r) => {
    const row: Record<string, string> = {
      "Date & Time": exportDateTime(r.createdAt),
      Role: exportRole(r.actorRole),
      Branch: r.branchId ? (branchNames.get(r.branchId) ?? "") : "",
      Action: exportAction(r.action),
      "Record Type": exportLabel(r.entityType),
      Record: recordNameFrom(r.after, r.before),
      Result: exportLabel(r.result),
      Reason: r.reason ?? "",
      "Failure Reason": r.failureReason ?? "",
      Changes: describeChanges(r.before, r.after),
      "IP Address": r.ip ?? "",
    };
    const who = r.actorUserId ? (people.get(r.actorUserId) ?? "") : "System";
    if (academyId) {
      row["Staff Member"] = who;
    } else {
      row.User = who;
      row.Academy = r.academyId ? (academyNames.get(r.academyId) ?? "") : "Platform";
    }
    return row;
  });
}
