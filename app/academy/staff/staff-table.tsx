"use client";

import { useState, useTransition } from "react";
import { assignStaffRole, removeStaffMembership, updateStaff } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import type { StaffListRow } from "@/lib/academies/staff";
import { Badge, Button, ErrorMessage, ProtectedDeleteButton, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";

interface Props {
  staff: StaffListRow[];
  /** Full/Manage (Owner, Admin, Manager) — Trainer's "View" renders read-only. */
  canManage: boolean;
}

/**
 * PLAN.md Item 35 — `/academy/staff` list. `assignStaffRole` and
 * `updateStaff`'s status toggle are both fired directly (not via
 * useActionState), same convention as
 * app/platform/staff/platform-staff-manager.tsx's capability toggles,
 * since several rows each need their own independent pending state rather
 * than one shared form.
 */
export function StaffTable({ staff, canManage }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onRoleChange(userId: string, role: AcademyRole) {
    setError(null);
    startTransition(async () => {
      const result = await assignStaffRole(userId, role);
      if (!result.ok) setError(result.error.message);
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
      if (!result.ok) setError(result.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorMessage message={error} />}
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Employee #</th>
            <th className={th}>Phone</th>
            <th className={th}>Login email</th>
            <th className={th}>Role</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {staff.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 7 : 6} className={`${td} text-center text-muted`}>
                No staff members to show.
              </td>
            </tr>
          ) : (
            staff.map((row) => (
              <tr key={row.id} className={trHover}>
                <td className={`${td} font-medium`}>{row.fullName}</td>
                <td className={td}>{row.employeeNumber ?? "—"}</td>
                <td className={td}>{row.phone}</td>
                <td className={td}>{row.loginEmail}</td>
                <td className={td}>
                  {row.role === null ? (
                    <Badge label="No access" tone="gray" />
                  ) : canManage ? (
                    <select
                      value={row.role}
                      disabled={isPending}
                      onChange={(event) => onRoleChange(row.userId, event.target.value as AcademyRole)}
                      className={`${inputClass} py-1.5`}
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
                  <td className={td}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={row.status === "active" ? "danger" : "secondary"}
                        className="px-2.5 py-1 text-xs"
                        disabled={isPending}
                        onClick={() => onToggleStatus(row)}
                      >
                        {row.status === "active" ? "Archive" : "Restore"}
                      </Button>
                      {row.role !== null && (
                        <ConfirmButton
                          label="Remove access"
                          className="px-2.5 py-1 text-xs"
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
                      <ProtectedDeleteButton entityLabel="Staff" />
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>
    </div>
  );
}
