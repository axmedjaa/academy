"use client";

import { useActionState, useState } from "react";
import { updateStudent, updateStudentStatus, type StudentFormState } from "@/lib/academies/students-actions";
import {
  updateStudentEnrollment,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type { StudentRecord } from "@/lib/academies/students";
import type { StudentActiveCourse } from "@/lib/academies/batch-assignments";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  ProtectedDeleteButton,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: StudentFormState = { ok: false };
const initialEnrollmentState: BatchAssignmentFormState = { ok: false };

interface CourseOption {
  batchId: string;
  label: string;
}

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
  /** Each student's currently active course(s), for the "Course" column —
   * see lib/academies/batch-assignments.ts's getActiveCoursesForStudents. */
  coursesByStudent: Map<string, StudentActiveCourse[]>;
  /** Every non-archived batch, labeled with its course name, for the
   * "change course" select — same shape as the registration form's course
   * picker (app/academy/students/new/student-form.tsx). */
  courseOptions: CourseOption[];
}

export function StudentsList({ students, canManage, showBranchField, coursesByStudent, courseOptions }: Props) {
  const [updateState, updateFormAction, updating] = useActionState(updateStudent, initialState);
  const [enrollmentState, enrollmentFormAction, updatingEnrollment] = useActionState(
    updateStudentEnrollment,
    initialEnrollmentState,
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingStudent = students.find((student) => student.id === editingId) ?? null;
  const editingStudentCourses = editingStudent ? (coursesByStudent.get(editingStudent.id) ?? []) : [];

  /** Resubmits the row's own current field values alongside the flipped
   * `status` — see students-actions.ts's updateStudentStatus doc comment
   * for why (updateStudent does a full overwrite, not a partial merge).
   * Never includes `branchId`, so a branch-limited caller's own scoping
   * stays untouched regardless of who clicks this. */
  function toggleStudentStatus(student: StudentRecord) {
    const nextStatus: "active" | "archived" = student.status === "active" ? "archived" : "active";
    return updateStudentStatus(student.id, {
      fullName: student.fullName,
      dateOfBirth: student.dateOfBirth ?? "",
      gender: student.gender ?? "",
      phone: student.phone ?? "",
      email: student.email ?? "",
      guardianName: student.guardianName ?? "",
      guardianPhone: student.guardianPhone ?? "",
      status: nextStatus,
    });
  }

  return (
    <section className="flex flex-col gap-6">
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Student #</th>
            <th className={th}>Name</th>
            <th className={th}>Status</th>
            <th className={th}>Phone</th>
            <th className={th}>Email</th>
            <th className={th}>Guardian</th>
            <th className={th}>Course</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {students.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 8 : 7} className={`${td} text-center text-muted`}>
                No students to show. Try adjusting your search or filters.
              </td>
            </tr>
          ) : (
            students.map((student) => (
              <tr key={student.id} className={trHover}>
                <td className={`${td} font-medium`}>{student.studentNumber}</td>
                <td className={td}>{student.fullName}</td>
                <td className={td}>
                  <Badge label={student.status} tone={student.status === "active" ? "green" : "gray"} />
                </td>
                <td className={td}>{student.phone ?? "—"}</td>
                <td className={td}>{student.email ?? "—"}</td>
                <td className={td}>{student.guardianName ?? "—"}</td>
                <td className={td}>
                  {(coursesByStudent.get(student.id) ?? []).map((c) => c.courseName).join(", ") || "—"}
                </td>
                {canManage && (
                  <td className={td}>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setEditingId(student.id)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        label={student.status === "active" ? "Archive" : "Restore"}
                        variant={student.status === "active" ? "danger" : "secondary"}
                        className="px-2.5 py-1 text-xs"
                        title={
                          student.status === "active"
                            ? `Archive ${student.fullName}?`
                            : `Restore ${student.fullName}?`
                        }
                        description={
                          student.status === "active" ? (
                            <>
                              Archived students are hidden from active rosters and enrollment, but their
                              record and history (results, payments, certificates) are kept and can be
                              restored at any time.
                            </>
                          ) : (
                            <>This student will be marked active again and reappear in active rosters.</>
                          )
                        }
                        onConfirm={() => toggleStudentStatus(student)}
                      />
                      <ProtectedDeleteButton entityLabel="Student" />
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>

      {canManage && editingStudent && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Edit student — {editingStudent.fullName}</h2>
          <form action={updateFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <input type="hidden" name="studentId" value={editingStudent.id} />
            {showBranchField && (
              <Field label="Branch ID">
                <input type="text" name="branchId" defaultValue={editingStudent.branchId} className={inputClass} />
              </Field>
            )}
            <Field label="Full name">
              <input type="text" name="fullName" defaultValue={editingStudent.fullName} required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Date of birth">
                <input type="date" name="dateOfBirth" defaultValue={editingStudent.dateOfBirth ?? ""} className={inputClass} />
              </Field>
              <Field label="Gender">
                <input type="text" name="gender" defaultValue={editingStudent.gender ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Phone">
                <input type="text" name="phone" defaultValue={editingStudent.phone ?? ""} className={inputClass} />
              </Field>
              <Field label="Email">
                <input type="email" name="email" defaultValue={editingStudent.email ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Guardian name">
                <input type="text" name="guardianName" defaultValue={editingStudent.guardianName ?? ""} className={inputClass} />
              </Field>
              <Field label="Guardian phone">
                <input type="text" name="guardianPhone" defaultValue={editingStudent.guardianPhone ?? ""} className={inputClass} />
              </Field>
            </div>
            <Field label="Status">
              <select name="status" defaultValue={editingStudent.status} className={inputClass}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            {updateState.error && <ErrorMessage message={updateState.error.message} />}
            {updateState.ok && <p className="text-sm font-medium text-success">Student updated.</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={updating}>
                {updating ? "Saving..." : "Save changes"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-ink">Course</h3>
            <p className="mt-1 text-sm text-muted">
              Current: {editingStudentCourses.map((c) => c.courseName).join(", ") || "No course selected"}
            </p>
            <form action={enrollmentFormAction} className="mt-3 flex max-w-lg flex-wrap items-end gap-3">
              <input type="hidden" name="studentId" value={editingStudent.id} />
              <Field label="Change course" className="min-w-[220px] flex-1">
                <select name="batchId" defaultValue={editingStudentCourses[0]?.batchId ?? ""} className={inputClass}>
                  <option value="">No course</option>
                  {courseOptions.map((option) => (
                    <option key={option.batchId} value={option.batchId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="secondary" disabled={updatingEnrollment}>
                {updatingEnrollment ? "Saving..." : "Save course"}
              </Button>
            </form>
            {enrollmentState.error && <div className="mt-2"><ErrorMessage message={enrollmentState.error.message} /></div>}
            {enrollmentState.ok && <p className="mt-2 text-sm font-medium text-success">Course updated.</p>}
          </div>
        </Section>
      )}
    </section>
  );
}
