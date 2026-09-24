"use client";

import { useActionState, useMemo, useState } from "react";
import { updateOwnAccount, type UpdateAccountState } from "@/lib/auth/update-account-actions";
import {
  ErrorBanner,
  PrimaryButton,
  SuccessBanner,
  fieldInputStyle,
  fieldLabelStyle,
} from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";

const initialState: UpdateAccountState = { ok: false };

/**
 * One form, one "current password" gate, either or both of a new email and
 * a new password — replacing the earlier two-separate-forms layout, which
 * made a simple settings change feel like two unrelated tasks and asked for
 * the current password twice. `updateOwnAccount` (lib/auth/update-account.ts)
 * does the actual work; this component is presentation only.
 */
export function AccountForms({ currentEmail }: { currentEmail: string }) {
  const [state, formAction, pending] = useActionState(updateOwnAccount, initialState);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");

  const hasChange = newEmail.trim().length > 0 || newPassword.length > 0;
  const canSubmit = hasChange && currentPassword.length > 0 && !pending;

  const successMessage = useMemo(() => {
    if (!state.ok) return null;
    if (state.email && state.passwordChanged) {
      return `Email updated to ${state.email}, and your password was changed — other sessions were signed out.`;
    }
    if (state.email) {
      return `Email updated to ${state.email}.`;
    }
    if (state.passwordChanged) {
      return "Password changed. Other sessions were signed out; you're still signed in here.";
    }
    return null;
  }, [state]);

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: spacing.lg }}>
      <p style={{ margin: 0, fontSize: "0.85rem", color: color.textMuted }}>
        Signed in as <span style={{ fontWeight: 600, color: color.text }}>{currentEmail}</span>
      </p>

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
            minLength={12}
            style={fieldInputStyle}
          />
        </label>
        <label style={fieldLabelStyle}>
          Confirm new password
          <input
            type="password"
            name="confirmPassword"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat it"
            minLength={12}
            style={fieldInputStyle}
          />
        </label>
      </div>
      {newPassword.length > 0 && (
        <p style={{ margin: "-0.5rem 0 0", fontSize: "0.78rem", color: color.textMuted }}>At least 12 characters.</p>
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
        {successMessage && <SuccessBanner message={successMessage} />}

        <PrimaryButton type="submit" disabled={!canSubmit} style={{ width: "auto", alignSelf: "flex-start", padding: "0.6rem 1.25rem" }}>
          {pending ? "Saving..." : "Save changes"}
        </PrimaryButton>
      </div>
    </form>
  );
}
