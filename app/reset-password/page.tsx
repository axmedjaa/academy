"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { resetPassword, type ResetPasswordState } from "@/lib/auth/actions";
import {
  AuthCard,
  AuthErrorBanner,
  AuthLink,
  fieldInputStyle,
  fieldLabelStyle,
  formColumnStyle,
  PrimaryButton,
} from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

const initialState: ResetPasswordState = { ok: false };

/**
 * DESIGN.md §7: `/reset-password` — "C. New + confirm password, inline
 * hint 'At least 12 characters' (Decision #16, no complexity rules, no
 * forced expiry); expired/invalid-token state offers 'Request a new
 * link.'" Pure restyle — `resetPassword` (lib/auth/actions.ts) and its
 * `INVALID_TOKEN` error code are unchanged.
 */
function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [state, formAction, pending] = useActionState(resetPassword, initialState);

  const invalidToken = !token || state.error?.code === "INVALID_TOKEN";

  return (
    <AuthCard title="Reset password">
      {invalidToken ? (
        <>
          <AuthErrorBanner
            code={state.error?.code ?? "INVALID_TOKEN"}
            message={state.error?.message ?? "This reset link is invalid or has expired. Request a new one."}
          />
          <div style={{ textAlign: "center", marginTop: "1rem" }}>
            <AuthLink href="/forgot-password">Request a new link</AuthLink>
          </div>
        </>
      ) : (
        <form action={formAction} style={formColumnStyle}>
          <input type="hidden" name="token" value={token} />
          <label style={fieldLabelStyle}>
            New password
            <input type="password" name="password" required autoComplete="new-password" style={fieldInputStyle} />
            <small style={{ color: color.textMuted, fontWeight: 400 }}>At least 12 characters</small>
          </label>
          <label style={fieldLabelStyle}>
            Confirm new password
            <input
              type="password"
              name="confirmPassword"
              required
              autoComplete="new-password"
              style={fieldInputStyle}
            />
          </label>
          {state.error && <AuthErrorBanner code={state.error.code} message={state.error.message} />}
          <PrimaryButton type="submit" disabled={pending}>
            {pending ? "Resetting..." : "Reset password"}
          </PrimaryButton>
        </form>
      )}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
