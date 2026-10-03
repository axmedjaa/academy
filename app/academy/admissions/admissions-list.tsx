"use client";

import { useState } from "react";
import Link from "next/link";
import type { AdmissionsRow } from "@/lib/academies/students";
import { Badge, Button, EmptyState, FormDialog, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentAvatar } from "@/app/academy/students/student-avatar";

interface Props {
  admissions: AdmissionsRow[];
  /** Whether the caller can edit students at all (Full/Manage) — gates
   * whether the "Review" link (into `/academy/students`'s edit form) is
   * shown. Read-only callers (Finance, Trainer) still see the board. */
  canManage: boolean;
  /** Each photo-having row's own short-lived signed R2 GET url,
   * pre-resolved server-side (page.tsx, via students.ts's
   * `getStudentPhotoUrl`) — see StudentAvatar's own doc comment. */
  photoUrlByStudentId: Map<string, string>;
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

export function AdmissionsList({ admissions, canManage, photoUrlByStudentId }: Props) {
  // Which row's photo preview is open — same controlled pattern as
  // app/academy/students/students-list.tsx's own previewRowId, so clicking
  // a student's photo here opens the same full-view dialog Students
  // already has, rather than being a dead, non-interactive thumbnail.
  const [previewRowId, setPreviewRowId] = useState<string | null>(null);
  const previewRow = admissions.find((row) => row.id === previewRowId) ?? null;

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
    <>
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
                  <StudentAvatar
                    fullName={row.fullName}
                    photoUrl={photoUrlByStudentId.get(row.id) ?? null}
                    sizeClassName="h-8 w-8"
                    onPreview={() => setPreviewRowId(row.id)}
                  />
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

    {previewRow && photoUrlByStudentId.has(previewRow.id) && (
      <FormDialog
        open={previewRowId !== null}
        onOpenChange={(nextOpen) => !nextOpen && setPreviewRowId(null)}
        title={`${previewRow.fullName}'s photo`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- see StudentAvatar's own comment. */}
        <img
          src={photoUrlByStudentId.get(previewRow.id)}
          alt={`${previewRow.fullName}'s profile photo`}
          className="max-h-[70vh] w-full rounded-md object-contain"
        />
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={() => setPreviewRowId(null)}>
            Close
          </Button>
        </div>
      </FormDialog>
    )}
    </>
  );
}
