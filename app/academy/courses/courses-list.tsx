"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  createCourse,
  deleteCourse,
  setCourseStatus,
  updateCourse,
  type CourseFormState,
} from "@/lib/academies/courses-actions";
import type { CourseDeletionEligibilitySummary, CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { ConfirmButton, EligibilityGatedDeleteButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: CourseFormState = { ok: false };

interface InstructorOption {
  id: string;
  fullName: string;
}

interface Props {
  courses: (CourseWithInstructor & { deletionEligibility: CourseDeletionEligibilitySummary })[];
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  canManage: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusTone(status: string): "green" | "gray" {
  return status === "archived" ? "gray" : "green";
}

export function CoursesList({ courses, programs, instructors, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createCourse, initialState);
  const [updateState, updateFormAction, updating] = useActionState(updateCourse, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingCourse = courses.find((c) => c.id === editingId) ?? null;

  function toggleCourseStatus(course: CourseWithInstructor) {
    return setCourseStatus(course.id, course.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col gap-6">
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Image</th>
            <th className={th}>Name</th>
            <th className={th}>Instructor</th>
            <th className={th}>Starts</th>
            <th className={th}>Ends</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {courses.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 7 : 6} className={`${td} text-center text-muted`}>
                No courses to show yet.
              </td>
            </tr>
          ) : (
            courses.map((course) => (
              <tr key={course.id} className={trHover}>
                <td className={td}>
                  {course.imageRef ? (
                    // eslint-disable-next-line @next/next/no-img-element -- this codebase renders every course/academy image via a plain <img> (see app/academy/id-cards/id-card-visual.tsx), no next/image usage anywhere
                    <img
                      src={course.imageRef}
                      alt={`${course.name} course thumbnail`}
                      className="h-12 w-12 rounded-md object-cover"
                    />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={td}>
                  <Link href={`/academy/courses/${course.id}`} className="font-medium text-brand hover:underline">
                    {course.name}
                  </Link>
                  {course.code && <span className="text-muted"> ({course.code})</span>}
                </td>
                <td className={td}>{course.instructorName ?? "—"}</td>
                <td className={td}>{formatDate(course.startDate)}</td>
                <td className={td}>{formatDate(course.endDate)}</td>
                <td className={td}>
                  <Badge label={course.status} tone={statusTone(course.status)} />
                </td>
                {canManage && (
                  <td className={td}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/academy/courses/${course.id}`} className="text-sm text-brand hover:underline">
                        View
                      </Link>
                      <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setEditingId(course.id)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        label={course.status === "active" ? "Archive" : "Restore"}
                        variant={course.status === "active" ? "danger" : "secondary"}
                        className="px-2.5 py-1 text-xs"
                        title={course.status === "active" ? `Archive "${course.name}"?` : `Restore "${course.name}"?`}
                        description={
                          course.status === "active" ? (
                            <>
                              Archived courses are hidden from new batch creation and free up this
                              academy&apos;s plan course allowance, but every batch and student history is
                              kept and can be restored at any time.
                            </>
                          ) : (
                            <>
                              This course will be marked active again and count against this academy&apos;s
                              plan course allowance.
                            </>
                          )
                        }
                        onConfirm={() => toggleCourseStatus(course)}
                      />
                      <EligibilityGatedDeleteButton
                        entityLabel="Course"
                        entityName={course.name}
                        eligible={course.deletionEligibility.eligible}
                        reasons={course.deletionEligibility.reasons}
                        onConfirm={() => deleteCourse(course.id, course.name)}
                      />
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>

      {canManage && editingCourse && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Edit course — {editingCourse.name}</h2>
          <form action={updateFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <input type="hidden" name="courseId" value={editingCourse.id} />
            <Field label="Program">
              <select name="programId" required defaultValue={editingCourse.programId} className={inputClass}>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input type="text" name="name" required defaultValue={editingCourse.name} className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" defaultValue={editingCourse.code ?? ""} className={inputClass} />
            </Field>
            <Field label="Description">
              <textarea name="description" defaultValue={editingCourse.description ?? ""} rows={3} className={inputClass} />
            </Field>
            <Field label="Duration (weeks)">
              <input
                type="number"
                name="durationWeeks"
                min={0}
                defaultValue={editingCourse.durationWeeks ?? ""}
                className={inputClass}
              />
            </Field>
            <Field label="Course image URL">
              <input type="text" name="imageRef" defaultValue={editingCourse.imageRef ?? ""} className={inputClass} />
            </Field>
            <Field label="Instructor">
              <select name="instructorId" defaultValue={editingCourse.instructorId ?? ""} className={inputClass}>
                <option value="">No instructor assigned</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Start date">
                <input type="date" name="startDate" defaultValue={editingCourse.startDate ?? ""} className={inputClass} />
              </Field>
              <Field label="End date">
                <input type="date" name="endDate" defaultValue={editingCourse.endDate ?? ""} className={inputClass} />
              </Field>
            </div>
            {updateState.error && <ErrorMessage message={updateState.error.message} />}
            {updateState.ok && <p className="text-sm font-medium text-success">Course updated.</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={updating}>
                {updating ? "Saving..." : "Save changes"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Section>
      )}

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add course</h2>
          <form action={createFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <Field label="Program">
              <select name="programId" required className={inputClass}>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" className={inputClass} />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} className={inputClass} />
            </Field>
            <Field label="Duration (weeks)">
              <input type="number" name="durationWeeks" min={0} className={inputClass} />
            </Field>
            <Field label="Course image URL">
              <input type="text" name="imageRef" placeholder="https://…" className={inputClass} />
            </Field>
            <Field label="Instructor">
              <select name="instructorId" defaultValue="" className={inputClass}>
                <option value="">No instructor assigned</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Start date">
                <input type="date" name="startDate" className={inputClass} />
              </Field>
              <Field label="End date">
                <input type="date" name="endDate" className={inputClass} />
              </Field>
            </div>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Course created.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create course"}
            </Button>
          </form>
        </Section>
      )}
    </section>
  );
}
