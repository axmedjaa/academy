"use client";

import { useEffect, useState, useActionState, useTransition } from "react";
import { challengeMfa, sendMfaEmailOtpAction, type ChallengeMfaState } from "@/lib/auth/mfa-actions";
import {
  AuthErrorBanner,
  ErrorBanner,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
  SecondaryButton,
  SuccessBanner,
} from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

const initialState: ChallengeMfaState = { ok: false };

type Mode = "email" | "recovery";

const textStyle = { margin: 0, fontSize: "0.85rem", lineHeight: 1.5, color: color.textMuted, textAlign: "center" as const };

const linkButtonStyle = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  fontWeight: 600,
  color: color.primaryBlue,
  cursor: "pointer",
};

function useCountdown(initialSeconds: number) {
  const [deadline, setDeadline] = useState(() => Date.now() + initialSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  function restart(seconds: number) {
    const current = Date.now();
    setNow(current);
    setDeadline(current + seconds * 1000);
  }

  return { remaining, restart };
}

/**
 * The second sign-in step. The code was emailed when the password was
 * accepted, so the page opens straight on the code input. "Resend code"
 * waits out the server's cooldown (the countdown mirrors it; the server
 * enforces it). A recovery code is the backup.
 */
export function MfaChallengeForm({
  maskedEmail,
  codeSent,
  resendAvailableInSeconds,
}: {
  maskedEmail: string;
  codeSent: boolean;
  resendAvailableInSeconds: number;
}) {
  const [state, formAction, pending] = useActionState(challengeMfa, initialState);
  const [mode, setMode] = useState<Mode>("email");
  const [sent, setSent] = useState(codeSent);
  const [resent, setResent] = useState(false);
  const [sendError, setSendError] = useState<{ code: string; message: string } | null>(null);
  const [isSending, startSending] = useTransition();
  const countdown = useCountdown(resendAvailableInSeconds);

  function resend() {
    setSendError(null);
    setResent(false);
    startSending(async () => {
      const result = await sendMfaEmailOtpAction();
      if (!result.ok) {
        setSendError(result.error ?? { code: "SEND_FAILED", message: "We couldn't send the code. Please try again." });
        if (result.error?.retryAfterSeconds) countdown.restart(result.error.retryAfterSeconds);
        return;
      }
      setSent(true);
      setResent(true);
      countdown.restart(result.resendAvailableInSeconds ?? 60);
    });
  }

  if (mode === "recovery") {
    return (
      <form action={formAction} style={formColumnStyle}>
        <input type="hidden" name="mode" value="recovery" />
        <p style={textStyle}>Enter one of the recovery codes you saved when two-step verification was set up. Each code works once.</p>
        <label style={fieldLabelStyle}>
          Recovery code
          <input
            key="recovery"
            type="text"
            name="code"
            placeholder="XXXXX-XXXXX"
            required
            autoComplete="off"
            autoFocus
            style={fieldInputStyle}
          />
        </label>

        {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}

        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Verifying..." : "Verify and continue"}
        </PrimaryButton>
        <SecondaryButton type="button" style={{ width: "100%" }} onClick={() => setMode("email")}>
          Use the emailed code instead
        </SecondaryButton>
      </form>
    );
  }

  return (
    <form action={formAction} style={formColumnStyle}>
      <input type="hidden" name="mode" value="email" />

      {sent ? (
        <p style={textStyle}>
          We&apos;ve sent a six-digit verification code to your email address{" "}
          <strong style={{ color: color.text }}>{maskedEmail}</strong>.
        </p>
      ) : (
        <ErrorBanner message={`We couldn't send a verification code to ${maskedEmail}. Resend the code, or use a recovery code.`} />
      )}

      <label style={fieldLabelStyle}>
        Six-digit verification code
        <input
          key="email"
          type="text"
          name="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          autoComplete="one-time-code"
          autoFocus
          style={{ ...fieldInputStyle, textAlign: "center", letterSpacing: "0.3em", fontSize: "1.1rem" }}
        />
      </label>

      {resent && !sendError && <SuccessBanner message={`A new code is on its way to ${maskedEmail}.`} />}
      {sendError && <AuthErrorBanner code={sendError.code} message={sendError.message} />}
      {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}

      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Verify and continue"}
      </PrimaryButton>

      <p style={textStyle}>
        Didn&apos;t receive the code?{" "}
        {countdown.remaining > 0 ? (
          <span>Resend code in {countdown.remaining}s</span>
        ) : (
          <button type="button" onClick={resend} disabled={isSending} style={linkButtonStyle}>
            {isSending ? "Sending..." : "Resend code"}
          </button>
        )}
      </p>

      <SecondaryButton type="button" style={{ width: "100%" }} onClick={() => setMode("recovery")}>
        Use a recovery code instead
      </SecondaryButton>
    </form>
  );
}
