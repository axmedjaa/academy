"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { archiveCourse, createCourse, updateCourse, type CourseFormState } from "@/lib/academies/courses-actions";
import type { CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";

const initialState: CourseFormState = { ok: false };

interface InstructorOption {
  id: string;
  fullName: string;
}

interface Props {
  courses: CourseWithInstructor[];
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  canManage: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function CoursesList({ courses, programs, instructors, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createCourse, initialState);
  const [updateState, updateFormAction, updating] = useActionState(updateCourse, initialState);
  const [archiveState, archiveFormAction, archiving] = useActionState(archiveCourse, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingCourse = courses.find((c) => c.id === editingId) ?? null;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Image</th>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Instructor</th>
            <th style={{ padding: "0.5rem" }}>Starts</th>
            <th style={{ padding: "0.5rem" }}>Ends</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {courses.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ padding: "0.5rem", color: "#666" }}>
                No courses to show.
              </td>
            </tr>
          ) : (
            courses.map((course) => (
              <tr key={course.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>
                  {course.imageRef ? (
                    // eslint-disable-next-line @next/next/no-img-element -- this codebase renders every course/academy image via a plain <img> (see app/academy/id-cards/id-card-visual.tsx), no next/image usage anywhere
                    <img src={course.imageRef} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4 }} />
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  <Link href={`/academy/courses/${course.id}`}>{course.name}</Link>
                  {course.code && <span style={{ color: "#666" }}> ({course.code})</span>}
                </td>
                <td style={{ padding: "0.5rem" }}>{course.instructorName ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{formatDate(course.startDate)}</td>
                <td style={{ padding: "0.5rem" }}>{formatDate(course.endDate)}</td>
                <td style={{ padding: "0.5rem" }}>{course.status}</td>
                <td style={{ padding: "0.5rem", display: "flex", gap: "0.5rem" }}>
                  <Link href={`/academy/courses/${course.id}`}>View</Link>
                  {canManage && (
                    <>
                      <button type="button" onClick={() => setEditingId(course.id)}>
                        Edit
                      </button>
                      <form action={archiveFormAction}>
                        <input type="hidden" name="courseId" value={course.id} />
                        <button type="submit" disabled={archiving || course.status === "archived"}>
                          Archive
                        </button>
                      </form>
                    </>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {archiveState.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {archiveState.error.message}
        </p>
      )}

      {canManage && editingCourse && (
        <>
          <h2 style={{ marginTop: "2rem" }}>Edit course — {editingCourse.name}</h2>
          <form
            action={updateFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <input type="hidden" name="courseId" value={editingCourse.id} />
            <label>
              Program
              <select name="programId" required defaultValue={editingCourse.programId} style={{ display: "block", width: "100%" }}>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input type="text" name="name" required defaultValue={editingCourse.name} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Code
              <input type="text" name="code" defaultValue={editingCourse.code ?? ""} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Description
              <textarea name="description" defaultValue={editingCourse.description ?? ""} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Duration (weeks)
              <input
                type="number"
                name="durationWeeks"
                min={0}
                defaultValue={editingCourse.durationWeeks ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Course image URL
              <input type="text" name="imageRef" defaultValue={editingCourse.imageRef ?? ""} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Instructor
              <select name="instructorId" defaultValue={editingCourse.instructorId ?? ""} style={{ display: "block", width: "100%" }}>
                <option value="">No instructor assigned</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start date
              <input type="date" name="startDate" defaultValue={editingCourse.startDate ?? ""} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              End date
              <input type="date" name="endDate" defaultValue={editingCourse.endDate ?? ""} style={{ display: "block", width: "100%" }} />
            </label>
            {updateState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {updateState.error.message}
              </p>
            )}
            {updateState.ok && <p style={{ color: "green" }}>Course updated.</p>}
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

      {canManage && (
        <>
          <h2 style={{ marginTop: "2rem" }}>Add course</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <label>
              Program
              <select name="programId" required style={{ display: "block", width: "100%" }}>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input type="text" name="name" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Code
              <input type="text" name="code" style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Description
              <textarea name="description" style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Duration (weeks)
              <input type="number" name="durationWeeks" min={0} style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Course image URL
              <input type="text" name="imageRef" placeholder="https://…" style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Instructor
              <select name="instructorId" defaultValue="" style={{ display: "block", width: "100%" }}>
                <option value="">No instructor assigned</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start date
              <input type="date" name="startDate" style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              End date
              <input type="date" name="endDate" style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Course created.</p>}
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create course"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
