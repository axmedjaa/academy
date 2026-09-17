"use client";

import { useActionState, useState } from "react";
import { updateStudent, type StudentFormState } from "@/lib/academies/students-actions";
import type { StudentRecord } from "@/lib/academies/students";

const initialState: StudentFormState = { ok: false };

interface Props {
  students: StudentRecord[];
  /** Only "full"/"manage" callers (Owner, Admin, Manager, Admissions
   * Officer) get edit controls — "view" (Finance Officer, Trainer) is
   * read-only, per the Master Permission Matrix's Full/Full/Manage/
   * Manage/View/"View assigned" split. */
  canManage: boolean;
  /** False for branch-limited callers (Admissions Officer) — see
   * lib/academies/students.ts's updateStudent branchId judgment call: a
   * branch-limited caller must never submit a `branchId` field at all, so
   * the edit form omits the control entirely rather than disabling it. */
  showBranchField: boolean;
}

export function StudentsList({ students, canManage, showBranchField }: Props) {
  const [updateState, updateFormAction, updating] = useActionState(updateStudent, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingStudent = students.find((student) => student.id === editingId) ?? null;

  return (
    <section>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Student #</th>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Phone</th>
            <th style={{ padding: "0.5rem" }}>Email</th>
            <th style={{ padding: "0.5rem" }}>Guardian</th>
            {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {students.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 7 : 6} style={{ padding: "0.5rem", color: "#666" }}>
                No students to show.
              </td>
            </tr>
          ) : (
            students.map((student) => (
              <tr key={student.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{student.studentNumber}</td>
                <td style={{ padding: "0.5rem" }}>{student.fullName}</td>
                <td style={{ padding: "0.5rem" }}>{student.status}</td>
                <td style={{ padding: "0.5rem" }}>{student.phone ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{student.email ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{student.guardianName ?? "—"}</td>
                {canManage && (
                  <td style={{ padding: "0.5rem" }}>
                    <button type="button" onClick={() => setEditingId(student.id)}>
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {canManage && editingStudent && (
        <>
          <h2 style={{ marginTop: "2rem" }}>Edit student — {editingStudent.fullName}</h2>
          <form
            action={updateFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <input type="hidden" name="studentId" value={editingStudent.id} />
            {showBranchField && (
              <label>
                Branch ID
                <input
                  type="text"
                  name="branchId"
                  defaultValue={editingStudent.branchId}
                  style={{ display: "block", width: "100%" }}
                />
              </label>
            )}
            <label>
              Full name
              <input
                type="text"
                name="fullName"
                defaultValue={editingStudent.fullName}
                required
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Date of birth
              <input
                type="date"
                name="dateOfBirth"
                defaultValue={editingStudent.dateOfBirth ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Gender
              <input
                type="text"
                name="gender"
                defaultValue={editingStudent.gender ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Phone
              <input
                type="text"
                name="phone"
                defaultValue={editingStudent.phone ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                name="email"
                defaultValue={editingStudent.email ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Guardian name
              <input
                type="text"
                name="guardianName"
                defaultValue={editingStudent.guardianName ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Guardian phone
              <input
                type="text"
                name="guardianPhone"
                defaultValue={editingStudent.guardianPhone ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Status
              <select name="status" defaultValue={editingStudent.status} style={{ display: "block", width: "100%" }}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            {updateState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {updateState.error.message}
              </p>
            )}
            {updateState.ok && <p style={{ color: "green" }}>Student updated.</p>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="submit" disabled={updating}>
                {updating ? "Saving..." : "Save changes"}
              </button>
              <button type="button" onClick={() => setEditingId(null)}>
                Cancel
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
