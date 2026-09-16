"use client";

import { useActionState } from "react";
import {
  requestPasswordReset,
  type ForgotPasswordState,
} from "@/lib/auth/actions";

const initialState: ForgotPasswordState = { ok: false };

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(
    requestPasswordReset,
    initialState,
  );

  return (
    <main
      style={{
        maxWidth: 360,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Forgot password</h1>
      {state.ok && state.message ? (
        <p role="status">{state.message}</p>
      ) : (
        <form
          action={formAction}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <label>
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              style={{ display: "block", width: "100%" }}
            />
          </label>
          {state.error && (
            <p role="alert" style={{ color: "crimson" }}>
              {state.error.message}
            </p>
          )}
          <button type="submit" disabled={pending}>
            {pending ? "Sending..." : "Send reset link"}
          </button>
        </form>
      )}
    </main>
  );
}
