"use client";

import { useState, useActionState, useTransition } from "react";
import { challengeMfa, sendMfaEmailOtpAction, type ChallengeMfaState } from "@/lib/auth/mfa-actions";
import {
  AuthErrorBanner,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
  SecondaryButton,
} from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";

const initialState: ChallengeMfaState = { ok: false };

type Mode = "totp" | "recovery" | "email";

/**
 * `challengeMfa`'s TOTP/recovery-code mode toggle and rate-limited/error
 * handling are unchanged. Adds a third mode, "email" — an ADDITIONAL login
 * method alongside the authenticator app, never a replacement
 * (lib/auth/mfa-email-otp.ts). Unlike "totp"/"recovery", there's nothing to
 * type until a code has actually been requested, so switching into this
 * mode fires `sendMfaEmailOtpAction` (a separate useTransition, not part of
 * the `challengeMfa` form submit) before showing the code input.
 */
export function MfaChallengeForm() {
  const [state, formAction, pending] = useActionState(challengeMfa, initialState);
  const [mode, setMode] = useState<Mode>("totp");
  const [isSendingCode, startSendCodeTransition] = useTransition();
  const [emailCodeState, setEmailCodeState] = useState<{ sent: boolean; error?: { code: string; message: string } }>({
    sent: false,
  });

  function requestEmailCode() {
    setEmailCodeState({ sent: false });
    startSendCodeTransition(async () => {
      const result = await sendMfaEmailOtpAction();
      if (!result.ok) {
        setEmailCodeState({ sent: false, error: result.error });
        return;
      }
      setMode("email");
      setEmailCodeState({ sent: true });
    });
  }

  return (
    <form action={formAction} style={formColumnStyle}>
      <input type="hidden" name="mode" value={mode} />

      {mode === "recovery" ? (
        <label style={fieldLabelStyle}>
          Recovery code
          <input type="text" name="code" placeholder="XXXXX-XXXXX" required autoComplete="off" style={fieldInputStyle} />
        </label>
      ) : (
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
      )}

      {mode === "email" && emailCodeState.sent && (
        <p style={{ margin: 0, fontSize: "0.8rem", color: color.textMuted }}>
          We sent a 6-digit code to your email. It expires in a few minutes.
        </p>
      )}
      {emailCodeState.error && <AuthErrorBanner code={emailCodeState.error.code} message={emailCodeState.error.message} />}

      {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}

      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Verify"}
      </PrimaryButton>

      <div style={{ display: "flex", flexDirection: "column", gap: spacing.xxs, marginTop: spacing.xxs }}>
        {mode !== "totp" && (
          <SecondaryButton type="button" style={{ width: "100%" }} onClick={() => setMode("totp")}>
            Use your authenticator app instead
          </SecondaryButton>
        )}
        <SecondaryButton type="button" style={{ width: "100%" }} disabled={isSendingCode} onClick={requestEmailCode}>
          {isSendingCode ? "Sending..." : mode === "email" ? "Resend code" : "Send code to my email"}
        </SecondaryButton>
        {mode !== "recovery" && (
          <SecondaryButton type="button" style={{ width: "100%" }} onClick={() => setMode("recovery")}>
            Use a recovery code instead
          </SecondaryButton>
        )}
      </div>
    </form>
  );
}
