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
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/students/students-list.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);

  const editingCourse = courses.find((c) => c.id === editingId) ?? null;

  // Auto-close the edit dialog once its own update succeeds — see
  // branches-list.tsx's identical pattern/comment.
  const [prevUpdateOk, setPrevUpdateOk] = useState(updateState.ok);
  if (updateState.ok !== prevUpdateOk) {
    setPrevUpdateOk(updateState.ok);
    if (updateState.ok) setEditingId(null);
  }

  function toggleCourseStatus(course: CourseWithInstructor) {
    return setCourseStatus(course.id, course.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col gap-6">
      {courses.length === 0 ? (
        <Section>
          <EmptyState message="No courses to show yet." icon={<Icon name="menu_book" />} />
        </Section>
      ) : (
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
            {courses.map((course) => (
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${course.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Icon name="more" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingId(course.id)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setArchiveRowId(course.id)}>
                          {course.status === "active" ? "Archive" : "Restore"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {course.deletionEligibility.eligible ? (
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(course.id)}>
                            Delete
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled
                            title={`This course cannot be permanently deleted because ${course.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                          >
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <ConfirmButton
                      label={course.status === "active" ? "Archive" : "Restore"}
                      variant={course.status === "active" ? "danger" : "secondary"}
                      open={archiveRowId === course.id}
                      onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? course.id : null)}
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
                    {course.deletionEligibility.eligible && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === course.id}
                        onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? course.id : null)}
                        title={`Delete "${course.name}" permanently?`}
                        description={<>This cannot be undone.</>}
                        confirmInput={{ label: `Type "${course.name}" to confirm`, requiredValue: course.name }}
                        onConfirm={() => deleteCourse(course.id, course.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </TableWrap>
      )}

      {canManage && editingCourse && (
        <FormDialog
          open={editingCourse !== null}
          onOpenChange={(nextOpen) => !nextOpen && setEditingId(null)}
          title={`Edit course — ${editingCourse.name}`}
        >
          <form action={updateFormAction} className="flex flex-col gap-3">
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
            <div className="mt-2 flex gap-2">
              <Button type="submit" disabled={updating}>
                {updating ? "Saving..." : "Save changes"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </FormDialog>
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
