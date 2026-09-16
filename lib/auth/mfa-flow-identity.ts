import { cookies } from "next/headers";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  MFA_PENDING_COOKIE_NAME,
  verifyPendingMfaToken,
} from "@/lib/auth/mfa-pending";

/**
 * Enrollment (Item 13) and the login challenge (Item 14) share one flow: a
 * user can arrive either mid-forced-login (no session yet — see
 * mfa-pending.ts) or already fully signed in (voluntary enrollment). The
 * pending cookie is checked first since it represents the more
 * restrictive, in-progress-login case. Shared by app/mfa/setup/page.tsx
 * and lib/auth/mfa-actions.ts so both resolve identity the same way.
 */
export async function resolveMfaFlowUserId(): Promise<string | null> {
  const cookieStore = await cookies();

  const pendingToken = cookieStore.get(MFA_PENDING_COOKIE_NAME)?.value;
  if (pendingToken) {
    const pending = verifyPendingMfaToken(pendingToken);
    if (pending) return pending.userId;
  }

  const context = await getAuthContext();
  return context?.userId ?? null;
}
