"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "@/lib/auth/actions";
import {
  AuthCard,
  AuthErrorBanner,
  AuthLink,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
} from "@/lib/ui/auth-components";

const initialState: SignInState = { ok: false };

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

  return (
    <AuthCard title="Sign in" subtitle="Sign in to your Afoogy account">
      <form action={formAction} style={formColumnStyle}>
        <label style={fieldLabelStyle}>
          Email
          <input type="email" name="email" required autoComplete="email" style={fieldInputStyle} />
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
