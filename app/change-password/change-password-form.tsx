"use client";

import { useActionState, useState } from "react";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
import { changeTemporaryPasswordAction, type ChangePasswordFormState } from "@/lib/auth/change-password-actions";
import { signOut } from "@/lib/auth/actions";
import { useFieldErrors } from "@/lib/validation/use-field-errors";
import { AuthErrorBanner, PrimaryButton, fieldInputStyle, fieldLabelStyle, formColumnStyle } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

const initialState: ChangePasswordFormState = { ok: false };

// Mirrors lib/auth/change-password.ts's `changeTemporaryPasswordSchema`
// (not imported: it pulls in argon2, which must never reach the browser).
// Instant feedback only; the server schema is the authority.
const fieldSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your temporary password"),
    newPassword: z.string().min(8, "Password must be at least 8 characters").max(128, "Password must be at most 128 characters"),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, { message: "Passwords do not match", path: ["confirmPassword"] })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "Choose a password different from your temporary password",
    path: ["newPassword"],
  });

function PasswordField({
  label,
  name,
  autoComplete,
  hint,
  error,
}: {
  label: string;
  name: string;
  autoComplete: string;
  hint?: string;
  error?: string;
}) {
  const [visible, setVisible] = useState(false);
  const errorId = `${name}-error`;
  return (
    <label style={fieldLabelStyle}>
      {label}
      <span style={{ position: "relative", display: "block" }}>
        <input
          type={visible ? "text" : "password"}
          name={name}
          required
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          style={{ ...fieldInputStyle, paddingRight: "2.75rem", ...(error ? { border: `1px solid ${color.statusRed}` } : {}) }}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </span>
      {hint && <small style={{ color: color.textMuted, fontWeight: 400 }}>{hint}</small>}
      {error && (
        <small id={errorId} style={{ color: color.statusRed, display: "block" }}>
          {error}
        </small>
      )}
    </label>
  );
}

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changeTemporaryPasswordAction, initialState);
  const { errors, validate } = useFieldErrors(fieldSchema);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!validate(values)) event.preventDefault();
  }

  // A server message that belongs to a field is shown under that field.
  const serverField = state.error?.field;
  const fieldError = (name: "currentPassword" | "newPassword" | "confirmPassword") =>
    errors[name] ?? (serverField === name ? state.error?.message : undefined);

  return (
    <div style={formColumnStyle}>
      <form action={formAction} onSubmit={handleSubmit} style={formColumnStyle} noValidate>
        <PasswordField label="Temporary password" name="currentPassword" autoComplete="current-password" error={fieldError("currentPassword")} />
        <PasswordField
          label="New password"
          name="newPassword"
          autoComplete="new-password"
          hint="At least 8 characters, different from your temporary password"
          error={fieldError("newPassword")}
        />
        <PasswordField label="Confirm new password" name="confirmPassword" autoComplete="new-password" error={fieldError("confirmPassword")} />
        {state.error && !serverField && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save new password"}
        </PrimaryButton>
      </form>
      <form action={signOut} style={{ textAlign: "center" }}>
        <button type="submit" className="text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline">
          Sign out
        </button>
      </form>
    </div>
  );
}
