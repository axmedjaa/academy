"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  updateStudentEnrollment,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type { AdmissionsRow } from "@/lib/academies/students";
import {
  Badge,
  Button,
  EmptyState,
  ErrorMessage,
  Field,
  FormDialog,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentAvatar } from "@/app/academy/students/student-avatar";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface CourseOption {
  batchId: string;
  label: string;
}

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
  /** Every non-archived batch, labeled with its course name — same shape
   * and same source query as app/academy/students/page.tsx's own
   * `courseOptions` for its "change course" dialog. */
  courseOptions: CourseOption[];
  /** Each photo-having row's own short-lived signed R2 GET url,
   * pre-resolved server-side (page.tsx, via students.ts's
   * `getStudentPhotoUrl`) — see StudentAvatar's own doc comment. */
  photoUrlByStudentId: Map<string, string>;
}

/**
 * Post-audit revision: this screen now represents the "Applied" (not-yet-
 * enrolled) side of a two-stage Applied -> Enrolled model, not DESIGN.md's
 * literal 3-stage Applied/Documents-Pending/Enrolled board — see
 * lib/academies/students.ts's getAdmissionsView doc comment for the full
 * "why" (document presence was never a real, reachable signal; enrollment
 * is). Every row `getAdmissionsView` returns already has `isEnrolled ===
 * false` by construction (an enrolled student is excluded from the query
 * entirely, not flagged here) — so there is only ever one stage left to
 * show on this screen, and no per-row branching is needed.
 */
function stageBadge(): { label: string; tone: "amber" } {
  return { label: "Applied", tone: "amber" };
}

export function AdmissionsList({ admissions, canManage, canEnroll, courseOptions, photoUrlByStudentId }: Props) {
  const router = useRouter();
  // Which row's photo preview is open — same controlled pattern as
  // app/academy/students/students-list.tsx's own previewRowId, so clicking
  // a student's photo here opens the same full-view dialog Students
  // already has, rather than being a dead, non-interactive thumbnail.
  const [previewRowId, setPreviewRowId] = useState<string | null>(null);
  const previewRow = admissions.find((row) => row.id === previewRowId) ?? null;

  // Which row's Enroll dialog is open — same controlled-dialog-outside-
  // the-dropdown pattern as students-list.tsx's own paymentRowId/
  // archiveRowId.
  const [enrollingId, setEnrollingId] = useState<string | null>(null);
  const enrollingRow = admissions.find((row) => row.id === enrollingId) ?? null;

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
          {(canManage || canEnroll) && <th className={th}>Actions</th>}
        </tr>
      </thead>
      <tbody>
        {admissions.map((row) => {
          const badge = stageBadge();
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
              {(canManage || canEnroll) && (
                <td className={td}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Actions for ${row.fullName}`}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-control text-muted transition-[color,background-color,border-color,transform] duration-150 ease-out hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                      >
                        <Icon name="more" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canManage && (
                        <DropdownMenuItem asChild>
                          <Link href={`/academy/students?q=${encodeURIComponent(row.studentNumber)}`}>Review</Link>
                        </DropdownMenuItem>
                      )}
                      {canEnroll && (
                        <DropdownMenuItem onClick={() => setEnrollingId(row.id)}>Enroll</DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
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

    {enrollingRow && (
      <EnrollDialog
        open={enrollingId !== null}
        onOpenChange={(nextOpen) => !nextOpen && setEnrollingId(null)}
        studentId={enrollingRow.id}
        studentName={enrollingRow.fullName}
        studentNumber={enrollingRow.studentNumber}
        courseOptions={courseOptions}
        onEnrolled={() => {
          setEnrollingId(null);
          router.refresh();
        }}
      />
    )}
    </>
  );
}

const initialEnrollmentState: BatchAssignmentFormState = { ok: false };

/** Mirrors lib/db/schema.ts's FEE_INTERVAL_MONTHS_OPTIONS — same list as
 * app/academy/batches/[batchId]/roster-panel.tsx's enroll form,
 * app/academy/students/students-list.tsx's "change course" dialog, and
 * app/academy/students/new/student-form.tsx's registration-time form
 * (this codebase's established convention: duplicate this short, stable
 * list per call site rather than share an import for it). */
const PAYMENT_PLAN_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monthly" },
  { value: 2, label: "Every 2 Months" },
  { value: 3, label: "Every 3 Months" },
  { value: 4, label: "Every 4 Months" },
  { value: 6, label: "Every 6 Months" },
  { value: 12, label: "Yearly" },
];

/**
 * The Admissions "Enroll" dialog — a centered `FormDialog`, matching this
 * app's established "edit/enrollment forms appear as a centered modal, not
 * a form permanently rendered under the table" convention (see
 * app/academy/_shell/ui.tsx's FormDialog and every other dialog built on
 * it this session). Not a parallel enrollment implementation: this calls
 * the exact same `updateStudentEnrollment` Server Action
 * app/academy/students/students-list.tsx's own "change course" dialog
 * already uses — which itself calls `enrollStudentInBatch`
 * (lib/academies/batch-assignments.ts) unchanged, so every existing
 * guarantee (the required payment plan, the permission check, branch/
 * Trainer/academy scoping, the atomic enrollment+schedule+first-period
 * transaction) applies here exactly as it already does everywhere else.
 * An Admissions candidate has no active enrollment by definition (that's
 * the whole reason they're on this screen), so this only ever needs the
 * "enroll into a new batch" half of that function's behavior — no
 * "current course" display, no withdraw-first step.
 */
function EnrollDialog({
  open,
  onOpenChange,
  studentId,
  studentName,
  studentNumber,
  courseOptions,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentId: string;
  studentName: string;
  studentNumber: string;
  courseOptions: CourseOption[];
  onEnrolled: () => void;
}) {
  const [state, formAction, isPending] = useActionState(updateStudentEnrollment, initialEnrollmentState);
  const [batchId, setBatchId] = useState("");

  useEffect(() => {
    if (state.ok) showSuccessToast("Student enrolled.");
    else if (state.error) showErrorToast(state.error.message);
  }, [state]);

  // Auto-close once enrollment actually succeeds — the functional
  // equivalent of "redirect back to Admissions" (this dialog IS the
  // Admissions page; closing it and letting the parent's `onEnrolled`
  // trigger a `router.refresh()` is what makes the now-enrolled student
  // disappear from the list immediately). Same "adjust state during
  // render" pattern as students-list.tsx's identical dialog.
  const [prevOk, setPrevOk] = useState(state.ok);
  if (state.ok !== prevOk) {
    setPrevOk(state.ok);
    if (state.ok) onEnrolled();
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Enroll ${studentName}`}
    >
      <p className="mb-4 text-sm text-muted">
        {studentName} <span className="text-muted/70">({studentNumber})</span> — select a course and set up their
        initial payment plan. Every enrollment requires one; there is no enrollment without a payment plan.
      </p>
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="studentId" value={studentId} />
        <Field label="Course / batch">
          <select
            name="batchId"
            required
            value={batchId}
            onChange={(event) => setBatchId(event.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Select a course
            </option>
            {courseOptions.map((option) => (
              <option key={option.batchId} value={option.batchId}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment Plan">
          <select name="paymentPlanIntervalMonths" required defaultValue="1" className={inputClass}>
            {PAYMENT_PLAN_INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Total Fee (USD)">
          <input
            type="number"
            name="paymentPlanAmountDollars"
            min={0.01}
            step="0.01"
            placeholder="0.00"
            required
            className={inputClass}
          />
        </Field>
        {state.error && <ErrorMessage message={state.error.message} />}
        <div className="mt-2 flex gap-2">
          <Button type="submit" disabled={isPending || !batchId}>
            {isPending ? "Enrolling..." : "Enroll"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
