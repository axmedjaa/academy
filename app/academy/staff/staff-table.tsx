"use client";

import { useState, useTransition } from "react";
import {
  assignStaffRole,
  deleteStaff,
  removeStaffMembership,
  updateStaff,
} from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import type { StaffDeletionEligibilitySummary, StaffListRow } from "@/lib/academies/staff";
import { Badge, EmptyState, ErrorMessage, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** First + last initial, e.g. "Jane Doe" -> "JD" — a small avatar-style
 * identity cue so a row of names is easier to scan at a glance, matching
 * the same pattern common to any polished people/staff table. Purely
 * cosmetic; the actual identity is still `fullName`/`loginEmail`. */
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

interface Props {
  staff: (StaffListRow & { deletionEligibility: StaffDeletionEligibilitySummary })[];
  /** Full/Manage (Owner, Admin, Manager) — Trainer's "View" renders read-only. */
  canManage: boolean;
  /** Owner/Admin/Manager only, same as `canManage` for staff in practice
   * (Trainer's level here is always "view", never full/manage) — kept as
   * its own prop for symmetry with the other four entities' list
   * components and in case that ever changes. */
  canDelete: boolean;
}

/**
 * PLAN.md Item 35 — `/academy/staff` list. `assignStaffRole` and
 * `updateStaff`'s status toggle are both fired directly (not via
 * useActionState), same convention as
 * app/platform/staff/platform-staff-manager.tsx's capability toggles,
 * since several rows each need their own independent pending state rather
 * than one shared form.
 */
export function StaffTable({ staff, canManage, canDelete }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Which row's "Remove access"/"Delete" confirmation dialog is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode) rather than being its own visible trigger button.
  const [removeAccessRowId, setRemoveAccessRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);

  function onRoleChange(userId: string, role: AcademyRole) {
    setError(null);
    startTransition(async () => {
      const result = await assignStaffRole(userId, role);
      if (!result.ok) {
        setError(result.error.message);
        showErrorToast(result.error.message);
        return;
      }
      showSuccessToast("Role updated.");
    });
  }

  function onToggleStatus(row: StaffListRow) {
    setError(null);
    const nextStatus = row.status === "active" ? "archived" : "active";
    startTransition(async () => {
      const result = await updateStaff(row.id, {
        fullName: row.fullName,
        phone: row.phone,
        email: row.email ?? "",
        employeeNumber: row.employeeNumber ?? "",
        hireDate: row.hireDate ?? "",
        status: nextStatus,
      });
      if (!result.ok) {
        setError(result.error.message);
        showErrorToast(result.error.message);
        return;
      }
      showSuccessToast(nextStatus === "active" ? "Staff member restored." : "Staff member archived.");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorMessage message={error} />}
      {staff.length === 0 ? (
        <Section>
          <EmptyState message="No staff members to show." icon={<Icon name="badge" />} />
        </Section>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Employee #</th>
              <th className={th}>Phone</th>
              <th className={th}>Login email</th>
              <th className={th}>Role</th>
              <th className={th}>Status</th>
              {canManage && <th className={`${th} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {staff.map((row) => (
              <tr key={row.id} className={trHover}>
                <td className={td}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">
                      {getInitials(row.fullName)}
                    </span>
                    <span className="font-medium text-ink">{row.fullName}</span>
                  </div>
                </td>
                <td className={`${td} text-muted`}>{row.employeeNumber ?? "—"}</td>
                <td className={`${td} text-muted`}>{row.phone}</td>
                <td className={`${td} text-muted`}>{row.loginEmail}</td>
                <td className={td}>
                  {row.role === null ? (
                    <Badge label="No access" tone="gray" />
                  ) : canManage ? (
                    <select
                      value={row.role}
                      disabled={isPending}
                      onChange={(event) => onRoleChange(row.userId, event.target.value as AcademyRole)}
                      className={`${inputClass} w-auto py-1.5 text-xs`}
                    >
                      {ACADEMY_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    row.role
                  )}
                </td>
                <td className={td}>
                  <Badge label={row.status} tone={row.status === "active" ? "green" : "gray"} />
                </td>
                {canManage && (
                  <td className={`${td} text-right`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${row.fullName}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Icon name="more" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={isPending} onClick={() => onToggleStatus(row)}>
                          {row.status === "active" ? "Archive" : "Restore"}
                        </DropdownMenuItem>
                        {row.role !== null && (
                          <DropdownMenuItem onClick={() => setRemoveAccessRowId(row.id)}>
                            Remove access
                          </DropdownMenuItem>
                        )}
                        {canDelete &&
                          (row.deletionEligibility.eligible ? (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(row.id)}>
                              Delete
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled
                              title={`This staff member cannot be permanently deleted because ${row.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                            >
                              Delete
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {row.role !== null && (
                      <ConfirmButton
                        label="Remove access"
                        open={removeAccessRowId === row.id}
                        onOpenChange={(nextOpen) => setRemoveAccessRowId(nextOpen ? row.id : null)}
                        title={`Remove ${row.fullName}'s access?`}
                        description={
                          <>
                            They will no longer be able to sign in to this academy. Their employment record and
                            history (results, payments, audit entries) are kept, but this specific action can&apos;t
                            be undone from this screen.
                          </>
                        }
                        onConfirm={() => removeStaffMembership(row.userId)}
                      />
                    )}
                    {canDelete && row.deletionEligibility.eligible && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === row.id}
                        onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? row.id : null)}
                        title={`Delete "${row.fullName}" permanently?`}
                        description={<>This cannot be undone.</>}
                        confirmInput={{ label: `Type "${row.fullName}" to confirm`, requiredValue: row.fullName }}
                        onConfirm={() => deleteStaff(row.id, row.fullName)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
