"use client";

import { useActionState, useState } from "react";
import {
  archiveBranch,
  createBranch,
  deleteBranch,
  updateBranch,
  type BranchFormState,
} from "@/lib/academies/branches-actions";
import type { BranchDeletionEligibilitySummary, BranchRecord } from "@/lib/academies/branches";
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { EligibilityGatedDeleteButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: BranchFormState = { ok: false };

interface Props {
  branches: (BranchRecord & { deletionEligibility: BranchDeletionEligibilitySummary })[];
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
    <section className="flex flex-col gap-6">
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Code</th>
            <th className={th}>Status</th>
            <th className={th}>Address</th>
            <th className={th}>Phone</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {branches.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 6 : 5} className={`${td} text-center text-muted`}>
                No branches to show.
              </td>
            </tr>
          ) : (
            branches.map((branch) => (
              <tr key={branch.id} className={trHover}>
                <td className={`${td} font-medium`}>{branch.name}</td>
                <td className={td}>{branch.code}</td>
                <td className={td}>
                  <Badge label={branch.status} tone={branch.status === "archived" ? "gray" : "green"} />
                </td>
                <td className={td}>{branch.address ?? "—"}</td>
                <td className={td}>{branch.phone ?? "—"}</td>
                {canManage && (
                  <td className={td}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setEditingId(branch.id)}>
                        Edit
                      </Button>
                      <form action={archiveFormAction}>
                        <input type="hidden" name="branchId" value={branch.id} />
                        <Button
                          type="submit"
                          variant="danger"
                          className="px-2.5 py-1 text-xs"
                          disabled={archiving || branch.status === "archived"}
                        >
                          Archive
                        </Button>
                      </form>
                      <EligibilityGatedDeleteButton
                        entityLabel="Branch"
                        entityName={branch.name}
                        eligible={branch.deletionEligibility.eligible}
                        reasons={branch.deletionEligibility.reasons}
                        onConfirm={() => deleteBranch(branch.id, branch.name)}
                      />
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>
      {archiveState.error && <ErrorMessage message={archiveState.error.message} />}

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add branch</h2>
          <form action={createFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Address">
                <input type="text" name="address" className={inputClass} />
              </Field>
              <Field label="Phone">
                <input type="text" name="phone" className={inputClass} />
              </Field>
            </div>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Branch created.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create branch"}
            </Button>
          </form>
        </Section>
      )}

      {canManage && editingBranch && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Edit branch — {editingBranch.name}</h2>
          <form action={updateFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <input type="hidden" name="branchId" value={editingBranch.id} />
            <Field label="Name">
              <input type="text" name="name" defaultValue={editingBranch.name} required className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" defaultValue={editingBranch.code} required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Address">
                <input type="text" name="address" defaultValue={editingBranch.address ?? ""} className={inputClass} />
              </Field>
              <Field label="Phone">
                <input type="text" name="phone" defaultValue={editingBranch.phone ?? ""} className={inputClass} />
              </Field>
            </div>
            {updateState.error && <ErrorMessage message={updateState.error.message} />}
            {updateState.ok && <p className="text-sm font-medium text-success">Branch updated.</p>}
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
    </section>
  );
}
