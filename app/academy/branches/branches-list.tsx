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
  // Which row's Delete confirmation is open — the dropdown menu item opens
  // it externally (ConfirmButton's controlled mode), same pattern as
  // app/academy/students/students-list.tsx. Archive keeps its own existing
  // no-confirmation-step behavior (direct submit), unchanged — only its
  // trigger moves into the menu.
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);

  const editingBranch = branches.find((branch) => branch.id === editingId) ?? null;

  // Auto-close the edit dialog once its own update succeeds, instead of
  // leaving the user stuck looking at a saved form — the functional
  // equivalent of "redirect back to the list" since the list is already
  // what sits behind the dialog. Derived-state pattern (react.dev's
  // "adjust state during render"), not an effect — see students-list.tsx's
  // identical use for editingId/selectedBatchId.
  const [prevUpdateOk, setPrevUpdateOk] = useState(updateState.ok);
  if (updateState.ok !== prevUpdateOk) {
    setPrevUpdateOk(updateState.ok);
    if (updateState.ok) setEditingId(null);
  }

  function handleArchive(branch: BranchRecord) {
    const formData = new FormData();
    formData.append("branchId", branch.id);
    archiveFormAction(formData);
  }

  return (
    <section className="flex flex-col gap-6">
      {branches.length === 0 ? (
        <Section>
          <EmptyState message="No branches to show yet." icon={<Icon name="apartment" />} />
        </Section>
      ) : (
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
            {branches.map((branch) => (
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${branch.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Icon name="more" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingId(branch.id)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={archiving || branch.status === "archived"}
                          onClick={() => handleArchive(branch)}
                        >
                          Archive
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {branch.deletionEligibility.eligible ? (
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(branch.id)}>
                            Delete
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled
                            title={`This branch cannot be permanently deleted because ${branch.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                          >
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {branch.deletionEligibility.eligible && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === branch.id}
                        onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? branch.id : null)}
                        title={`Delete "${branch.name}" permanently?`}
                        description={<>This cannot be undone.</>}
                        confirmInput={{ label: `Type "${branch.name}" to confirm`, requiredValue: branch.name }}
                        onConfirm={() => deleteBranch(branch.id, branch.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </TableWrap>
      )}
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
        <FormDialog
          open={editingBranch !== null}
          onOpenChange={(nextOpen) => !nextOpen && setEditingId(null)}
          title={`Edit branch — ${editingBranch.name}`}
        >
          <form action={updateFormAction} className="flex flex-col gap-3">
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
    </section>
  );
}
