import Link from "next/link";
import type { AdmissionsRow } from "@/lib/academies/students";
import { Badge, EmptyState, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";

interface Props {
  admissions: AdmissionsRow[];
  /** Whether the caller can edit students at all (Full/Manage) — gates
   * whether the "Review" link (into `/academy/students`'s edit form) is
   * shown. Read-only callers (Finance, Trainer) still see the board. */
  canManage: boolean;
}

/** Same avatar-style identity cue as students-list.tsx/staff-table.tsx's
 * own identical local copies, for a consistent "people list" visual
 * language across the app. */
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
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
  if (admissions.length === 0) {
    return (
      <Section>
        <EmptyState
          message="No students currently need admissions attention."
          icon={<Icon name="group" />}
        />
      </Section>
    );
  }

  return (
    <TableWrap>
      <thead>
        <tr>
          <th className={th}>Student</th>
          <th className={th}>Stage</th>
          <th className={th}>Registered</th>
          {canManage && <th className={th}>Action</th>}
        </tr>
      </thead>
      <tbody>
        {admissions.map((row) => {
          const badge = stageBadge(row);
          return (
            <tr key={row.id} className={trHover}>
              <td className={td}>
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">
                    {getInitials(row.fullName)}
                  </span>
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-ink">{row.fullName}</span>
                    <span className="block text-xs text-muted">{row.studentNumber}</span>
                  </div>
                </div>
              </td>
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
        })}
      </tbody>
    </TableWrap>
  );
}
