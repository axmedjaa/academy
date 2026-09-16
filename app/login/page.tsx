"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "@/lib/auth/actions";

const initialState: SignInState = { ok: false };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <main
      style={{
        maxWidth: 360,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Sign in</h1>
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
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <p>
        <a href="/forgot-password">Forgot password?</a>
      </p>
    </main>
  );
}
