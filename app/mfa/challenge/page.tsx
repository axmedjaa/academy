import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { MFA_PENDING_COOKIE_NAME, verifyPendingMfaToken } from "@/lib/auth/mfa-pending";
import { getMfaEmailOtpStatus } from "@/lib/auth/mfa-email-otp";
import { maskEmail } from "@/lib/auth/mask-email";
import { AuthCard } from "@/lib/ui/auth-components";
import { MfaChallengeForm } from "./mfa-challenge-form";

/**
 * `/mfa/challenge`: the second sign-in step for platform staff. signIn has
 * already emailed a code; this page shows where it went (masked), whether
 * it is still waiting, and the resend countdown. Only reachable mid-login:
 * without a valid pending-MFA cookie it sends the visitor to /login. It
 * never sends anything itself (a page load must have no side effects).
 */
export default async function MfaChallengePage() {
  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  const pending = pendingToken ? verifyPendingMfaToken(pendingToken) : null;

  if (!pending) {
    redirect("/login");
  }

  const [[user], status] = await Promise.all([
    db.select({ email: users.email }).from(users).where(eq(users.id, pending.userId)).limit(1),
    getMfaEmailOtpStatus(pending.userId),
  ]);
  if (!user) {
    redirect("/login");
  }

  return (
    <AuthCard title="Two-factor verification">
      <MfaChallengeForm
        maskedEmail={maskEmail(user.email)}
        codeSent={status.codeActive}
        resendAvailableInSeconds={status.resendAvailableInSeconds}
      />
    </AuthCard>
  );
}
