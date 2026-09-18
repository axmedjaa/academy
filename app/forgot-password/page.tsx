"use client";

import { useActionState } from "react";
import { requestPasswordReset, type ForgotPasswordState } from "@/lib/auth/actions";
import {
  AuthCard,
  AuthErrorBanner,
  AuthLink,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
  SuccessBanner,
} from "@/lib/ui/auth-components";

const initialState: ForgotPasswordState = { ok: false };

/**
 * DESIGN.md §7: `/forgot-password` — "C. Single email field; neutral
 * confirmation regardless of whether the email exists (§11.8)." Pure
 * restyle — `requestPasswordReset` (lib/auth/actions.ts) is unchanged and
 * still returns the identical neutral message whether or not the account
 * exists; this page only renders it.
 */
export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <AuthCard title="Forgot password" subtitle="We'll email you a link to reset it">
      {state.ok && state.message ? (
        <SuccessBanner message={state.message} />
      ) : (
        <form action={formAction} style={formColumnStyle}>
          <label style={fieldLabelStyle}>
            Email
            <input type="email" name="email" required autoComplete="email" style={fieldInputStyle} />
          </label>
          {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
          <PrimaryButton type="submit" disabled={pending}>
            {pending ? "Sending..." : "Send reset link"}
          </PrimaryButton>
        </form>
      )}
      <div style={{ textAlign: "center", marginTop: "1rem" }}>
        <AuthLink href="/login">Back to sign in</AuthLink>
      </div>
    </AuthCard>
  );
}
