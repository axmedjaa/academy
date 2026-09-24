import { applyEmailChangeToken } from "@/lib/auth/email-change";
import { AuthCard, AuthLink } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";

/**
 * `/account/verify-email?token=...` — the link sent by
 * lib/auth/email-change.ts's issueEmailChangeToken, to the NEW address
 * only. Verifying is the entire action a visit to this page performs (no
 * separate submit step, unlike /reset-password) — same "magic link"
 * pattern as every other single-click email-verification flow;
 * `applyEmailChangeToken` is itself single-use/TTL-bound so a second load
 * of the same link safely reports "invalid or already used" rather than
 * re-applying anything.
 *
 * Not gated behind auth: the verifying browser is very often not the one
 * that requested the change (a different device/session opens the email),
 * so this intentionally works for whoever holds the token, exactly like
 * /reset-password.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : undefined;

  if (!token) {
    return (
      <AuthCard title="Verify email address">
        <p style={{ margin: 0, fontSize: "0.9rem", color: color.text }}>
          This verification link is invalid or has already been used.
        </p>
      </AuthCard>
    );
  }

  const result = await applyEmailChangeToken(token);

  if (!result.ok) {
    const expired = result.error.code === "expired";
    return (
      <AuthCard title={expired ? "Link expired" : "Verification failed"}>
        <p style={{ margin: 0, fontSize: "0.9rem", color: color.text }}>{result.error.message}</p>
        <div style={{ textAlign: "center", marginTop: "1rem" }}>
          <AuthLink href="/account/security">
            {expired ? "Go to account settings to request another" : "Back to account settings"}
          </AuthLink>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Email verified">
      <p style={{ margin: 0, fontSize: "0.9rem", color: color.text }}>
        Email verified successfully. Your account&apos;s email is now{" "}
        <strong style={{ color: color.text }}>{result.email}</strong>.
      </p>
      <div style={{ textAlign: "center", marginTop: "1rem" }}>
        <AuthLink href="/account/security">Continue to account settings</AuthLink>
      </div>
    </AuthCard>
  );
}
