"use client";

import { useActionState } from "react";
import { createStaff, type CreateStaffFormState } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES } from "@/lib/auth/roles";

const initialState: CreateStaffFormState = { ok: false };

/**
 * PLAN.md Item 35 / `/academy/staff/new`. The password field is only
 * needed when the given email has no existing `users` account yet —
 * lib/academies/staff.ts's `createStaff` reuses an existing account when
 * one already exists for that email, ignoring this field in that case.
 * Left as a plain (non-`required`) input rather than a two-step "does this
 * email already exist?" flow, which PLAN.md/DESIGN.md don't describe for
 * this screen.
 */
export function StaffForm() {
  const [state, formAction, pending] = useActionState(createStaff, initialState);

  return (
    <form
      action={formAction}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 420 }}
    >
      <label>
        Email
        <input
          type="email"
          name="email"
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Temporary password (only needed for a brand-new account)
        <input
          type="password"
          name="password"
          minLength={12}
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Full name
        <input
          type="text"
          name="fullName"
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Phone
        <input
          type="text"
          name="phone"
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Employee number
        <input
          type="text"
          name="employeeNumber"
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Hire date
        <input type="date" name="hireDate" style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Role
        <select name="role" defaultValue="trainer" style={{ display: "block", width: "100%" }}>
          {ACADEMY_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}
      {state.ok && <p style={{ color: "green" }}>Staff member created.</p>}

      <button type="submit" disabled={pending}>
        {pending ? "Creating..." : "Create staff member"}
      </button>
    </form>
  );
}
