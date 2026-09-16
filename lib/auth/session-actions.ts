"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthContext, getCurrentSessionId } from "@/lib/auth/auth-context";
import {
  listActiveSessionsForUser,
  revokeAllOtherSessionsForUser,
  revokeSessionForUser,
  type SessionSummary,
} from "@/lib/auth/session";

export async function listMySessions(): Promise<SessionSummary[]> {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  return listActiveSessionsForUser(context.userId);
}

/**
 * Bound per-row via `.bind(null, sessionId)` — the IDOR check itself lives
 * in revokeSessionForUser (lib/auth/session.ts), which is what has its own
 * dedicated test per PLAN.md.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  await revokeSessionForUser(context.userId, sessionId);
  revalidatePath("/account/security");
}

export async function revokeAllOtherSessions(): Promise<void> {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const currentSessionId = await getCurrentSessionId();
  if (currentSessionId) {
    await revokeAllOtherSessionsForUser(context.userId, currentSessionId);
  }

  revalidatePath("/account/security");
}
