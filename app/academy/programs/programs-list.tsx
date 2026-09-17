"use client";

import { useActionState } from "react";
import { archiveProgram, createProgram, type ProgramFormState } from "@/lib/academies/programs-actions";
import type { ProgramRecord } from "@/lib/academies/programs";

const initialState: ProgramFormState = { ok: false };

interface Props {
  programs: ProgramRecord[];
  canManage: boolean;
}

export function ProgramsList({ programs, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createProgram, initialState);
  const [archiveState, archiveFormAction, archiving] = useActionState(archiveProgram, initialState);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Description</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {programs.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 4 : 3} style={{ padding: "0.5rem", color: "#666" }}>
                No programs to show.
              </td>
            </tr>
          ) : (
            programs.map((program) => (
              <tr key={program.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{program.name}</td>
                <td style={{ padding: "0.5rem" }}>{program.description ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{program.status}</td>
                {canManage && (
                  <td style={{ padding: "0.5rem" }}>
                    <form action={archiveFormAction}>
                      <input type="hidden" name="programId" value={program.id} />
                      <button type="submit" disabled={archiving || program.status === "archived"}>
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
          <h2 style={{ marginTop: "2rem" }}>Add program</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <label>
              Name
              <input type="text" name="name" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Description
              <textarea name="description" style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Program created.</p>}
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create program"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
