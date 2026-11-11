import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { CHANGE_PASSWORD_PATH, getPasswordChangeSession } from "@/lib/auth/auth-context";

/**
 * A session that still holds a temporary password resolves no AuthContext,
 * so every protected page sends it here. Send it on to /change-password
 * instead of showing the sign-in form again.
 */
export default async function LoginLayout({ children }: { children: ReactNode }) {
  if (await getPasswordChangeSession()) redirect(CHANGE_PASSWORD_PATH);
  return children;
}
