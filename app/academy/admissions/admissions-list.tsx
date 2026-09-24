import Link from "next/link";
import type { AdmissionsRow } from "@/lib/academies/students";
import { Badge, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";

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
function stageBadge(row: AdmissionsRow): { label: string; tone: "amber" | "blue" } {
  if (!row.hasDocuments) {
    return { label: "Documents pending", tone: "amber" };
  }
  return { label: "Recently applied", tone: "blue" };
}

export function AdmissionsList({ admissions, canManage }: Props) {
  return (
    <TableWrap>
      <thead>
        <tr>
          <th className={th}>Student #</th>
          <th className={th}>Name</th>
          <th className={th}>Stage</th>
          <th className={th}>Registered</th>
          {canManage && <th className={th}>Action</th>}
        </tr>
      </thead>
      <tbody>
        {admissions.length === 0 ? (
          <tr>
            <td colSpan={canManage ? 5 : 4} className={`${td} text-center text-muted`}>
              No students currently need admissions attention.
            </td>
          </tr>
        ) : (
          admissions.map((row) => {
            const badge = stageBadge(row);
            return (
              <tr key={row.id} className={trHover}>
                <td className={`${td} font-medium`}>{row.studentNumber}</td>
                <td className={td}>{row.fullName}</td>
                <td className={td}>
                  <Badge label={badge.label} tone={badge.tone} />
                </td>
                <td className={td}>
                  {row.daysSinceRegistered === 0 ? "Today" : `${row.daysSinceRegistered}d ago`}
                </td>
                {canManage && (
                  <td className={td}>
                    <Link
                      href={`/academy/students?q=${encodeURIComponent(row.studentNumber)}`}
                      className="text-sm text-brand hover:underline"
                    >
                      Review
                    </Link>
                  </td>
                )}
              </tr>
            );
          })
        )}
      </tbody>
    </TableWrap>
  );
}
