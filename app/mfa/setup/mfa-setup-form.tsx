"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { verifyMfaEnrollment, type VerifyMfaEnrollmentState } from "@/lib/auth/mfa-actions";
import { RecoveryCodesReveal } from "@/app/mfa/recovery-codes-reveal";
import { AuthErrorBanner, fieldInputStyle, fieldLabelStyle, formColumnStyle, PrimaryButton } from "@/lib/ui/auth-components";
import { color, radius, spacing } from "@/lib/ui/theme";

const initialState: VerifyMfaEnrollmentState = { ok: false };

interface Props {
  secretBase32: string;
  qrCodeDataUrl: string;
}

/** Pure restyle — `verifyMfaEnrollment` (lib/auth/mfa-actions.ts) and the
 * recovery-codes reveal flow are unchanged. */
export function MfaSetupForm({ secretBase32, qrCodeDataUrl }: Props) {
  const [state, formAction, pending] = useActionState(verifyMfaEnrollment, initialState);
  const router = useRouter();

  if (state.ok && state.recoveryCodes) {
    return <RecoveryCodesReveal recoveryCodes={state.recoveryCodes} onContinue={() => router.push("/")} />;
  }

  return (
    <div>
      <p style={{ margin: 0, marginBottom: spacing.md, fontSize: "0.85rem", color: color.textMuted, textAlign: "center" }}>
        Scan this QR code with your authenticator app.
      </p>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: spacing.md }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- generated data: URL, not a static asset */}
        <img
          src={qrCodeDataUrl}
          alt="QR code for authenticator app enrollment"
          style={{ border: `1px solid ${color.border}`, borderRadius: radius.control, padding: spacing.xs }}
        />
      </div>
      <p style={{ fontSize: "0.8rem", color: color.textMuted, textAlign: "center" }}>
        Can&apos;t scan the code? Enter this key manually:
        <br />
        <code
          style={{
            display: "inline-block",
            marginTop: spacing.xxs,
            padding: "0.2rem 0.5rem",
            backgroundColor: color.bg,
            borderRadius: radius.control,
            fontSize: "0.85rem",
            wordBreak: "break-all",
          }}
        >
          {secretBase32}
        </code>
      </p>
      <form action={formAction} style={{ ...formColumnStyle, marginTop: spacing.md }}>
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
        {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Verifying..." : "Verify and enable"}
        </PrimaryButton>
      </form>
    </div>
  );
}
