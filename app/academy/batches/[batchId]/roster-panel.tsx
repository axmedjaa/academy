"use client";

import { useActionState } from "react";
import {
  assignTrainerToBatch,
  deleteBatchEnrollment,
  enrollStudentInBatch,
  unassignTrainerFromBatch,
  withdrawStudentFromBatch,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type {
  BatchEnrollmentRosterRow,
  BatchTrainerAssignmentRosterRow,
} from "@/lib/academies/batch-assignments";
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: BatchAssignmentFormState = { ok: false };

interface StaffOption {
  id: string;
  fullName: string;
}

interface StudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
}

interface Props {
  batchId: string;
  assignments: BatchTrainerAssignmentRosterRow[];
  enrollments: (BatchEnrollmentRosterRow & { deletionEligibility: { eligible: boolean; reasons: string[] } })[];
  staffOptions: StaffOption[];
  studentOptions: StudentOption[];
  canManage: boolean;
  /** Narrower than `canManage` — Trainer can withdraw within their own
   * assigned branch but must never see a Delete action at all
   * (permission-absent, not disabled). */
  canDeleteEnrollment: boolean;
}

export function RosterPanel({
  batchId,
  assignments,
  enrollments,
  staffOptions,
  studentOptions,
  canManage,
  canDeleteEnrollment,
}: Props) {
  const [assignState, assignFormAction, assigning] = useActionState(assignTrainerToBatch, initialState);
  const [unassignState, unassignFormAction, unassigning] = useActionState(
    unassignTrainerFromBatch,
    initialState,
  );
  const [enrollState, enrollFormAction, enrolling] = useActionState(enrollStudentInBatch, initialState);
  const [withdrawState, withdrawFormAction, withdrawing] = useActionState(
    withdrawStudentFromBatch,
    initialState,
  );

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink">Trainers</h2>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Assigned at</th>
              <th className={th}>Status</th>
              {canManage && <th className={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 4 : 3} className={`${td} text-center text-muted`}>
                  No trainers assigned yet.
                </td>
              </tr>
            ) : (
              assignments.map((assignment) => (
                <tr key={assignment.id} className={trHover}>
                  <td className={`${td} font-medium`}>{assignment.staffFullName}</td>
                  <td className={td}>{new Date(assignment.assignedAt).toLocaleDateString()}</td>
                  <td className={td}>
                    <Badge label={assignment.status} tone={assignment.status === "active" ? "green" : "gray"} />
                  </td>
                  {canManage && (
                    <td className={td}>
                      {assignment.status === "active" && (
                        <form action={unassignFormAction}>
                          <input type="hidden" name="assignmentId" value={assignment.id} />
                          <input type="hidden" name="batchId" value={batchId} />
                          <Button type="submit" variant="danger" className="px-2.5 py-1 text-xs" disabled={unassigning}>
                            Unassign
                          </Button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
        {unassignState.error && (
          <div className="mt-2">
            <ErrorMessage message={unassignState.error.message} />
          </div>
        )}

        {canManage && (
          <Section className="mt-4">
            <form action={assignFormAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="batchId" value={batchId} />
              <Field label="Assign trainer" className="min-w-[220px]">
                <select name="staffProfileId" required className={inputClass}>
                  {staffOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.fullName}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="secondary" disabled={assigning}>
                {assigning ? "Assigning..." : "Assign"}
              </Button>
              {assignState.error && <ErrorMessage message={assignState.error.message} />}
            </form>
          </Section>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink">Enrolled students</h2>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Student</th>
              <th className={th}>Enrolled at</th>
              <th className={th}>Status</th>
              {canManage && <th className={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {enrollments.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 4 : 3} className={`${td} text-center text-muted`}>
                  No students enrolled yet.
                </td>
              </tr>
            ) : (
              enrollments.map((enrollment) => (
                <tr key={enrollment.id} className={trHover}>
                  <td className={`${td} font-medium`}>
                    {enrollment.studentFullName} <span className="font-normal text-muted">({enrollment.studentNumber})</span>
                  </td>
                  <td className={td}>{new Date(enrollment.enrolledAt).toLocaleDateString()}</td>
                  <td className={td}>
                    <Badge label={enrollment.status} tone={enrollment.status === "active" ? "green" : "gray"} />
                  </td>
                  {canManage && (
                    <td className={td}>
                      <div className="flex flex-wrap gap-2">
                        {enrollment.status === "active" && (
                          <form action={withdrawFormAction}>
                            <input type="hidden" name="enrollmentId" value={enrollment.id} />
                            <input type="hidden" name="batchId" value={batchId} />
                            <Button type="submit" variant="danger" className="px-2.5 py-1 text-xs" disabled={withdrawing}>
                              Withdraw
                            </Button>
                          </form>
                        )}
                        {canDeleteEnrollment && (
                          <span
                            title={
                              enrollment.deletionEligibility.eligible
                                ? undefined
                                : `This enrollment cannot be permanently deleted because ${enrollment.deletionEligibility.reasons.join("; ")}. Withdraw it instead.`
                            }
                          >
                            <ConfirmButton
                              label="Delete"
                              variant="dangerSolid"
                              className="px-2.5 py-1 text-xs"
                              disabled={!enrollment.deletionEligibility.eligible}
                              title={`Delete ${enrollment.studentFullName}'s enrollment permanently?`}
                              description={<>This cannot be undone. The enrollment record itself will be removed.</>}
                              onConfirm={() => deleteBatchEnrollment(enrollment.id, batchId)}
                            />
                          </span>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
        {withdrawState.error && (
          <div className="mt-2">
            <ErrorMessage message={withdrawState.error.message} />
          </div>
        )}

        {canManage && (
          <Section className="mt-4">
            <form action={enrollFormAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="batchId" value={batchId} />
              <Field label="Enroll student" className="min-w-[220px]">
                <select name="studentId" required className={inputClass}>
                  {studentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.fullName} ({option.studentNumber})
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="secondary" disabled={enrolling}>
                {enrolling ? "Enrolling..." : "Enroll"}
              </Button>
              {enrollState.error && <ErrorMessage message={enrollState.error.message} />}
            </form>
          </Section>
        )}
      </section>
    </div>
  );
}
