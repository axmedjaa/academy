"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { regenerateRecoveryCodes, type RegenerateRecoveryCodesState } from "@/lib/auth/mfa-actions";
import { RecoveryCodesReveal } from "@/app/mfa/recovery-codes-reveal";
import { AuthErrorBanner, fieldInputStyle, fieldLabelStyle, formColumnStyle, PrimaryButton } from "@/lib/ui/auth-components";

const initialState: RegenerateRecoveryCodesState = { ok: false };

/** Pure restyle — `regenerateRecoveryCodes` is unchanged. */
export function RegenerateRecoveryCodesForm() {
  const [state, formAction, pending] = useActionState(regenerateRecoveryCodes, initialState);
  const router = useRouter();

  if (state.ok && state.recoveryCodes) {
    return <RecoveryCodesReveal recoveryCodes={state.recoveryCodes} onContinue={() => router.push("/")} />;
  }

  return (
    <form action={formAction} style={formColumnStyle}>
      <label style={fieldLabelStyle}>
        Password
        <input type="password" name="password" required autoComplete="current-password" style={fieldInputStyle} />
      </label>
      {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Regenerate recovery codes"}
      </PrimaryButton>
    </form>
  );
}
