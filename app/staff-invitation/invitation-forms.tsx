"use client";

import { useActionState } from "react";
import {
  acceptStaffInvitationAction,
  beginInvitationSignIn,
  createAccountAndAcceptInvitationAction,
  type AcceptInvitationState,
} from "@/lib/academies/staff-invitation-actions";
import { ErrorBanner, PrimaryButton, fieldInputStyle, fieldLabelStyle, formColumnStyle } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

const initialState: AcceptInvitationState = { ok: false };

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptStaffInvitationAction, initialState);
  return (
    <form action={formAction} style={formColumnStyle}>
      <input type="hidden" name="token" value={token} />
      {state.error && <ErrorBanner message={state.error} />}
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Accepting…" : "Accept invitation"}
      </PrimaryButton>
    </form>
  );
}

export function CreateAccountForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(createAccountAndAcceptInvitationAction, initialState);
  return (
    <form action={formAction} style={formColumnStyle}>
      <input type="hidden" name="token" value={token} />
      <label style={fieldLabelStyle}>
        Password
        <input type="password" name="password" required minLength={8} autoComplete="new-password" style={fieldInputStyle} />
        <small style={{ color: color.textMuted, fontWeight: 400 }}>At least 8 characters</small>
      </label>
      <label style={fieldLabelStyle}>
        Confirm password
        <input type="password" name="confirmPassword" required autoComplete="new-password" style={fieldInputStyle} />
      </label>
      {state.error && <ErrorBanner message={state.error} />}
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account and join"}
      </PrimaryButton>
    </form>
  );
}

/** Remembers this invitation, then opens sign-in; signing in returns here. */
export function SignInToAcceptForm({ token }: { token: string }) {
  return (
    <form action={beginInvitationSignIn} style={formColumnStyle}>
      <input type="hidden" name="token" value={token} />
      <PrimaryButton type="submit">Sign in to accept</PrimaryButton>
    </form>
  );
}
