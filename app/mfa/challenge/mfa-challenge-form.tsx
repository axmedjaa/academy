"use client";

import { useState, useActionState } from "react";
import { challengeMfa, type ChallengeMfaState } from "@/lib/auth/mfa-actions";
import {
  AuthErrorBanner,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
  SecondaryButton,
} from "@/lib/ui/auth-components";
import { spacing } from "@/lib/ui/theme";

const initialState: ChallengeMfaState = { ok: false };

/** Pure restyle — `challengeMfa`'s TOTP/recovery-code mode toggle and
 * rate-limited/error handling are unchanged. */
export function MfaChallengeForm() {
  const [state, formAction, pending] = useActionState(challengeMfa, initialState);
  const [mode, setMode] = useState<"totp" | "recovery">("totp");

  return (
    <form action={formAction} style={formColumnStyle}>
      <input type="hidden" name="mode" value={mode} />
      {mode === "totp" ? (
        <label style={fieldLabelStyle}>
          6-digit code
          <input
            type="text"
            name="code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            style={{ ...fieldInputStyle, textAlign: "center", letterSpacing: "0.3em", fontSize: "1.1rem" }}
          />
        </label>
      ) : (
        <label style={fieldLabelStyle}>
          Recovery code
          <input type="text" name="code" placeholder="XXXXX-XXXXX" required autoComplete="off" style={fieldInputStyle} />
        </label>
      )}

      {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}

      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Verify"}
      </PrimaryButton>

      <SecondaryButton type="button" style={{ width: "100%", marginTop: spacing.xxs }} onClick={() => setMode(mode === "totp" ? "recovery" : "totp")}>
        {mode === "totp" ? "Use a recovery code instead" : "Use your authenticator app instead"}
      </SecondaryButton>
    </form>
  );
}
