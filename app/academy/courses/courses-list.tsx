"use client";

import { useActionState } from "react";
import { archiveCourse, createCourse, type CourseFormState } from "@/lib/academies/courses-actions";
import type { CourseRecord } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";

const initialState: CourseFormState = { ok: false };

interface Props {
  courses: CourseRecord[];
  programs: ProgramRecord[];
  canManage: boolean;
}

export function CoursesList({ courses, programs, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createCourse, initialState);
  const [archiveState, archiveFormAction, archiving] = useActionState(archiveCourse, initialState);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Code</th>
            <th style={{ padding: "0.5rem" }}>Duration (weeks)</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {courses.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 5 : 4} style={{ padding: "0.5rem", color: "#666" }}>
                No courses to show.
              </td>
            </tr>
          ) : (
            courses.map((course) => (
              <tr key={course.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{course.name}</td>
                <td style={{ padding: "0.5rem" }}>{course.code ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{course.durationWeeks ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{course.status}</td>
                {canManage && (
                  <td style={{ padding: "0.5rem" }}>
                    <form action={archiveFormAction}>
                      <input type="hidden" name="courseId" value={course.id} />
                      <button type="submit" disabled={archiving || course.status === "archived"}>
                        Archive
                      </button>
                    </form>
                  </td>
                )}
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
