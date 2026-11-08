import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getAuthContext } from "@/lib/auth/auth-context";
import { MFA_PENDING_COOKIE_NAME, verifyPendingMfaToken } from "@/lib/auth/mfa-pending";

/**
 * Authenticator-app setup has been retired: platform staff now verify each
 * sign-in with a code sent to their email, so there is nothing to set up.
 * Kept as a redirect so old links and bookmarks still land somewhere
 * sensible: mid-login to the email challenge, signed in to account
 * settings, otherwise to sign-in.
 */
export default async function MfaSetupPage() {
  const cookieStore = await cookies();
  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  if (pendingToken && verifyPendingMfaToken(pendingToken)) {
    redirect("/mfa/challenge");
  }

  redirect((await getAuthContext()) ? "/account/security" : "/login");
}
