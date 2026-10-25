"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AdmissionsRow } from "@/lib/academies/students";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { Badge, Button, EmptyState, FormDialog, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { EnrollCoursesDialog } from "@/app/academy/_shell/enroll-courses-dialog";
import { Icon } from "@/app/academy/_shell/icons";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { StudentAvatar } from "@/app/academy/students/student-avatar";
import { formatDate } from "@/lib/ui/date";

interface Props {
  admissions: AdmissionsRow[];
  /** Whether the caller can edit students at all (Full/Manage) — gates
   * whether the "Review" action (into `/academy/students`'s edit form) is
   * shown. Read-only callers (Finance, Trainer) still see the board. */
  canManage: boolean;
  /** Independent of `canManage` — ACADEMY_COURSES_BATCHES_ACTION's own
   * "full"/"manage" gate (the exact permission `enrollStudentInBatch`
   * itself checks), reused verbatim from `listBatches`' own `canManage`
   * rather than re-derived here. Gates ONLY the "Enroll" action — a role
   * with `canManage` (student edit rights) but not `canEnroll` (e.g. a
   * hypothetical role with no course/batch management) would still see
   * Review but never Enroll, and vice versa. */
  canEnroll: boolean;
  /** Planned and active batches with the courses each runs (scoped). */
  enrollBatches: EnrollBatchOption[];
  /** Each photo-having row's own short-lived signed R2 GET url,
   * pre-resolved server-side (page.tsx, via students.ts's
   * `getStudentPhotoUrl`) — see StudentAvatar's own doc comment. */
  photoUrlByStudentId: Map<string, string>;
  /** Server-rendered filter bar (search, branch) placed under the header. */
  filters: ReactNode;
}

/** Design row button (secondary): 40px, bordered, 13px semibold. */
const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold !text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline";

export function AdmissionsList({ admissions, canManage, canEnroll: canEnrollRole, enrollBatches, photoUrlByStudentId, filters }: Props) {
  // Enroll is offered only when there is a planned or active batch to join.
  const canEnroll = canEnrollRole && enrollBatches.length > 0;
  const router = useRouter();
  // Photo preview, kept from the previous list (clicking a student's photo
  // opens the full view, as on Students).
  const [previewRowId, setPreviewRowId] = useState<string | null>(null);
  const previewRow = admissions.find((row) => row.id === previewRowId) ?? null;

  // Which student's Enroll dialog is open (a row's Enroll button), or the
  // header's "Enroll a student", which picks the student in the dialog.
  const [enrollingId, setEnrollingId] = useState<string | null>(null);
  const enrollingRow = admissions.find((row) => row.id === enrollingId) ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const refresh = () => router.refresh();

  return (
    <>
      <PageHeader
        title="Admissions"
        description="Active students who are not enrolled in a batch yet. Enrolling moves them off this list."
        actions={
          canEnroll && admissions.length > 0 ? (
            <Button type="button" onClick={() => setPickerOpen(true)}>
              Enroll a student
            </Button>
          ) : undefined
        }
      />

      {filters}

      {admissions.length === 0 ? (
        <Section>
          <EmptyState message="No students currently need admissions attention." icon={<Icon name="group" />} />
        </Section>
      ) : (
        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>Stage</th>
              <th className={rtTh}>Registered</th>
              {(canManage || canEnroll) && <th className={`${rtTh} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {admissions.map((row) => (
              <tr key={row.id} className={trHover}>
                <td className={rtTd} data-label="Student">
                  <span className="flex min-w-0 items-center gap-3">
                    <StudentAvatar
                      fullName={row.fullName}
                      photoUrl={photoUrlByStudentId.get(row.id) ?? null}
                      sizeClassName="h-10 w-10 ring-2 ring-white shadow-[0_0_0_1px_#E2E5EA]"
                      onPreview={() => setPreviewRowId(row.id)}
                    />
                    <span className="min-w-0">
                      {row.fullName}, <span className="tabular-nums">{row.studentNumber}</span>
                    </span>
                  </span>
                </td>
                <td className={rtTd} data-label="Stage">
                  <Badge label="Applied" tone="amber" />
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Registered">
                  {formatDate(row.createdAt)}
                </td>
                {(canManage || canEnroll) && (
                  <td className={`${rtTd} text-right`} data-actions="">
                    {canEnroll ? (
                      <button type="button" onClick={() => setEnrollingId(row.id)} className={ROW_BTN}>
                        Enroll
                      </button>
                    ) : (
                      <Link href={`/academy/students?q=${encodeURIComponent(row.studentNumber)}`} className={ROW_BTN}>
                        Review
                      </Link>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        {canEnrollRole && enrollBatches.length === 0
          ? "No planned or active batch is open for enrollment yet. Create one in Batches, then enroll from here."
          : canEnroll
          ? "Enroll picks a batch and one or more of its courses. Each course always gets its own fee schedule."
          : "Enrolling needs course and batch management access, which this role does not have, so no Enroll control is shown."}
      </NoteBlock>

      {canEnroll && (
        <EnrollCoursesDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          students={admissions.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber }))}
          batches={enrollBatches}
          enrolledPairs={{}}
          onEnrolled={refresh}
        />
      )}

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

      {canEnroll && enrollingRow && (
        <EnrollCoursesDialog
          open={enrollingId !== null}
          onOpenChange={(nextOpen) => !nextOpen && setEnrollingId(null)}
          student={{ id: enrollingRow.id, fullName: enrollingRow.fullName, studentNumber: enrollingRow.studentNumber }}
          batches={enrollBatches}
          enrolledPairs={{}}
          onEnrolled={refresh}
        />
      )}
    </>
  );
}
