"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { z } from "zod";
import {
  resendEmailChangeVerification,
  updateOwnAccount,
  type UpdateAccountState,
} from "@/lib/auth/update-account-actions";
import { useFieldErrors } from "@/lib/validation/use-field-errors";
import {
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  fieldInputStyle,
  fieldLabelStyle,
} from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

const initialState: UpdateAccountState = { ok: false };

// Mirrors lib/auth/update-account.ts's own `updateAccountSchema` — not
// imported directly (that file pulls in argon2 for changeOwnPassword,
// which must never reach a client bundle). `currentPassword` isn't
// validated here (its own emptiness already gates the Save button via
// `canSubmit` below) — this covers what that gate doesn't: new-email
// format and new-password length/confirmation match, both currently only
// checked server-side.
const accountFieldSchema = z
  .object({
    newEmail: z.string().trim(),
    newPassword: z.string(),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newEmail === "" || z.string().email().safeParse(data.newEmail).success, {
    message: "Enter a valid email address.",
    path: ["newEmail"],
  })
  .refine((data) => data.newPassword === "" || data.newPassword.length >= 8, {
    message: "New password must be at least 8 characters.",
    path: ["newPassword"],
  })
  .refine((data) => data.newPassword === "" || data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

/**
 * One form, one "current password" gate, either or both of a new email and
 * a new password — replacing the earlier two-separate-forms layout, which
 * made a simple settings change feel like two unrelated tasks and asked for
 * the current password twice. `updateOwnAccount` (lib/auth/update-account.ts)
 * does the actual work; this component is presentation only.
 *
 * Submitting a new email never changes it immediately — it only sends a
 * verification link to that new address (lib/auth/email-change.ts);
 * `currentEmail` stays authoritative and signed-in-as until that link is
 * clicked. `pendingNewEmail` (from the server component's own
 * getPendingEmailChange read) renders the "Verification pending" banner on
 * every page load, not just right after a submit.
 */
export function AccountForms({
  currentEmail,
  pendingNewEmail,
}: {
  currentEmail: string;
  pendingNewEmail: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateOwnAccount, initialState);
  const [isResending, startResendTransition] = useTransition();
  const [resendError, setResendError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const { errors, validate } = useFieldErrors(accountFieldSchema);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!validate({ newEmail, newPassword, confirmPassword })) {
      event.preventDefault();
    }
  }

  // Derived, not stored: the server component's own pendingNewEmail read
  // covers every page load, and this submit's own result covers the
  // instant after a successful request — no effect/setState needed for
  // either since both are plain values already available during render.
  const pendingEmail = state.ok && state.emailVerificationSent ? state.emailVerificationSent : pendingNewEmail;

  const hasChange = newEmail.trim().length > 0 || newPassword.length > 0;
  const canSubmit = hasChange && currentPassword.length > 0 && !pending;

  const successMessage = useMemo(() => {
    if (!state.ok) return null;
    if (state.emailVerificationSent && state.passwordChanged) {
      return `We've sent a verification link to ${state.emailVerificationSent}. Your current email remains unchanged until you verify the new address. Your password was changed — other sessions were signed out.`;
    }
    if (state.emailVerificationSent) {
      return `We've sent a verification link to ${state.emailVerificationSent}. Your current email remains unchanged until you verify the new address.`;
    }
    if (state.passwordChanged) {
      return "Password changed. Other sessions were signed out; you're still signed in here.";
    }
    return null;
  }, [state]);

  useEffect(() => {
    if (successMessage) {
      showSuccessToast(successMessage);
    } else if (state.error) {
      showErrorToast(state.error.message);
    }
  }, [state, successMessage]);

  return (
    <form action={formAction} onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: spacing.lg }}>
      <p style={{ margin: 0, fontSize: "0.85rem", color: color.textMuted }}>
        Signed in as <span style={{ fontWeight: 600, color: color.text }}>{currentEmail}</span>
      </p>

      {pendingEmail && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: spacing.sm,
            padding: spacing.sm,
            border: `1px solid ${color.border}`,
            borderRadius: 8,
            backgroundColor: color.bg,
          }}
        >
          <p style={{ margin: 0, fontSize: "0.82rem", color: color.textMuted }}>
            Verification pending for <span style={{ fontWeight: 600, color: color.text }}>{pendingEmail}</span>. Your
            current email remains unchanged until you verify it.
          </p>
          <SecondaryButton
            type="button"
            disabled={isResending}
            onClick={() => {
              setResendError(null);
              startResendTransition(async () => {
                const result = await resendEmailChangeVerification();
                if (!result.ok) {
                  const message = result.error ?? "Couldn't resend the verification email.";
                  setResendError(message);
                  showErrorToast(message);
                  return;
                }
                showSuccessToast("Verification email resent.");
              });
            }}
          >
            {isResending ? "Sending..." : "Resend verification email"}
          </SecondaryButton>
        </div>
      )}
      {resendError && <ErrorBanner message={resendError} />}

      <label style={fieldLabelStyle}>
        New email
        <input
          type="email"
          name="newEmail"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="Leave blank to keep your current email"
          style={fieldInputStyle}
        />
        {errors.newEmail && <small style={{ color: color.statusRed }}>{errors.newEmail}</small>}
      </label>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: spacing.md,
        }}
      >
        <label style={fieldLabelStyle}>
          New password
          <input
            type="password"
            name="newPassword"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Leave blank to keep it"
            minLength={8}
            style={fieldInputStyle}
          />
          {errors.newPassword && <small style={{ color: color.statusRed }}>{errors.newPassword}</small>}
        </label>
        <label style={fieldLabelStyle}>
          Confirm new password
          <input
            type="password"
            name="confirmPassword"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat it"
            minLength={8}
            style={fieldInputStyle}
          />
          {errors.confirmPassword && <small style={{ color: color.statusRed }}>{errors.confirmPassword}</small>}
        </label>
      </div>
      {newPassword.length > 0 && (
        <p style={{ margin: "-0.5rem 0 0", fontSize: "0.78rem", color: color.textMuted }}>At least 8 characters.</p>
      )}

      <div
        style={{
          borderTop: `1px solid ${color.border}`,
          paddingTop: spacing.md,
          display: "flex",
          flexDirection: "column",
          gap: spacing.sm,
        }}
      >
        <label style={fieldLabelStyle}>
          Current password
          <input
            type="password"
            name="currentPassword"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Required to save any change above"
            style={fieldInputStyle}
          />
        </label>

        {state.error && <ErrorBanner message={state.error.message} />}

        <PrimaryButton type="submit" disabled={!canSubmit} style={{ width: "auto", alignSelf: "flex-start", padding: "0.6rem 1.25rem" }}>
          {pending ? "Saving..." : "Save changes"}
        </PrimaryButton>
      </div>
    </form>
  );
}
