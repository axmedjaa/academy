import type { Metadata } from "next";
import { NO_INDEX } from "@/lib/marketing/seo";
import { redirect } from "next/navigation";
import { getAuthContext, getPasswordChangeSession, getPostLoginRedirectPath } from "@/lib/auth/auth-context";
import { AuthCard } from "@/lib/ui/auth-components";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { robots: NO_INDEX };

/**
 * First sign-in with a temporary password set by an academy administrator
 * (lib/academies/staff.ts createStaff). The only page a session holding a
 * temporary password may open: every other page and action resolves no
 * AuthContext for it (lib/auth/auth-context.ts).
 */
export default async function ChangePasswordPage() {
  const pending = await getPasswordChangeSession();
  if (!pending) {
    // Nothing to change: a normal session goes home, no session signs in.
    const context = await getAuthContext();
    redirect(context ? await getPostLoginRedirectPath(context.userId) : "/login");
  }

  return (
    <AuthCard title="Choose your password" subtitle="Your account was created with a temporary password. Replace it to continue." maxWidth={420}>
      <ChangePasswordForm />
    </AuthCard>
  );
}
