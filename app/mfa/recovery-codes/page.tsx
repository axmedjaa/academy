import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { AuthCard } from "@/lib/ui/auth-components";
import { color } from "@/lib/ui/theme";
import { RegenerateRecoveryCodesForm } from "./regenerate-recovery-codes-form";

// PLAN.md Item 15 ("regenerateRecoveryCodes + display-once UI") lives, per
// DESIGN.md §7, as an MFA sub-section of /account/security — which doesn't
// exist until Item 16. This standalone page is a deliberate stand-in,
// following the existing /mfa/challenge naming convention.
// Pure restyle — gating and the regenerate/reveal flow are unchanged.
export default async function RegenerateRecoveryCodesPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  // Two-step verification (and so recovery codes) applies to platform staff only.
  if (!context.platformRole) {
    redirect("/account/security");
  }

  return (
    <AuthCard title="Recovery codes" maxWidth={440}>
      <p style={{ margin: 0, marginBottom: "1rem", fontSize: "0.85rem", color: color.textMuted, textAlign: "center" }}>
        Recovery codes let you sign in if you can&apos;t get the code from your email. Confirm your password to
        generate a new set; any existing recovery codes stop working immediately.
      </p>
      <RegenerateRecoveryCodesForm />
    </AuthCard>
  );
}
