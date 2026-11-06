import { getAuthContext } from "@/lib/auth/auth-context";
import { describeStaffInvitation } from "@/lib/academies/staff-invitations";
import { AuthCard, AuthLink, ErrorBanner } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";
import { AcceptInvitationForm, CreateAccountForm, SignInToAcceptForm } from "./invitation-forms";

/**
 * Staff invitation acceptance (SEC-H-01). Opened from the emailed link. The
 * token is the proof the visitor controls the invited email; an existing
 * account must also be signed in as that same account before it can accept.
 * Every unusable link (unknown, expired, used, cancelled) looks the same.
 */
export const dynamic = "force-dynamic";

export const metadata = { referrer: "no-referrer" as const };

export default async function StaffInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const viewer = await getAuthContext();
  const view = await describeStaffInvitation(token, viewer);

  if (!view.valid) {
    return (
      <AuthCard title="Invitation unavailable">
        <ErrorBanner message="This invitation link is invalid or has expired. Ask the academy to send a new invitation." />
        <div style={{ textAlign: "center", marginTop: "1rem" }}>
          <AuthLink href="/login">Go to sign in</AuthLink>
        </div>
      </AuthCard>
    );
  }

  const intro = (
    <p style={{ margin: "0 0 1rem", fontSize: "0.9rem", color: color.text, lineHeight: 1.5 }}>
      <strong>{view.academyName}</strong> invited <strong>{view.email}</strong> to join as <strong>{view.roleLabel}</strong>.
    </p>
  );

  if (view.mode === "create_account") {
    return (
      <AuthCard title="Join your academy" subtitle="Choose a password for your new account.">
        {intro}
        <CreateAccountForm token={token} />
      </AuthCard>
    );
  }

  if (view.mode === "sign_in") {
    return (
      <AuthCard title="Sign in to accept">
        {intro}
        <p style={{ margin: "0 0 1rem", fontSize: "0.9rem", color: color.textMuted, lineHeight: 1.5 }}>
          This email already has an account. Sign in with it and you&apos;ll come back here to accept.
        </p>
        <SignInToAcceptForm token={token} />
      </AuthCard>
    );
  }

  if (view.mode === "wrong_account") {
    return (
      <AuthCard title="Different account">
        {intro}
        <ErrorBanner message={`You're signed in with a different account. Sign out, sign in as ${view.email}, then open the invitation link again.`} />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Accept invitation">
      {intro}
      <AcceptInvitationForm token={token} />
    </AuthCard>
  );
}
