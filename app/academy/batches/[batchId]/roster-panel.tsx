"use client";

import { useActionState } from "react";
import {
  assignTrainerToBatch,
  enrollStudentInBatch,
  unassignTrainerFromBatch,
  withdrawStudentFromBatch,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type {
  BatchEnrollmentRosterRow,
  BatchTrainerAssignmentRosterRow,
} from "@/lib/academies/batch-assignments";

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
  enrollments: BatchEnrollmentRosterRow[];
  staffOptions: StaffOption[];
  studentOptions: StudentOption[];
  canManage: boolean;
}

export function RosterPanel({
  batchId,
  assignments,
  enrollments,
  staffOptions,
  studentOptions,
  canManage,
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
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem", marginTop: "1.5rem" }}>
      <section>
        <h2>Trainers</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: "0.5rem" }}>Name</th>
              <th style={{ padding: "0.5rem" }}>Assigned at</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
              {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 4 : 3} style={{ padding: "0.5rem", color: "#666" }}>
                  No trainers assigned yet.
                </td>
              </tr>
            ) : (
              assignments.map((assignment) => (
                <tr key={assignment.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.5rem" }}>{assignment.staffFullName}</td>
                  <td style={{ padding: "0.5rem" }}>{new Date(assignment.assignedAt).toLocaleDateString()}</td>
                  <td style={{ padding: "0.5rem" }}>{assignment.status}</td>
                  {canManage && (
                    <td style={{ padding: "0.5rem" }}>
                      {assignment.status === "active" && (
                        <form action={unassignFormAction}>
                          <input type="hidden" name="assignmentId" value={assignment.id} />
                          <input type="hidden" name="batchId" value={batchId} />
                          <button type="submit" disabled={unassigning}>
                            Unassign
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {unassignState.error && (
          <p role="alert" style={{ color: "crimson" }}>
            {unassignState.error.message}
          </p>
        )}

        {canManage && (
          <form
            action={assignFormAction}
            style={{ display: "flex", gap: "0.5rem", alignItems: "end", marginTop: "1rem" }}
          >
            <input type="hidden" name="batchId" value={batchId} />
            <label>
              Assign trainer
              <select name="staffProfileId" required style={{ display: "block" }}>
                {staffOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.fullName}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={assigning}>
              {assigning ? "Assigning..." : "Assign"}
            </button>
            {assignState.error && (
              <span role="alert" style={{ color: "crimson" }}>
                {assignState.error.message}
              </span>
            )}
          </form>
        )}
      </section>

      <section>
        <h2>Enrolled students</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: "0.5rem" }}>Student</th>
              <th style={{ padding: "0.5rem" }}>Enrolled at</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
              {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {enrollments.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 4 : 3} style={{ padding: "0.5rem", color: "#666" }}>
                  No students enrolled yet.
                </td>
              </tr>
            ) : (
              enrollments.map((enrollment) => (
                <tr key={enrollment.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.5rem" }}>
                    {enrollment.studentFullName} ({enrollment.studentNumber})
                  </td>
                  <td style={{ padding: "0.5rem" }}>{new Date(enrollment.enrolledAt).toLocaleDateString()}</td>
                  <td style={{ padding: "0.5rem" }}>{enrollment.status}</td>
                  {canManage && (
                    <td style={{ padding: "0.5rem" }}>
                      {enrollment.status === "active" && (
                        <form action={withdrawFormAction}>
                          <input type="hidden" name="enrollmentId" value={enrollment.id} />
                          <input type="hidden" name="batchId" value={batchId} />
                          <button type="submit" disabled={withdrawing}>
                            Withdraw
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {withdrawState.error && (
          <p role="alert" style={{ color: "crimson" }}>
            {withdrawState.error.message}
          </p>
        )}

        {canManage && (
          <form
            action={enrollFormAction}
            style={{ display: "flex", gap: "0.5rem", alignItems: "end", marginTop: "1rem" }}
          >
            <input type="hidden" name="batchId" value={batchId} />
            <label>
              Enroll student
              <select name="studentId" required style={{ display: "block" }}>
                {studentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.fullName} ({option.studentNumber})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={enrolling}>
              {enrolling ? "Enrolling..." : "Enroll"}
            </button>
            {enrollState.error && (
              <span role="alert" style={{ color: "crimson" }}>
                {enrollState.error.message}
              </span>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
