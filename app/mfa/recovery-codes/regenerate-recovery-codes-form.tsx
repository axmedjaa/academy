"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  regenerateRecoveryCodes,
  type RegenerateRecoveryCodesState,
} from "@/lib/auth/mfa-actions";
import { RecoveryCodesReveal } from "@/app/mfa/recovery-codes-reveal";

const initialState: RegenerateRecoveryCodesState = { ok: false };

export function RegenerateRecoveryCodesForm() {
  const [state, formAction, pending] = useActionState(
    regenerateRecoveryCodes,
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
    <form
      action={formAction}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <label>
        Password
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          style={{ display: "block", width: "100%" }}
        />
      </label>
      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Regenerate recovery codes"}
      </button>
    </form>
  );
}
