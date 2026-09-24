import { redirect } from "next/navigation";
import { resolveMfaFlowUserId } from "@/lib/auth/mfa-flow-identity";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { getPostLoginRedirectPath } from "@/lib/auth/auth-context";
import { enrollMfa } from "@/lib/auth/mfa-actions";
import { AuthCard } from "@/lib/ui/auth-components";
import { MfaSetupForm } from "./mfa-setup-form";

/** DESIGN.md §7: `/mfa/setup` (Platform Owner only, forced on first login)
 * — "C. QR code + manual-entry fallback code + 6-digit confirmation input."
 * Pure restyle — gating (`resolveMfaFlowUserId`, `hasVerifiedMfaCredential`)
 * and `enrollMfa()` are unchanged. */
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
    redirect(await getPostLoginRedirectPath(userId));
  }

  const { secretBase32, qrCodeDataUrl } = await enrollMfa();

  return (
    <AuthCard title="Set up two-factor authentication" maxWidth={440}>
      <MfaSetupForm secretBase32={secretBase32} qrCodeDataUrl={qrCodeDataUrl} />
    </AuthCard>
  );
}
