"use client";

import { useActionState } from "react";
import { archiveBatch, createBatch, type BatchFormState } from "@/lib/academies/batches-actions";
import type { BatchRecord } from "@/lib/academies/batches";
import type { BranchRecord } from "@/lib/academies/branches";
import type { CourseRecord } from "@/lib/academies/courses";

const initialState: BatchFormState = { ok: false };

interface Props {
  batches: BatchRecord[];
  branches: BranchRecord[];
  courses: CourseRecord[];
  canManage: boolean;
}

export function BatchesList({ batches, branches, courses, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createBatch, initialState);
  const [archiveState, archiveFormAction, archiving] = useActionState(archiveBatch, initialState);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Code</th>
            <th style={{ padding: "0.5rem" }}>Start date</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {batches.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 5 : 4} style={{ padding: "0.5rem", color: "#666" }}>
                No batches to show.
              </td>
            </tr>
          ) : (
            batches.map((batch) => (
              <tr key={batch.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{batch.name}</td>
                <td style={{ padding: "0.5rem" }}>{batch.code}</td>
                <td style={{ padding: "0.5rem" }}>{batch.startDate}</td>
                <td style={{ padding: "0.5rem" }}>{batch.status}</td>
                {canManage && (
                  <td style={{ padding: "0.5rem" }}>
                    <form action={archiveFormAction}>
                      <input type="hidden" name="batchId" value={batch.id} />
                      <button type="submit" disabled={archiving || batch.status === "archived"}>
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
          <h2 style={{ marginTop: "2rem" }}>Add batch</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <label>
              Branch
              <select name="branchId" required style={{ display: "block", width: "100%" }}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Course
              <select name="courseId" required style={{ display: "block", width: "100%" }}>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
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
              <input type="text" name="code" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Start date
              <input type="date" name="startDate" required style={{ display: "block", width: "100%" }} />
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
            {createState.ok && <p style={{ color: "green" }}>Batch created.</p>}
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create batch"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
