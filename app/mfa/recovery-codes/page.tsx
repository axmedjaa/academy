import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { AuthCard } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";
import { RegenerateRecoveryCodesForm } from "./regenerate-recovery-codes-form";

// PLAN.md Item 15 ("regenerateRecoveryCodes + display-once UI") lives, per
// DESIGN.md §7, as an MFA sub-section of /account/security — which doesn't
// exist until Item 16. This standalone page is a deliberate stand-in,
// following the existing /mfa/setup, /mfa/challenge naming convention.
// Pure restyle — gating and the regenerate/reveal flow are unchanged.
export default async function RegenerateRecoveryCodesPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  // Nothing to regenerate without an existing enrollment.
  if (!(await hasVerifiedMfaCredential(context.userId))) {
    redirect("/mfa/setup");
  }

  return (
    <AuthCard title="Regenerate recovery codes" maxWidth={440}>
      <p style={{ margin: 0, marginBottom: "1rem", fontSize: "0.85rem", color: color.textMuted, textAlign: "center" }}>
        Confirm your password to generate a new set of recovery codes. Your existing recovery codes will stop
        working immediately.
      </p>
      <RegenerateRecoveryCodesForm />
    </AuthCard>
  );
}
