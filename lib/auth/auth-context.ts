import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { platformMemberships } from "@/lib/db/schema";
import type { PlatformRole } from "@/lib/auth/roles";
import { SESSION_COOKIE_NAME, validateSessionToken } from "@/lib/auth/session";

/**
 * PLAN.md Cross-Cutting Architecture Decisions: "every server action
 * resolves a trusted AuthContext server-side: { userId, platformRole?,
 * academyId?, academyRole?, branchIds[], academyWide: boolean }. The
 * browser never supplies academyId for authorization."
 *
 * academyId/academyRole are always undefined and branchIds always empty
 * for now — academy_memberships doesn't exist until Phase 1 (Item 19).
 */
export interface AuthContext {
  userId: string;
  platformRole?: PlatformRole;
  academyId?: string;
  academyRole?: string;
  branchIds: string[];
  academyWide: boolean;
}

/** Used by signIn (Item 14) to decide the MFA branch before any session exists. */
export async function getPlatformRole(
  userId: string,
): Promise<PlatformRole | undefined> {
  const [membership] = await db
    .select({ role: platformMemberships.role })
    .from(platformMemberships)
    .where(eq(platformMemberships.userId, userId))
    .limit(1);

  return membership?.role;
}

/**
 * Where a just-signed-in user's own "home" is — called once a session is
 * about to be issued (both `signIn`'s non-MFA path and `challengeMfa`'s
 * post-verification path), replacing the previous blanket `redirect("/")`
 * for everyone. Platform staff (owner or admin) land on the platform
 * console's own primary tool; everyone else lands on the academy console.
 * This never checks academy membership itself — an academy-less user simply
 * sees `/academy/dashboard`'s own existing "not a member" message, exactly
 * as if they'd typed that URL themselves; this function only decides which
 * console to send someone toward, not whether they're allowed in.
 */
export async function getPostLoginRedirectPath(userId: string): Promise<string> {
  const platformRole = await getPlatformRole(userId);
  return platformRole ? "/platform/academies" : "/academy/dashboard";
}

/** Resolves the AuthContext for an already-authenticated user. Pure/testable. */
export async function resolveAuthContext(userId: string): Promise<AuthContext> {
  return {
    userId,
    platformRole: await getPlatformRole(userId),
    branchIds: [],
    academyWide: false,
  };
}

/**
 * Reads the session cookie, validates it, and resolves the AuthContext.
 * Returns null if there is no valid session — every server action must
 * treat that as UNAUTHENTICATED. Requires next/headers, so (unlike
 * resolveAuthContext) this can't run under Vitest directly.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await validateSessionToken(token);
  if (!session) return null;

  return resolveAuthContext(session.userId);
}

/**
 * Item 16: identifies which session in /account/security's list is "this
 * device" and which one revokeAllOtherSessions must exclude. Kept separate
 * from AuthContext rather than adding a sessionId field to it — PLAN.md's
 * AuthContext shape is fixed to { userId, platformRole?, academyId?,
 * academyRole?, branchIds[], academyWide }, nothing more.
 */
export async function getCurrentSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await validateSessionToken(token);
  return session?.id ?? null;
}
