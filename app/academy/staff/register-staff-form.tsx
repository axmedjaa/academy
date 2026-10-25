"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createStaff, type CreateStaffFormState } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { showSuccessToast } from "@/lib/ui/toast";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  PhoneField,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateStaff = guardAction(createStaff);

/**
 * Register staff member (design A04 form `staff`): Full name, Login email,
 * Phone, Role, Temporary password, on the design's form system. The
 * application's extra Employee number and Hire date fields are kept
 * (optional). Every academy role stays assignable as before — the design's
 * role list is not used to add a new restriction. `createStaff` validates,
 * creates or reuses the user account, scopes to the academy and audits.
 */

const initialState: CreateStaffFormState = { ok: false };

const RULES: DesignFormRule[] = [
  { name: "fullName", label: "Full name", required: true },
  {
    name: "email",
    label: "Login email",
    required: true,
    check: (value) => (/^\S+@\S+\.\S+$/.test(value.trim()) ? null : "Enter a valid email address."),
  },
  { name: "phone", label: "Phone", required: true },
  {
    name: "password",
    label: "Temporary password",
    check: (value) => (value && value.length < 8 ? "Use at least 8 characters for the temporary password." : null),
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/password/i, "password"],
  [/email/i, "email"],
  [/phone/i, "phone"],
  [/full name/i, "fullName"],
  [/employee/i, "employeeNumber"],
];

function StaffFields({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [state, formAction, pending] = useActionState(guardedCreateStaff, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Staff member registered.");
      onCreated();
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_PATTERNS);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Full name" name="fullName" required error={errors.fullName} full>
            <input
              type="text"
              name="fullName"
              autoComplete="name"
              onBlur={blur("fullName")}
              className={controlClass(Boolean(errors.fullName))}
              {...invalidProps("fullName", errors.fullName)}
            />
          </DField>
          <DField label="Login email" name="email" required error={errors.email}>
            <input
              type="email"
              name="email"
              autoComplete="off"
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps("email", errors.email)}
            />
          </DField>
          <DField label="Phone" name="phone" required error={errors.phone}>
            <PhoneField name="phone" error={errors.phone} onBlur={blur("phone")} />
          </DField>
          <DField label="Role" name="role">
            <select name="role" defaultValue="trainer" className={controlClass(false)}>
              {ACADEMY_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ACADEMY_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </DField>
          <DField
            label="Temporary password"
            name="password"
            error={errors.password}
            hint="Only needed when this email has no account yet. At least 8 characters."
          >
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              onBlur={blur("password")}
              className={controlClass(Boolean(errors.password))}
              {...invalidProps("password", errors.password)}
            />
          </DField>
          <DField label="Employee number (optional)" name="employeeNumber" error={errors.employeeNumber}>
            <input type="text" name="employeeNumber" className={controlClass(Boolean(errors.employeeNumber))} />
          </DField>
          <DField label="Hire date (optional)" name="hireDate">
            <input type="date" name="hireDate" className={controlClass(false)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Create" pendingLabel="Creating…" pending={pending} />
    </form>
  );
}

const TITLE = "Register staff member";
const SUBTITLE = "The person signs in with this email and temporary password, and is asked to change it.";

export function RegisterStaffButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 items-center rounded-lg bg-brand px-4 font-semibold text-white transition-colors duration-150 hover:bg-brand-hover"
      >
        Register staff member
      </button>
      <DesignDialog open={open} onOpenChange={setOpen} title={TITLE} description={SUBTITLE}>
        {open && (
          <StaffFields
            onCancel={() => setOpen(false)}
            onCreated={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
    </>
  );
}

/** Standalone version for direct visits to /academy/staff/new. */
export function RegisterStaffCard() {
  const router = useRouter();
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="border-b border-border px-6 pb-4 pt-5">
        <h1 className="text-lg font-bold leading-snug text-ink">{TITLE}</h1>
        <p className="mt-1 text-[13px] text-muted">{SUBTITLE}</p>
      </div>
      <StaffFields onCancel={() => router.push("/academy/staff")} onCreated={() => router.push("/academy/staff")} />
    </div>
  );
}
