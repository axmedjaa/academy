import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { MFA_PENDING_COOKIE_NAME, verifyPendingMfaToken } from "@/lib/auth/mfa-pending";
import { AuthCard } from "@/lib/ui/auth-components";
import { MfaChallengeForm } from "./mfa-challenge-form";

/** DESIGN.md §7: `/mfa/challenge` (every login after enrollment) — "C. MFA
 * code component; 'Use a recovery code instead' link; same lockout/error
 * treatment as login." Pure restyle — the pending-cookie gate is unchanged. */
export default async function MfaChallengePage() {
  // Unlike /mfa/setup, this page only ever makes sense mid-login — a
  // fully-authenticated user (real session, no pending cookie) has nothing
  // to challenge and is sent to /login rather than shown this form.
  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  const pending = pendingToken ? verifyPendingMfaToken(pendingToken) : null;

  if (!pending) {
    redirect("/login");
  }

  return (
    <AuthCard title="Two-factor verification">
      <MfaChallengeForm />
    </AuthCard>
  );
}
