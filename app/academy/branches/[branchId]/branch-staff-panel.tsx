"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BranchStaffRow } from "@/lib/academies/branch-overview";
import { setStaffBranchAssignment } from "@/lib/academies/branch-overview-actions";
import { setAllBranchAccess } from "@/lib/academies/staff-branch-assignments-actions";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { Badge, EmptyState, Section, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, NoteBlock, ROW_BTN, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { Icon } from "@/app/academy/_shell/icons";

/**
 * Branch page, Staff tab: who works at this branch, and (with the staff
 * permission) adding existing academy staff to it or taking them off it —
 * one person, one account, any number of branches. On the Main Branch the
 * owner can also grant or remove access to all branches. Every change is
 * checked and audited on the server; this only draws what it was given.
 */
export function BranchStaffPanel({
  branchId,
  branchName,
  isMain,
  staff,
  canAssign,
  canGrantAllBranches,
  justCreated,
}: {
  branchId: string;
  branchName: string;
  isMain: boolean;
  staff: BranchStaffRow[];
  canAssign: boolean;
  canGrantAllBranches: boolean;
  justCreated: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const here = staff.filter((row) => row.assignedHere);
  const others = staff.filter((row) => !row.assignedHere && row.role !== null && row.status === "active");

  const toggle = (row: BranchStaffRow, assigned: boolean) => {
    setPendingId(row.staffProfileId);
    startTransition(async () => {
      try {
        const result = await setStaffBranchAssignment(row.staffProfileId, branchId, assigned);
        if (result.ok) {
          showSuccessToast(assigned ? `${row.fullName} now works at ${branchName}.` : `${row.fullName} no longer works at ${branchName}.`);
          router.refresh();
        } else {
          showErrorToast(result.error.message);
        }
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      } finally {
        setPendingId(null);
      }
    });
  };

  const roleOf = (row: BranchStaffRow) => (row.role ? ACADEMY_ROLE_LABELS[row.role] : "No academy access");

  return (
    <>
      {justCreated && (
        <div role="status" className="mb-6 rounded-card border border-info/30 bg-info-bg px-4 py-3 text-sm text-info">
          {branchName} was added. Next, assign the staff who work here and its branch managers. A manager runs this
          branch with the permissions of their role.
        </div>
      )}

      <BlockTitle>Working at this branch</BlockTitle>
      {here.length === 0 ? (
        <Section className="mb-8">
          <EmptyState message="No staff assigned to this branch yet." icon={<Icon name="badge" />} />
        </Section>
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Name</th>
              <th className={rtTh}>Role</th>
              <th className={rtTh}>Branch access</th>
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {here.map((row) => (
              <tr key={row.staffProfileId} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Name">
                  {row.fullName}
                  {row.status === "archived" && <span className="ml-2 text-xs font-normal text-muted">Archived</span>}
                </td>
                <td className={rtTd} data-label="Role">
                  {roleOf(row)}
                </td>
                <td className={rtTd} data-label="Branch access">
                  {row.allBranchAccess ? (
                    <Badge label="All branches" tone="blue" />
                  ) : (
                    <span className="text-[13px] text-muted">
                      {row.otherBranches.length ? `This branch and ${row.otherBranches.join(", ")}` : "This branch only"}
                    </span>
                  )}
                </td>
                <td className={`${rtTd} text-right`} data-actions="">
                  <span className="inline-flex flex-wrap items-center justify-end gap-2">
                    {canGrantAllBranches && row.role !== null && row.role !== "academy_owner" && (
                      <ConfirmButton
                        label={row.allBranchAccess ? "Limit to assigned branches" : "Give access to all branches"}
                        variant={row.allBranchAccess ? "secondary" : "primary"}
                        className={ROW_BTN}
                        title={
                          row.allBranchAccess
                            ? `Limit ${row.fullName} to their assigned branches?`
                            : `Give ${row.fullName} access to all branches?`
                        }
                        description={
                          row.allBranchAccess
                            ? "They keep their role, but will only see and manage the branches they are assigned to."
                            : "With their current role they will see and manage every branch's records, including students, finance and staff. This is recorded in the audit log."
                        }
                        successMessage={row.allBranchAccess ? "Access limited to assigned branches." : "Access to all branches granted."}
                        onConfirm={() => setAllBranchAccess(row.staffProfileId, !row.allBranchAccess)}
                        onSuccess={() => router.refresh()}
                      />
                    )}
                    {canAssign && row.role !== "academy_owner" && (
                      <button
                        type="button"
                        className={ROW_BTN}
                        disabled={pendingId === row.staffProfileId}
                        onClick={() => toggle(row, false)}
                      >
                        {pendingId === row.staffProfileId ? "Removing…" : "Remove from branch"}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canAssign && (
        <>
          <BlockTitle>Add existing staff</BlockTitle>
          {others.length === 0 ? (
            <Section className="mb-8">
              <EmptyState
                message="Everyone you manage already works here. Register new staff on the Staff page."
                icon={<Icon name="badge" />}
              />
            </Section>
          ) : (
            <DataTable stackBelow={760}>
              <thead>
                <tr>
                  <th className={rtTh}>Name</th>
                  <th className={rtTh}>Role</th>
                  <th className={rtTh}>Works at</th>
                  <th className={rtTh}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {others.map((row) => (
                  <tr key={row.staffProfileId} className={trHover}>
                    <td className={`${rtTd} font-semibold`} data-label="Name">
                      {row.fullName}
                    </td>
                    <td className={rtTd} data-label="Role">
                      {roleOf(row)}
                    </td>
                    <td className={rtTd} data-label="Works at">
                      {row.allBranchAccess
                        ? "All branches"
                        : row.otherBranches.length
                          ? row.otherBranches.join(", ")
                          : <span className="text-muted">No branch yet</span>}
                    </td>
                    <td className={`${rtTd} text-right`} data-actions="">
                      <button
                        type="button"
                        className={ROW_BTN}
                        disabled={pendingId === row.staffProfileId}
                        onClick={() => toggle(row, true)}
                      >
                        {pendingId === row.staffProfileId ? "Adding…" : "Add to branch"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}

      <NoteBlock>
        A staff member keeps one account and one role, and can work at several branches. Roles are changed on the{" "}
        <Link href="/academy/staff" className="!text-brand">
          Staff page
        </Link>
        .{" "}
        {isMain
          ? "Only the academy owner can give access to all branches, and only to Main Branch staff."
          : "Access to all branches is given from the Main Branch."}
      </NoteBlock>
    </>
  );
}
