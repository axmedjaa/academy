"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { createStaff, type CreateStaffFormState } from "@/lib/academies/staff-actions";
import type { StaffWorkplaceOptions } from "@/lib/academies/staff";
import { ASSIGNABLE_ACADEMY_ROLES, type AcademyRole } from "@/lib/auth/roles";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import {
  DField,
  DesignDialog,
  useUrlOpenedDialog,
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
import { WorkplaceField } from "./workplace-field";
import { CreatedPasswordDisplay, TemporaryPasswordInput } from "./temporary-password-field";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateStaff = guardAction(createStaff);

/**
 * Create staff member (design A04 form `staff`): Full name, Login email,
 * Phone, Role, Employee number and Hire date (optional), Where they work,
 * and a temporary password. Submitting creates the account at once — no
 * invitation, no email (lib/academies/staff.ts createStaff validates,
 * authorizes, hashes the password with Argon2id, and audits).
 *
 * The Role list offers only the roles this person may give (Owner: any;
 * Admin: any but Owner; Manager: roles below Manager), the same list
 * `createStaff` enforces on the server. "Where they work" offers only the
 * branches the creator works in; the server checks the same rule.
 *
 * The temporary password stays in this component only: it is shown once on
 * the success screen (to copy and hand over) and is gone when the dialog
 * closes. The server never sends it back. The new staff member must replace
 * it the first time they sign in.
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
    name: "branchIds",
    label: "Branches",
    check: (_value, data) =>
      data.get("workplace") === "specific" && data.getAll("branchIds").length === 0
        ? "Choose at least one branch where this person works."
        : null,
  },
  {
    name: "temporaryPassword",
    label: "Temporary password",
    required: true,
    // Mirrors passwordSchema (lib/auth/password.ts); the server decides.
    check: (value) =>
      value.length < 8
        ? "Password must be at least 8 characters."
        : value.length > 128
          ? "Password must be at most 128 characters."
          : null,
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/password/i, "temporaryPassword"],
  [/email/i, "email"],
  [/phone/i, "phone"],
  [/full name/i, "fullName"],
  [/employee/i, "employeeNumber"],
  [/branch/i, "branchIds"],
];

interface CreatedAccount {
  fullName: string;
  email: string;
  roleLabel: string;
  password: string;
}

function StaffFields({
  workplaceOptions,
  onCancel,
  onCreated,
}: {
  workplaceOptions: StaffWorkplaceOptions | null;
  onCancel: () => void;
  onCreated: (account: CreatedAccount) => void;
}) {
  const [state, formAction, pending] = useActionState(guardedCreateStaff, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);
  const [role, setRole] = useState<AcademyRole>("trainer");
  const [password, setPassword] = useState("");
  // What was submitted, for the success screen. Kept client-side only.
  const [submitted, setSubmitted] = useState<{ fullName: string; password: string; roleLabel: string } | null>(null);

  useEffect(() => {
    if (state.ok && state.email && submitted) {
      onCreated({ ...submitted, email: state.email });
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
      onSubmit={onDesignSubmit(validate, (data) => {
        // The submit button is disabled while pending; this also drops a
        // second submit (Enter key, double click) instead of queueing it.
        // The server refuses a duplicate email anyway.
        if (pending) return;
        setSubmitted({
          fullName: String(data.get("fullName") ?? "").trim(),
          password: String(data.get("temporaryPassword") ?? ""),
          roleLabel: ACADEMY_ROLE_LABELS[role],
        });
        startTransition(() => formAction(data));
      })}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Full name" name="fullName" required error={errors.fullName} full>
            <input
              type="text"
              name="fullName"
              autoComplete="off"
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
            <select
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value as AcademyRole)}
              className={controlClass(false)}
            >
              {(workplaceOptions?.creatableRoles ?? ASSIGNABLE_ACADEMY_ROLES).map((option) => (
                <option key={option} value={option}>
                  {ACADEMY_ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Employee number (optional)" name="employeeNumber" error={errors.employeeNumber}>
            <input type="text" name="employeeNumber" className={controlClass(Boolean(errors.employeeNumber))} />
          </DField>
          <DField label="Hire date (optional)" name="hireDate">
            <input type="date" name="hireDate" className={controlClass(false)} />
          </DField>
          {workplaceOptions && workplaceOptions.branches.length > 0 && (
            <WorkplaceField options={workplaceOptions} role={role} error={errors.branchIds} />
          )}
          <DField
            label="Temporary password"
            name="temporaryPassword"
            required
            error={errors.temporaryPassword}
            hint="At least 8 characters. They must change it the first time they sign in."
            full
            group
          >
            <TemporaryPasswordInput value={password} onChange={setPassword} onBlur={blur("temporaryPassword")} error={errors.temporaryPassword} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Create staff account" pendingLabel="Creating…" pending={pending} />
    </form>
  );
}

/** One-time confirmation. The password is shown here and nowhere else. */
function CreatedPanel({ account, onDone }: { account: CreatedAccount; onDone: () => void }) {
  return (
    <>
      <DialogBody>
        <div role="status" className="flex items-start gap-3 rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] p-4">
          <CircleCheck size={22} aria-hidden className="mt-0.5 shrink-0 text-[#15803D]" />
          <div className="min-w-0">
            <p className="font-semibold text-ink">{account.fullName}&apos;s account is active</p>
            <p className="mt-0.5 text-sm text-muted">
              {account.roleLabel}. They can sign in now — no invitation or email confirmation is needed.
            </p>
          </div>
        </div>
        <dl className="mt-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <dt className="text-[13px] font-semibold text-ink">Login email</dt>
            <dd className="truncate rounded-lg border border-border bg-app px-3 py-2.5 text-[15px] text-ink">{account.email}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="text-[13px] font-semibold text-ink">Temporary password</dt>
            <dd>
              <CreatedPasswordDisplay value={account.password} />
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-normal text-muted">
          Give these details to {account.fullName} in person or through a private channel. They will be asked to choose a new password
          the first time they sign in. <strong className="font-semibold text-ink">This password will not be shown again</strong> after
          you close this window.
        </p>
      </DialogBody>
      <div className="flex justify-end border-t border-border bg-[#FAFBFC] px-6 py-4">
        <button
          type="button"
          onClick={onDone}
          className="h-11 min-w-[120px] rounded-lg bg-brand px-5 font-semibold text-white transition-colors duration-150 hover:bg-brand-hover"
        >
          Done
        </button>
      </div>
    </>
  );
}

const TITLE = "Create staff member";
const SUBTITLE = "The account is active as soon as you create it. You set a temporary password that they change at first sign-in.";

/** Header action on Staff: opens the create dialog. Also opened by
 * `/academy/staff?register=1` (the old /academy/staff/new address
 * redirects there). */
export function RegisterStaffButton({
  workplaceOptions,
  openedByUrl = false,
}: {
  workplaceOptions: StaffWorkplaceOptions | null;
  openedByUrl?: boolean;
}) {
  const router = useRouter();
  const [open, setOpenRaw] = useUrlOpenedDialog(openedByUrl);
  const [created, setCreated] = useState<CreatedAccount | null>(null);

  // Closing the dialog, by any route, forgets the password.
  const setOpen = (next: boolean) => {
    if (!next) setCreated(null);
    setOpenRaw(next);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 items-center rounded-lg bg-brand px-4 font-semibold text-white transition-colors duration-150 hover:bg-brand-hover"
      >
        Create staff member
      </button>
      <DesignDialog
        open={open}
        onOpenChange={setOpen}
        title={created ? "Staff account created" : TITLE}
        description={created ? undefined : SUBTITLE}
      >
        {open &&
          (created ? (
            <CreatedPanel account={created} onDone={() => setOpen(false)} />
          ) : (
            <StaffFields
              workplaceOptions={workplaceOptions}
              onCancel={() => setOpen(false)}
              onCreated={(account) => {
                setCreated(account);
                // The list behind the dialog shows the new staff member.
                router.refresh();
              }}
            />
          ))}
      </DesignDialog>
    </>
  );
}
