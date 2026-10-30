import { cache } from "react";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { platformMemberships, sessions } from "@/lib/db/schema";
import type { PlatformRole } from "@/lib/auth/roles";
import { SESSION_COOKIE_NAME, hashSessionToken, validateSessionToken } from "@/lib/auth/session";

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
  return platformRole ? "/platform/dashboard" : "/academy/dashboard";
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
 *
 * Wrapped in React's `cache()` — this function has 200+ call sites, and a
 * single page request routinely calls it more than once on its own (e.g.
 * `app/academy/layout.tsx` resolves it, then `app/academy/dashboard/page.tsx`
 * resolves it again), each call paying for two real round-trips to Postgres
 * (`validateSessionToken`'s `sessions` lookup, then `getPlatformRole`'s
 * `platform_memberships` lookup) for the exact same cookie within the same
 * request. `cache()` memoizes by arguments for the lifetime of a single
 * request/render pass only — never across requests or users, so this is
 * pure deduplication, not a security- or freshness-relevant change: a
 * revoked/expired session is still re-validated from scratch on the very
 * next request. This is the standard, Next.js-documented fix for exactly
 * this "same data requested by multiple Server Components in one render"
 * pattern (their own docs name a per-request auth lookup as the canonical
 * example).
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  return resolveAuthContextForSessionToken(token);
});

/**
 * Performance plan P2: `validateSessionToken` + `resolveAuthContext` in ONE
 * round trip instead of two sequential ones (the platform-role lookup
 * needed the session's userId first). `platform_memberships.user_id` is
 * unique, so the LEFT JOIN yields at most one row per session. The
 * revoked/expired checks are exactly `validateSessionToken`'s, applied to
 * the same row on every request — nothing is cached across requests.
 * Separate from `getAuthContext` (no next/headers) so it stays testable.
 */
export async function resolveAuthContextForSessionToken(token: string): Promise<AuthContext | null> {
  const [row] = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      platformRole: platformMemberships.role,
    })
    .from(sessions)
    .leftJoin(platformMemberships, eq(platformMemberships.userId, sessions.userId))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return {
    userId: row.userId,
    platformRole: row.platformRole ?? undefined,
    branchIds: [],
    academyWide: false,
  };
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
