"use client";

import { useActionState } from "react";
import { z } from "zod";
import { signIn, type SignInState } from "@/lib/auth/actions";
import { useFieldErrors } from "@/lib/validation/use-field-errors";
import {
  AuthCard,
  AuthErrorBanner,
  AuthLink,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
} from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

const initialState: SignInState = { ok: false };

// Mirrors lib/auth/actions.ts's own (unexported — "use server" files may
// only export async functions) `signInSchema`. Instant client-side
// feedback only; that server-side schema remains the actual authority.
const loginFieldSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

/**
 * DESIGN.md §7: `/login` — "C (modal-style centered card). Email + password
 * → primary 'Sign in'. Generic invalid-credentials error (§11.8 wording,
 * never reveals whether the email exists). Lockout state after repeated
 * failures (rate-limited server-side)." No Stitch design exists for this
 * screen (confirmed by exhaustive grep) — visual language is derived
 * directly from DESIGN.md §1/§7 and lib/ui/theme.ts's shared tokens.
 *
 * `signIn` itself (lib/auth/actions.ts) is unchanged — this is a pure
 * restyle. `AuthErrorBanner` renders the amber lockout treatment for
 * `RATE_LIMITED` and the plain red treatment for everything else
 * (`UNAUTHENTICATED`/`VALIDATION_ERROR`), matching the exact
 * "Invalid email or password." copy §11.8 specifies — unchanged, since
 * that string lives in lib/auth/sign-in.ts, not here.
 */
export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, initialState);
  const { errors, validate } = useFieldErrors(loginFieldSchema);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!validate(values)) {
      event.preventDefault();
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Sign in to your Afoogy account">
      <form action={formAction} onSubmit={handleSubmit} style={formColumnStyle}>
        <label style={fieldLabelStyle}>
          Email
          <input type="email" name="email" required autoComplete="email" style={fieldInputStyle} />
          {errors.email && <small style={{ color: color.statusRed }}>{errors.email}</small>}
        </label>
        <label style={fieldLabelStyle}>
          Password
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            style={fieldInputStyle}
          />
          {errors.password && <small style={{ color: color.statusRed }}>{errors.password}</small>}
        </label>
        {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Signing in..." : "Sign in"}
        </PrimaryButton>
      </form>
      <div style={{ textAlign: "center", marginTop: "1rem" }}>
        <AuthLink href="/forgot-password">Forgot password?</AuthLink>
      </div>
    </AuthCard>
  );
}
