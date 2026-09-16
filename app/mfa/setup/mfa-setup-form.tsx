"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  verifyMfaEnrollment,
  type VerifyMfaEnrollmentState,
} from "@/lib/auth/mfa-actions";
import { RecoveryCodesReveal } from "@/app/mfa/recovery-codes-reveal";

const initialState: VerifyMfaEnrollmentState = { ok: false };

interface Props {
  secretBase32: string;
  qrCodeDataUrl: string;
}

export function MfaSetupForm({ secretBase32, qrCodeDataUrl }: Props) {
  const [state, formAction, pending] = useActionState(
    verifyMfaEnrollment,
    initialState,
  );
  const router = useRouter();

  if (state.ok && state.recoveryCodes) {
    return (
      <RecoveryCodesReveal
        recoveryCodes={state.recoveryCodes}
        onContinue={() => router.push("/")}
      />
    );
  }

  return (
    <div>
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data: URL, not a static asset */}
      <img src={qrCodeDataUrl} alt="QR code for authenticator app enrollment" />
      <p>
        Can&apos;t scan the code? Enter this key manually:{" "}
        <code>{secretBase32}</code>
      </p>
      <form
        action={formAction}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label>
          6-digit code
          <input
            type="text"
            name="code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            style={{ display: "block", width: "100%" }}
          />
        </label>
        {state.error && (
          <p role="alert" style={{ color: "crimson" }}>
            {state.error.message}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? "Verifying..." : "Verify and enable"}
        </button>
      </form>
    </div>
  );
}
