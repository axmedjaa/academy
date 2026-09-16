import { redirect } from "next/navigation";
import { resolveMfaFlowUserId } from "@/lib/auth/mfa-flow-identity";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { enrollMfa } from "@/lib/auth/mfa-actions";
import { MfaSetupForm } from "./mfa-setup-form";

export default async function MfaSetupPage() {
  // Reached either via the forced first-login redirect (pending cookie,
  // no session yet) or voluntarily by an already-signed-in user.
  const userId = await resolveMfaFlowUserId();
  if (!userId) {
    redirect("/login");
  }

  // Re-enrollment isn't in scope for Item 13 — a user who already
  // completed enrollment is sent away rather than allowed to overwrite it.
  if (await hasVerifiedMfaCredential(userId)) {
    redirect("/");
  }

  const { secretBase32, qrCodeDataUrl } = await enrollMfa();

  return (
    <main
      style={{
        maxWidth: 420,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Set up two-factor authentication</h1>
      <MfaSetupForm secretBase32={secretBase32} qrCodeDataUrl={qrCodeDataUrl} />
    </main>
  );
}
