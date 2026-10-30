"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BranchDeletionEligibilitySummary, BranchRecord } from "@/lib/academies/branches";
import type { BranchComparisonRow } from "@/lib/academies/branch-overview";
import { formatMoney } from "@/lib/ui/money";
import { Badge, Button, EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { PhoneCell } from "@/app/academy/_shell/chat-actions";
import { Icon } from "@/app/academy/_shell/icons";
import { BranchActions } from "./branch-actions";
import { BranchFormDialog } from "./branch-form";

/**
 * Branches (design A05): header with Add branch, the Name / Code / Status /
 * Address / Phone / Actions table, and the delete-rule note. Each name opens
 * the branch's own page. Create and edit use the design form dialog.
 *
 * Multi-branch: the Main Branch (Head Office) is marked and can't be
 * archived or deleted; adding, archiving and deleting branches needs
 * all-branch access, and a new branch opens on its Staff tab so its people
 * and managers are assigned next. Members who can see more than one branch
 * also get a side-by-side comparison.
 */

interface Props {
  branches: (BranchRecord & { deletionEligibility: BranchDeletionEligibilitySummary })[];
  /** Only "full"/"manage" callers get edit controls — "view" (Admissions
   * Officer, Trainer, scoped to their assigned branches) is read-only, per
   * the Master Permission Matrix's Full/Full/Manage/View split. The page has
   * already excluded "none" (Finance Officer) entirely before this
   * component ever renders. */
  canManage: boolean;
  /** Add, archive, restore and delete (needs all-branch access too). */
  canManageStructure: boolean;
  allBranchAccess: boolean;
  /** Null when the caller may not compare branches. */
  comparison: BranchComparisonRow[] | null;
}

function money(totals: { currency: string; amountCents: number }[]): string {
  if (totals.length === 0) return formatMoney(0, "USD");
  return totals.map((row) => formatMoney(row.amountCents, row.currency)).join(" + ");
}

export function BranchesList({ branches, canManage, canManageStructure, allBranchAccess, comparison }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const showPayments = Boolean(comparison?.some((row) => row.collectedThisMonth !== null));

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Branches"
        description={
          allBranchAccess
            ? "Every location this academy runs, led by the Main Branch (Head Office)."
            : "The locations of this academy that you work in."
        }
        actions={
          canManageStructure ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Add branch
            </Button>
          ) : undefined
        }
      />

      {branches.length === 0 ? (
        <Section>
          <EmptyState
            message={canManageStructure ? "No branches yet. Add the academy's first location." : "You aren't assigned to a branch yet."}
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
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link
                      href={`/academy/branches/${branch.id}`}
                      className="inline-flex min-h-11 items-center !text-brand no-underline hover:underline"
                    >
                      {branch.name}
                    </Link>
                    {branch.isMain && <Badge label="Main Branch" tone="blue" />}
                  </span>
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
                    <BranchActions branch={branch} layout="row" canManageStructure={canManageStructure} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {comparison && comparison.length > 1 && (
        <>
          <BlockTitle>Compare branches</BlockTitle>
          <DataTable stackBelow={760}>
            <thead>
              <tr>
                <th className={rtTh}>Branch</th>
                <th className={`${rtTh} text-right`}>Active students</th>
                <th className={`${rtTh} text-right`}>Active batches</th>
                <th className={`${rtTh} text-right`}>Staff</th>
                {showPayments && <th className={`${rtTh} text-right`}>Collected this month</th>}
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.branchId} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Branch">
                    <Link href={`/academy/branches/${row.branchId}`} className="!text-brand no-underline hover:underline">
                      {row.name}
                    </Link>
                    {row.isMain && <span className="ml-2 text-xs font-normal text-muted">Main Branch</span>}
                    {row.status === "archived" && <span className="ml-2 text-xs font-normal text-muted">Archived</span>}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Active students">
                    {row.activeStudents.toLocaleString()}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Active batches">
                    {row.activeBatches.toLocaleString()}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Staff">
                    {row.staff.toLocaleString()}
                  </td>
                  {showPayments && (
                    <td className={`${rtTd} text-right tabular-nums`} data-label="Collected this month">
                      {row.collectedThisMonth ? money(row.collectedThisMonth) : <span className="text-muted">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      <NoteBlock>
        Every academy has exactly one Main Branch, which can&apos;t be archived or deleted. Deleting any other branch is
        blocked while a student or batch references it.
      </NoteBlock>

      {canManageStructure && (
        <BranchFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          branch={null}
          onSaved={(branchId) =>
            branchId ? router.push(`/academy/branches/${branchId}?tab=staff&new=1`) : router.refresh()
          }
        />
      )}
    </section>
  );
}
