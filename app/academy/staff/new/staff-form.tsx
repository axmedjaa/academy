"use client";

import { useActionState, useEffect } from "react";
import { createStaff, type CreateStaffFormState } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import { Button, ErrorMessage, Field, inputClass } from "@/app/academy/_shell/ui";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

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

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Staff member created.");
    } else if (state.error) {
      showErrorToast(state.error.message);
    }
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Field label="Email">
        <input type="email" name="email" required className={inputClass} />
      </Field>
      <Field label="Temporary password (only needed for a brand-new account)">
        <input type="password" name="password" minLength={8} className={inputClass} />
      </Field>
      <Field label="Full name">
        <input type="text" name="fullName" required className={inputClass} />
      </Field>
      <Field label="Phone">
        <input type="text" name="phone" required className={inputClass} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Employee number">
          <input type="text" name="employeeNumber" className={inputClass} />
        </Field>
        <Field label="Hire date">
          <input type="date" name="hireDate" className={inputClass} />
        </Field>
      </div>
      <Field label="Role">
        <select name="role" defaultValue="trainer" className={inputClass}>
          {ACADEMY_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </Field>

      {state.error && <ErrorMessage message={state.error.message} />}
      {state.ok && <p className="text-sm font-medium text-success">Staff member created.</p>}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Creating..." : "Create staff member"}
      </Button>
    </form>
  );
}
