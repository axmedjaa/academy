"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BranchDeletionEligibilitySummary, BranchRecord } from "@/lib/academies/branches";
import { Badge, Button, EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { PhoneCell } from "@/app/academy/_shell/chat-actions";
import { Icon } from "@/app/academy/_shell/icons";
import { BranchActions } from "./branch-actions";
import { BranchFormDialog } from "./branch-form";

/**
 * Branches (design A05): header with Add branch, the Name / Code / Status /
 * Address / Phone / Actions table, and the delete-rule note. Each name opens
 * the branch's own page. Create and edit use the design form dialog.
 */

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
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Branches"
        description={canManage ? "Locations run by this academy." : "Locations run by this academy that you're assigned to."}
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Add branch
            </Button>
          ) : undefined
        }
      />

      {branches.length === 0 ? (
        <Section>
          <EmptyState
            message={canManage ? "No branches yet. Add the academy's first location." : "You aren't assigned to a branch yet."}
            icon={<Icon name="apartment" />}
          />
        </Section>
      ) : (
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Name</th>
              <th className={rtTh}>Code</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>Address</th>
              <th className={rtTh}>Phone</th>
              {canManage && <th className={rtTh}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => (
              <tr key={branch.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Name">
                  <Link
                    href={`/academy/branches/${branch.id}`}
                    className="inline-flex min-h-11 items-center !text-brand no-underline hover:underline"
                  >
                    {branch.name}
                  </Link>
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Code">
                  {branch.code}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={branch.status} tone={branch.status === "archived" ? "gray" : "green"} />
                </td>
                <td className={rtTd} data-label="Address">
                  {branch.address ?? <span className="text-muted">Not given</span>}
                </td>
                <td className={rtTd} data-label="Phone">
                  <PhoneCell phone={branch.phone} who={branch.name} />
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    <BranchActions branch={branch} layout="row" />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>Deleting a branch is blocked while any student or batch references it.</NoteBlock>

      {canManage && (
        <BranchFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          branch={null}
          onSaved={() => router.refresh()}
        />
      )}
    </section>
  );
}
