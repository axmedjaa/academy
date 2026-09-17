import Link from "next/link";
import type { AdmissionsRow } from "@/lib/academies/students";

interface Props {
  admissions: AdmissionsRow[];
  /** Whether the caller can edit students at all (Full/Manage) — gates
   * whether the "Review" link (into `/academy/students`'s edit form) is
   * shown. Read-only callers (Finance, Trainer) still see the board. */
  canManage: boolean;
}

/**
 * Renders the two schema-realistic admissions "stages" as badges rather
 * than DESIGN.md's literal 3-column board — see
 * lib/academies/students.ts's getAdmissionsView doc comment for why a
 * literal Applied/Documents Pending/Enrolled pipeline isn't buildable
 * against the current `students` schema. "Documents pending" takes
 * priority when both are true (it's the more actionable flag for an
 * admissions worker).
 */
function stageBadge(row: AdmissionsRow): { label: string; color: string } {
  if (!row.hasDocuments) {
    return { label: "Documents pending", color: "#b45309" };
  }
  return { label: "Recently applied", color: "#1d4ed8" };
}

export function AdmissionsList({ admissions, canManage }: Props) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
          <th style={{ padding: "0.5rem" }}>Student #</th>
          <th style={{ padding: "0.5rem" }}>Name</th>
          <th style={{ padding: "0.5rem" }}>Stage</th>
          <th style={{ padding: "0.5rem" }}>Registered</th>
          {canManage && <th style={{ padding: "0.5rem" }}>Action</th>}
        </tr>
      </thead>
      <tbody>
        {admissions.length === 0 ? (
          <tr>
            <td colSpan={canManage ? 5 : 4} style={{ padding: "0.5rem", color: "#666" }}>
              No students currently need admissions attention.
            </td>
          </tr>
        ) : (
          admissions.map((row) => {
            const badge = stageBadge(row);
            return (
              <tr key={row.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{row.studentNumber}</td>
                <td style={{ padding: "0.5rem" }}>{row.fullName}</td>
                <td style={{ padding: "0.5rem" }}>
                  <span
                    style={{
                      color: badge.color,
                      border: `1px solid ${badge.color}`,
                      borderRadius: 4,
                      padding: "0.1rem 0.5rem",
                      fontSize: "0.8rem",
                    }}
                  >
                    {badge.label}
                  </span>
                </td>
                <td style={{ padding: "0.5rem" }}>
                  {row.daysSinceRegistered === 0 ? "Today" : `${row.daysSinceRegistered}d ago`}
                </td>
                {canManage && (
                  <td style={{ padding: "0.5rem" }}>
                    <Link href={`/academy/students?q=${encodeURIComponent(row.studentNumber)}`}>
                      Review
                    </Link>
                  </td>
                )}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
