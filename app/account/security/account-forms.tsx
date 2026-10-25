"use client";

import { startTransition, useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendEmailChangeVerification, updateOwnAccount, type UpdateAccountState } from "@/lib/auth/update-account-actions";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedUpdate = guardAction(updateOwnAccount);
const initialState: UpdateAccountState = { ok: false };

const EMAIL_RULES: DesignFormRule[] = [
  {
    name: "newEmail",
    label: "New email address",
    required: true,
    check: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a valid email address."),
  },
  { name: "currentPassword", label: "Current password", required: true },
];

const PASSWORD_RULES: DesignFormRule[] = [
  { name: "currentPassword", label: "Current password", required: true },
  {
    name: "newPassword",
    label: "New password",
    required: true,
    check: (value) => (value.length >= 8 ? null : "Use at least 8 characters."),
  },
  {
    name: "confirmPassword",
    label: "Confirm new password",
    required: true,
    check: (value, data) => (value === String(data.get("newPassword") ?? "") ? null : "The two passwords do not match."),
  },
];

/**
 * Change email and Change password (design S01) are two dialogs over the
 * one existing `updateOwnAccount` action: each sends only its own fields,
 * so the server rules are unchanged (current password required; a new
 * email only sends a confirmation link; a new password signs out the
 * other sessions).
 */
function AccountDialogForm({
  kind,
  onCancel,
  onDone,
}: {
  kind: "email" | "password";
  onCancel: () => void;
  onDone: (state: UpdateAccountState) => void;
}) {
  const [state, formAction, pending] = useActionState(guardedUpdate, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(kind === "email" ? EMAIL_RULES : PASSWORD_RULES);

  useEffect(() => {
    if (state.ok) onDone(state);
    else if (state.error) {
      showServerError(state.error.message, [
        [/current password|incorrect password|password is incorrect/i, "currentPassword"],
        [/email/i, kind === "email" ? "newEmail" : "currentPassword"],
        [/match/i, "confirmPassword"],
        [/password/i, kind === "password" ? "newPassword" : "currentPassword"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const field = (name: string, label: string, type: string, autoComplete: string, hint?: string) => (
    <DField label={label} name={name} required error={errors[name]} hint={hint} full>
      <input
        type={type}
        name={name}
        autoComplete={autoComplete}
        onBlur={blur(name)}
        className={controlClass(Boolean(errors[name]))}
        {...invalidProps(name, errors[name])}
      />
    </DField>
  );

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          {kind === "email" ? (
            <>
              {field("newEmail", "New email address", "email", "email")}
              {field("currentPassword", "Current password", "password", "current-password")}
            </>
          ) : (
            <>
              {field("currentPassword", "Current password", "password", "current-password")}
              {field("newPassword", "New password", "password", "new-password", "At least 8 characters.")}
              {field("confirmPassword", "Confirm new password", "password", "new-password")}
            </>
          )}
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={kind === "email" ? "Send link" : "Update password"}
        pendingLabel={kind === "email" ? "Sending…" : "Updating…"}
        pending={pending}
      />
    </form>
  );
}

export function ChangeEmailButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Change email
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Change email address" description="We will send a confirmation link to the new address.">
        {open && (
          <AccountDialogForm
            kind="email"
            onCancel={() => setOpen(false)}
            onDone={(state) => {
              setOpen(false);
              showSuccessToast(
                `We sent a confirmation link to ${state.emailVerificationSent}. Your email stays the same until you open it.`,
              );
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
    </>
  );
}

export function ChangePasswordButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Change password
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Change password" description="Other devices are signed out when you change it.">
        {open && (
          <AccountDialogForm
            kind="password"
            onCancel={() => setOpen(false)}
            onDone={() => {
              setOpen(false);
              showSuccessToast("Password updated. Other sessions were signed out.");
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
    </>
  );
}

/** A pending email change, with Resend (the existing action). */
export function PendingEmailNotice({ pendingEmail }: { pendingEmail: string }) {
  const [sending, startSending] = useTransition();
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-2.5 text-[13px] text-[#1E40AF]">
      <span>
        Confirmation pending for <span className="font-semibold">{pendingEmail}</span>. Your email stays the same until you open the
        link.
      </span>
      <button
        type="button"
        disabled={sending}
        onClick={() =>
          startSending(async () => {
            try {
              const result = await resendEmailChangeVerification();
              if (!result.ok) showErrorToast(result.error ?? "Couldn't resend the confirmation email.");
              else showSuccessToast("Confirmation email sent again.");
            } catch {
              showErrorToast(NETWORK_ERROR_MESSAGE);
            }
          })
        }
        className="min-h-10 font-semibold text-[#1E40AF] hover:underline disabled:opacity-50"
      >
        {sending ? "Sending…" : "Resend link"}
      </button>
    </div>
  );
}
