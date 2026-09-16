"use client";

import { useState, useActionState } from "react";
import {
  challengeMfa,
  type ChallengeMfaState,
} from "@/lib/auth/mfa-actions";

const initialState: ChallengeMfaState = { ok: false };

export function MfaChallengeForm() {
  const [state, formAction, pending] = useActionState(
    challengeMfa,
    initialState,
  );
  const [mode, setMode] = useState<"totp" | "recovery">("totp");

  return (
    <form
      action={formAction}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <input type="hidden" name="mode" value={mode} />
      {mode === "totp" ? (
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
      ) : (
        <label>
          Recovery code
          <input
            type="text"
            name="code"
            placeholder="XXXXX-XXXXX"
            required
            autoComplete="off"
            style={{ display: "block", width: "100%" }}
          />
        </label>
      )}

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}

      <button type="submit" disabled={pending}>
        {pending ? "Verifying..." : "Verify"}
      </button>

      <button
        type="button"
        onClick={() => setMode(mode === "totp" ? "recovery" : "totp")}
      >
        {mode === "totp"
          ? "Use a recovery code instead"
          : "Use your authenticator app instead"}
      </button>
    </form>
  );
}
