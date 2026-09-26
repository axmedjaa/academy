"use client";

import { useActionState } from "react";
import { z } from "zod";
import { requestPasswordReset, type ForgotPasswordState } from "@/lib/auth/actions";
import { useFieldErrors } from "@/lib/validation/use-field-errors";
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
import { color } from "@/lib/ui/theme";

const initialState: ForgotPasswordState = { ok: false };

// Mirrors lib/auth/actions.ts's own (unexported) `forgotPasswordSchema`.
const forgotPasswordFieldSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

/**
 * DESIGN.md §7: `/forgot-password` — "C. Single email field; neutral
 * confirmation regardless of whether the email exists (§11.8)." Pure
 * restyle — `requestPasswordReset` (lib/auth/actions.ts) is unchanged and
 * still returns the identical neutral message whether or not the account
 * exists; this page only renders it.
 */
export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);
  const { errors, validate } = useFieldErrors(forgotPasswordFieldSchema);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!validate(values)) {
      event.preventDefault();
    }
  }

  return (
    <AuthCard title="Forgot password" subtitle="We'll email you a link to reset it">
      {state.ok && state.message ? (
        <SuccessBanner message={state.message} />
      ) : (
        <form action={formAction} onSubmit={handleSubmit} style={formColumnStyle}>
          <label style={fieldLabelStyle}>
            Email
            <input type="email" name="email" required autoComplete="email" style={fieldInputStyle} />
            {errors.email && <small style={{ color: color.statusRed }}>{errors.email}</small>}
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
