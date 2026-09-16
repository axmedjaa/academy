import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";

export interface ActionError {
  code: "UNAUTHENTICATED";
  message: string;
}

// Same message/code whether the email doesn't exist, the password is wrong,
// or the account is disabled — account existence/status must never be
// distinguishable to the caller (DESIGN.md §11.8, extended to disabled).
const INVALID_CREDENTIALS: ActionError = {
  code: "UNAUTHENTICATED",
  message: "Invalid email or password.",
};

export type SignInResult =
  | { ok: true; userId: string }
  | { ok: false; error: ActionError };

/**
 * Pure sign-in logic: looks up the user, rejects disabled accounts before
 * verifying the password (PLAN.md Account & Membership Lifecycle), and
 * verifies the password. Deliberately has no dependency on next/headers or
 * next/navigation so it can run under Vitest; the "use server" wrapper
 * (lib/auth/actions.ts) handles cookies/redirect.
 *
 * Does NOT create a session (Item 6 originally did this here, but PLAN.md
 * is explicit that an MFA-enrolled platform_owner requires a successful
 * challengeMfa "before issuing a session" — Item 14 moves session issuance
 * into the signIn action itself, conditional on the caller's MFA state).
 */
export async function attemptSignIn(
  email: string,
  password: string,
): Promise<SignInResult> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || user.status === "disabled") {
    return { ok: false, error: INVALID_CREDENTIALS };
  }

  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    return { ok: false, error: INVALID_CREDENTIALS };
  }

  return { ok: true, userId: user.id };
}
