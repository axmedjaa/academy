"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { archiveBranch, deleteBranch, restoreBranch, type BranchFormState } from "@/lib/academies/branches-actions";
import type { BranchDeletionEligibilitySummary, BranchRecord } from "@/lib/academies/branches";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BranchFormDialog } from "./branch-form";

/**
 * Archive / Restore / Edit / Delete for one branch, shared by the list rows
 * and the branch detail header. Archive stays a direct action (the design's
 * single-click Archive; the server archives unconditionally). Restore asks
 * first because it counts against the plan's branch allowance again, and
 * Delete is offered only when the server says nothing references the branch.
 */

const initialState: BranchFormState = { ok: false };

export const BRANCH_ROW_BUTTON =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";
const HEADER_BUTTON =
  "inline-flex h-11 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-[18px] text-[15px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

export function BranchActions({
  branch,
  layout,
}: {
  branch: BranchRecord & { deletionEligibility: BranchDeletionEligibilitySummary };
  layout: "row" | "header";
}) {
  const router = useRouter();
  const [archiveState, archiveAction, archiving] = useActionState(archiveBranch, initialState);
  const [editOpen, setEditOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (archiveState.ok) {
      showSuccessToast("Branch archived.");
      router.refresh();
    } else if (archiveState.error) showErrorToast(archiveState.error.message);
  }, [archiveState, router]);

  const archive = () => {
    const data = new FormData();
    data.append("branchId", branch.id);
    startTransition(() => archiveAction(data));
  };

  const buttonClass = layout === "header" ? HEADER_BUTTON : BRANCH_ROW_BUTTON;
  const archived = branch.status === "archived";

  return (
    <>
      <span className={`inline-flex items-center gap-2 ${layout === "header" ? "flex-wrap gap-3" : "justify-end"}`}>
        {layout === "header" && (
          <button type="button" onClick={() => setEditOpen(true)} className={buttonClass}>
            Edit branch
          </button>
        )}
        {archived ? (
          <button type="button" onClick={() => setRestoreOpen(true)} className={buttonClass}>
            Restore
          </button>
        ) : (
          <button type="button" disabled={archiving} onClick={archive} className={buttonClass}>
            {archiving ? "Archiving…" : "Archive"}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${branch.name}`}
              className={`inline-flex ${layout === "header" ? "h-11 w-11" : "h-10 w-10"} items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
            >
              <Icon name="more" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {layout === "row" && (
              <>
                <DropdownMenuItem asChild>
                  <Link href={`/academy/branches/${branch.id}`}>Open</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {branch.deletionEligibility.eligible ? (
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                Delete
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled
                title={`This branch cannot be deleted because ${branch.deletionEligibility.reasons.join("; ")}. Archive it instead.`}
              >
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <BranchFormDialog open={editOpen} onOpenChange={setEditOpen} branch={branch} onSaved={() => router.refresh()} />

      {archived && (
        <ConfirmButton
          label="Restore"
          variant="success"
          icon="autorenew"
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          title={`Restore "${branch.name}"?`}
          description={<>This branch becomes active again and counts toward the academy&apos;s branch limit.</>}
          successMessage="Branch restored."
          onConfirm={() => restoreBranch(branch.id)}
          onSuccess={() => router.refresh()}
        />
      )}

      {branch.deletionEligibility.eligible && (
        <ConfirmButton
          label="Delete"
          variant="dangerSolid"
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete "${branch.name}" permanently?`}
          description={<>This cannot be undone.</>}
          confirmInput={{ label: `Type "${branch.name}" to confirm`, requiredValue: branch.name }}
          successMessage="Branch deleted."
          onConfirm={() => deleteBranch(branch.id, branch.name)}
          onSuccess={() => (layout === "header" ? router.push("/academy/branches") : router.refresh())}
        />
      )}
    </>
  );
}
