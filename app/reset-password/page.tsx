"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { resetPassword, type ResetPasswordState } from "@/lib/auth/actions";

const initialState: ResetPasswordState = { ok: false };

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [state, formAction, pending] = useActionState(
    resetPassword,
    initialState,
  );

  const invalidToken = !token || state.error?.code === "INVALID_TOKEN";

  return (
    <>
      <h1>Reset password</h1>
      {invalidToken ? (
        <>
          <p role="alert" style={{ color: "crimson" }}>
            {state.error?.message ??
              "This reset link is invalid or has expired. Request a new one."}
          </p>
          <p>
            <a href="/forgot-password">Request a new link</a>
          </p>
        </>
      ) : (
        <form
          action={formAction}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <input type="hidden" name="token" value={token} />
          <label>
            New password
            <input
              type="password"
              name="password"
              required
              autoComplete="new-password"
              style={{ display: "block", width: "100%" }}
            />
            <small>At least 12 characters</small>
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              name="confirmPassword"
              required
              autoComplete="new-password"
              style={{ display: "block", width: "100%" }}
            />
          </label>
          {state.error && (
            <p role="alert" style={{ color: "crimson" }}>
              {state.error.message}
            </p>
          )}
          <button type="submit" disabled={pending}>
            {pending ? "Resetting..." : "Reset password"}
          </button>
        </form>
      )}
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <main
      style={{
        maxWidth: 360,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Suspense fallback={<p>Loading...</p>}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
