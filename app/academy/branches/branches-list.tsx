"use client";

import { useActionState, useState } from "react";
import {
  archiveBranch,
  createBranch,
  updateBranch,
  type BranchFormState,
} from "@/lib/academies/branches-actions";
import type { BranchRecord } from "@/lib/academies/branches";

const initialState: BranchFormState = { ok: false };

interface Props {
  branches: BranchRecord[];
  /** Only "full"/"manage" callers get create/edit/archive controls —
   * "view" (Admissions Officer, Trainer, scoped to their assigned
   * branches) is read-only, per the Master Permission Matrix's
   * Full/Full/Manage/View split. The page has already excluded "none"
   * (Finance Officer) entirely before this component ever renders. */
  canManage: boolean;
}

export function BranchesList({ branches, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createBranch, initialState);
  const [updateState, updateFormAction, updating] = useActionState(updateBranch, initialState);
  const [archiveState, archiveFormAction, archiving] = useActionState(archiveBranch, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingBranch = branches.find((branch) => branch.id === editingId) ?? null;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Code</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Address</th>
            <th style={{ padding: "0.5rem" }}>Phone</th>
            {canManage && <th style={{ padding: "0.5rem" }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {branches.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 6 : 5} style={{ padding: "0.5rem", color: "#666" }}>
                No branches to show.
              </td>
            </tr>
          ) : (
            branches.map((branch) => (
              <tr key={branch.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{branch.name}</td>
                <td style={{ padding: "0.5rem" }}>{branch.code}</td>
                <td style={{ padding: "0.5rem" }}>{branch.status}</td>
                <td style={{ padding: "0.5rem" }}>{branch.address ?? "—"}</td>
                <td style={{ padding: "0.5rem" }}>{branch.phone ?? "—"}</td>
                {canManage && (
                  <td style={{ padding: "0.5rem", display: "flex", gap: "0.5rem" }}>
                    <button type="button" onClick={() => setEditingId(branch.id)}>
                      Edit
                    </button>
                    <form action={archiveFormAction}>
                      <input type="hidden" name="branchId" value={branch.id} />
                      <button type="submit" disabled={archiving || branch.status === "archived"}>
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
          <h2 style={{ marginTop: "2rem" }}>Add branch</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <label>
              Name
              <input type="text" name="name" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Code
              <input type="text" name="code" required style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Address
              <input type="text" name="address" style={{ display: "block", width: "100%" }} />
            </label>
            <label>
              Phone
              <input type="text" name="phone" style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Branch created.</p>}
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create branch"}
            </button>
          </form>
        </>
      )}

      {canManage && editingBranch && (
        <>
          <h2 style={{ marginTop: "2rem" }}>Edit branch — {editingBranch.name}</h2>
          <form
            action={updateFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <input type="hidden" name="branchId" value={editingBranch.id} />
            <label>
              Name
              <input
                type="text"
                name="name"
                defaultValue={editingBranch.name}
                required
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Code
              <input
                type="text"
                name="code"
                defaultValue={editingBranch.code}
                required
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Address
              <input
                type="text"
                name="address"
                defaultValue={editingBranch.address ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Phone
              <input
                type="text"
                name="phone"
                defaultValue={editingBranch.phone ?? ""}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            {updateState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {updateState.error.message}
              </p>
            )}
            {updateState.ok && <p style={{ color: "green" }}>Branch updated.</p>}
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
