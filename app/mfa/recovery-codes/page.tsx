import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { RegenerateRecoveryCodesForm } from "./regenerate-recovery-codes-form";

// PLAN.md Item 15 ("regenerateRecoveryCodes + display-once UI") lives, per
// DESIGN.md §7, as an MFA sub-section of /account/security — which doesn't
// exist until Item 16. This standalone page is a deliberate stand-in,
// following the existing /mfa/setup, /mfa/challenge naming convention.
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
    <main
      style={{
        maxWidth: 420,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Regenerate recovery codes</h1>
      <p>
        Confirm your password to generate a new set of recovery codes. Your
        existing recovery codes will stop working immediately.
      </p>
      <RegenerateRecoveryCodesForm />
    </main>
  );
}
