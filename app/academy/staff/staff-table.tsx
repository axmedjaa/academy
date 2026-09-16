"use client";

import { useState, useTransition } from "react";
import { assignStaffRole, updateStaff } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import type { StaffListRow } from "@/lib/academies/staff";

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
    <div>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Name</th>
            <th style={{ textAlign: "left" }}>Employee #</th>
            <th style={{ textAlign: "left" }}>Phone</th>
            <th style={{ textAlign: "left" }}>Login email</th>
            <th style={{ textAlign: "left" }}>Role</th>
            <th style={{ textAlign: "left" }}>Status</th>
            {canManage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {staff.map((row) => (
            <tr key={row.id}>
              <td>{row.fullName}</td>
              <td>{row.employeeNumber ?? "—"}</td>
              <td>{row.phone}</td>
              <td>{row.loginEmail}</td>
              <td>
                {canManage ? (
                  <select
                    value={row.role ?? ""}
                    disabled={isPending}
                    onChange={(event) =>
                      onRoleChange(row.userId, event.target.value as AcademyRole)
                    }
                  >
                    {ACADEMY_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                ) : (
                  (row.role ?? "—")
                )}
              </td>
              <td>{row.status}</td>
              {canManage && (
                <td>
                  <button type="button" disabled={isPending} onClick={() => onToggleStatus(row)}>
                    {row.status === "active" ? "Archive" : "Restore"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
