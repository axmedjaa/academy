"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  assignTrainerToBatch,
  deleteBatchEnrollment,
  unassignTrainerFromBatch,
  withdrawStudentFromBatch,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type { BatchEnrollmentRosterRow, BatchTrainerAssignmentRosterRow } from "@/lib/academies/batch-assignments";
import type { BatchRecord } from "@/lib/academies/batches";
import { formatDate } from "@/lib/ui/date";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { BatchFormDialog, type BatchBranchOption, type BatchCourseOption } from "../batch-form";
import { EnrollCoursesDialog } from "@/app/academy/_shell/enroll-courses-dialog";
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedAssignTrainer = guardAction(assignTrainerToBatch);
const guardedUnassignTrainer = guardAction(unassignTrainerFromBatch);
const guardedWithdraw = guardAction(withdrawStudentFromBatch);

/**
 * Client half of the batch detail page (design A08 detail): the header
 * actions (Enroll a student, Assign trainer, Edit batch) with their design
 * form dialogs, and the Trainers and Enrolled students tables with their
 * row actions. Every action is an existing server action that re-checks
 * permission and branch scope; enrollment always creates the fee schedule.
 */

const initialState: BatchAssignmentFormState = { ok: false };

const HEADER_PRIMARY =
  "inline-flex h-11 items-center rounded-lg bg-brand px-[18px] text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover";
const HEADER_SECONDARY =
  "inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-[18px] text-[15px] font-semibold text-ink transition-colors duration-150 hover:bg-app";
const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

export interface StudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
}

export interface StaffOption {
  id: string;
  fullName: string;
}

/* ------------------------------------------------------------------ */
/* Header actions                                                      */
/* ------------------------------------------------------------------ */

export function BatchHeaderActions({
  batch,
  enrollBatch,
  enrolledPairs,
  students,
  studentsTruncated,
  staff,
  activeTrainerIds,
  branches,
  courses,
  canManage,
  canEdit,
}: {
  batch: BatchRecord;
  /** This batch as an enroll option (its courses), or null when not open for enrollment. */
  enrollBatch: EnrollBatchOption | null;
  enrolledPairs: Record<string, string[]>;
  students: StudentOption[];
  studentsTruncated: boolean;
  staff: StaffOption[];
  activeTrainerIds: string[];
  branches: BatchBranchOption[];
  courses: BatchCourseOption[];
  canManage: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<null | "enroll" | "trainer" | "edit">(null);
  const close = () => setDialog(null);
  const saved = () => {
    setDialog(null);
    router.refresh();
  };
  const archived = batch.status === "archived";

  return (
    <>
      {canManage && !archived && enrollBatch && (
        <button type="button" className={HEADER_PRIMARY} onClick={() => setDialog("enroll")}>
          Enroll a student
        </button>
      )}
      {canManage && !archived && (
        <button type="button" className={HEADER_SECONDARY} onClick={() => setDialog("trainer")}>
          Assign trainer
        </button>
      )}
      {canEdit && (
        <button type="button" className={HEADER_SECONDARY} onClick={() => setDialog("edit")}>
          Edit batch
        </button>
      )}

      {enrollBatch && (
        <EnrollCoursesDialog
          open={dialog === "enroll"}
          onOpenChange={(open) => !open && close()}
          title={`Enroll a student in ${batch.code}`}
          students={students}
          batches={[enrollBatch]}
          lockedBatchId={batch.id}
          enrolledPairs={enrolledPairs}
          studentsNote={studentsTruncated ? "Showing the first 100 active students. Search to narrow the list." : undefined}
          onEnrolled={saved}
        />
      )}
      <DesignDialog open={dialog === "trainer"} onOpenChange={(open) => !open && close()} title="Assign trainer">
        {dialog === "trainer" && (
          <TrainerFields batchId={batch.id} staff={staff.filter((s) => !activeTrainerIds.includes(s.id))} onCancel={close} onSaved={saved} />
        )}
      </DesignDialog>

      {canEdit && (
        <BatchFormDialog
          open={dialog === "edit"}
          onOpenChange={(open) => !open && close()}
          batch={batch}
          branches={branches}
          courses={courses}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  );
}

const TRAINER_RULES: DesignFormRule[] = [{ name: "staffProfileId", label: "Trainer", required: true, kind: "select" }];

function TrainerFields({
  batchId,
  staff,
  onCancel,
  onSaved,
}: {
  batchId: string;
  staff: StaffOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedAssignTrainer, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(TRAINER_RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Trainer assigned.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, [[/trainer|staff/i, "staffProfileId"]]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <input type="hidden" name="batchId" value={batchId} />
      <DialogBody>
        <FieldGrid>
          <DField label="Trainer" name="staffProfileId" required error={errors.staffProfileId} full>
            <select
              name="staffProfileId"
              defaultValue={staff.length === 1 ? staff[0].id : ""}
              onBlur={blur("staffProfileId")}
              className={controlClass(Boolean(errors.staffProfileId))}
              {...invalidProps("staffProfileId", errors.staffProfileId)}
            >
              <option value="">{staff.length === 0 ? "Every active staff member is already assigned" : "Choose a trainer"}</option>
              {staff.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.fullName}
                </option>
              ))}
            </select>
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Assign" pendingLabel="Assigning…" pending={pending} disabled={staff.length === 0} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export function TrainersTable({
  batchId,
  assignments,
  canManage,
}: {
  batchId: string;
  assignments: BatchTrainerAssignmentRosterRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(guardedUnassignTrainer, initialState);
  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Trainer unassigned.");
      router.refresh();
    } else if (state.error) showErrorToast(state.error.message);
  }, [state, router]);

  const unassign = (assignmentId: string) => {
    const data = new FormData();
    data.set("assignmentId", assignmentId);
    data.set("batchId", batchId);
    startTransition(() => formAction(data));
  };

  // Current trainers first; removed ones stay listed as history.
  const rows = [...assignments].sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));

  return (
    <>
      <BlockTitle>Trainers</BlockTitle>
      {rows.length === 0 ? (
        <EmptyCard message="No trainers assigned yet." />
      ) : (
        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Trainer</th>
              <th className={rtTh}>Assigned</th>
              <th className={rtTh}>Status</th>
              {canManage && (
                <th className={rtTh}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((assignment) => (
              <tr key={assignment.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Trainer">
                  {assignment.staffFullName}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Assigned">
                  {formatDate(assignment.assignedAt)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={assignment.status} tone={assignment.status === "active" ? "green" : "gray"} />
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    {assignment.status === "active" && (
                      <button type="button" disabled={pending} onClick={() => unassign(assignment.id)} className={ROW_BTN}>
                        Unassign
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

export interface EnrollmentRow extends BatchEnrollmentRosterRow {
  courseName: string;
  deletionEligibility: { eligible: boolean; reasons: string[] };
  /** "6 monthly payments of $30.00", or null when the caller can't see fees. */
  feePlan: string | null;
  /** Overdue amount for the student, formatted, or null. */
  overdue: string | null;
}

export function EnrolledStudentsTable({
  batchId,
  enrollments,
  canManage,
  canDelete,
  showFees,
}: {
  batchId: string;
  enrollments: EnrollmentRow[];
  canManage: boolean;
  canDelete: boolean;
  showFees: boolean;
}) {
  const router = useRouter();
  const [withdrawState, withdrawAction, withdrawing] = useActionState(guardedWithdraw, initialState);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (withdrawState.ok) {
      showSuccessToast("Student withdrawn.");
      router.refresh();
    } else if (withdrawState.error) showErrorToast(withdrawState.error.message);
  }, [withdrawState, router]);

  const active = enrollments.filter((e) => e.status === "active").length;
  const withdrawRow = enrollments.find((e) => e.id === withdrawId) ?? null;
  const deleteRow = enrollments.find((e) => e.id === deleteId) ?? null;

  return (
    <>
      <BlockTitle>
        Enrolled students{" "}
        <span className="font-normal text-muted">
          ({active} active{enrollments.length !== active ? `, ${enrollments.length} in total` : ""})
        </span>
      </BlockTitle>
      {enrollments.length === 0 ? (
        <EmptyCard message="No students enrolled yet." />
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>Course</th>
              {showFees && <th className={rtTh}>Fee plan</th>}
              {showFees && <th className={rtTh}>Overdue</th>}
              <th className={rtTh}>Enrolled</th>
              <th className={rtTh}>Status</th>
              {canManage && (
                <th className={rtTh}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <tr key={enrollment.id} className={trHover}>
                <td className={rtTd} data-label="Student">
                  <Link
                    href={`/academy/students/${enrollment.studentId}`}
                    className="flex min-h-11 flex-col justify-center no-underline hover:no-underline"
                  >
                    <span className="font-semibold !text-ink hover:underline">{enrollment.studentFullName}</span>
                    <span className="text-xs text-muted">{enrollment.studentNumber}</span>
                  </Link>
                </td>
                <td className={rtTd} data-label="Course">
                  {enrollment.courseName}
                </td>
                {showFees && (
                  <td className={rtTd} data-label="Fee plan">
                    {enrollment.feePlan ?? <span className="text-muted">No fee plan</span>}
                  </td>
                )}
                {showFees && (
                  <td className={`${rtTd} tabular-nums`} data-label="Overdue">
                    {enrollment.overdue ? (
                      <span className="font-semibold text-[#B91C1C]">{enrollment.overdue}</span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </td>
                )}
                <td className={`${rtTd} tabular-nums`} data-label="Enrolled">
                  {formatDate(enrollment.enrolledAt)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={enrollment.status} tone={enrollment.status === "active" ? "green" : enrollment.status === "completed" ? "slate" : "gray"} />
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      {enrollment.status === "active" && (
                        <button type="button" disabled={withdrawing} onClick={() => setWithdrawId(enrollment.id)} className={ROW_BTN}>
                          Withdraw
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          disabled={!enrollment.deletionEligibility.eligible}
                          title={
                            enrollment.deletionEligibility.eligible
                              ? undefined
                              : `This enrollment can't be deleted because ${enrollment.deletionEligibility.reasons.join("; ")}. Withdraw it instead.`
                          }
                          onClick={() => setDeleteId(enrollment.id)}
                          className={`${ROW_BTN} !text-[#B91C1C] disabled:cursor-not-allowed`}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {withdrawRow && (
        <ConfirmButton
          label="Withdraw"
          variant="danger"
          icon="logout"
          open={withdrawId !== null}
          onOpenChange={(open) => !open && setWithdrawId(null)}
          title={`Withdraw ${withdrawRow.studentFullName} from ${withdrawRow.courseName}?`}
          description={<>Their enrollment and payment history are kept. They can be enrolled again later.</>}
          successMessage={false}
          onConfirm={async () => {
            const data = new FormData();
            data.set("enrollmentId", withdrawRow.id);
            data.set("batchId", batchId);
            startTransition(() => withdrawAction(data));
            return { ok: true };
          }}
        />
      )}
      {deleteRow && (
        <ConfirmButton
          label="Delete"
          variant="dangerSolid"
          open={deleteId !== null}
          onOpenChange={(open) => !open && setDeleteId(null)}
          title={`Delete ${deleteRow.studentFullName}'s enrollment permanently?`}
          description={<>This cannot be undone. The enrollment record itself is removed.</>}
          successMessage="Enrollment deleted."
          onConfirm={() => deleteBatchEnrollment(deleteRow.id, batchId)}
          onSuccess={() => router.refresh()}
        />
      )}
    </>
  );
}

export function EmptyCard({ message }: { message: string }) {
  return (
    <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
      {message}
    </div>
  );
}
