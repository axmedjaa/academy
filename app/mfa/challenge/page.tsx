import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  MFA_PENDING_COOKIE_NAME,
  verifyPendingMfaToken,
} from "@/lib/auth/mfa-pending";
import { MfaChallengeForm } from "./mfa-challenge-form";

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
    <main
      style={{
        maxWidth: 360,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Two-factor verification</h1>
      <MfaChallengeForm />
    </main>
  );
}
