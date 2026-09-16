import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const SESSION_COOKIE_NAME = "session";

const DEFAULT_SESSION_DURATION_DAYS = 30;
const SESSION_DURATION_MS =
  (env.SESSION_DURATION_DAYS ?? DEFAULT_SESSION_DURATION_DAYS) *
  24 *
  60 *
  60 *
  1000;

/** 256-bit random session token (PLAN.md Phase 0 security considerations). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** DB stores only the SHA-256 hash of the token, never the token itself. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateSessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  meta: CreateSessionMeta = {},
): Promise<{ token: string; session: SessionRecord }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    .returning({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    });

  return { token, session: row };
}

/**
 * Looks up a session by its raw token. Returns null for a nonexistent,
 * revoked, or expired session — revoked/expired sessions are rejected
 * server-side on every request (PLAN.md Phase 0 security considerations).
 */
export async function validateSessionToken(
  token: string,
): Promise<SessionRecord | null> {
  const tokenHash = hashSessionToken(token);

  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
}

/** Explicit revocation (e.g. on logout). Idempotent. */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/**
 * Revokes every active session for a user. Not explicitly required by
 * PLAN.md, but used by resetPassword (Item 8) — a completed password reset
 * should invalidate any session that might exist under the old credentials,
 * the same way logout already does for a single session.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export interface SessionSummary {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Item 16: the active-sessions list for /account/security. Only active
 * (unrevoked, unexpired) sessions — DESIGN.md §7 calls this an
 * "Active-sessions list", not a full history.
 *
 * DESIGN.md also asks for a "last-active" column, but the sessions schema
 * (PLAN.md Phase 0) has no such field and nothing tracks per-request
 * activity — createdAt (labeled "Signed in" at the UI layer, not "last
 * active") is the closest honest substitute available without adding a
 * column/touch-tracking mechanism this item never asks for.
 */
export async function listActiveSessionsForUser(
  userId: string,
): Promise<SessionSummary[]> {
  return db
    .select({
      id: sessions.id,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.createdAt));
}

export interface RevokeSessionError {
  code: "NOT_FOUND";
  message: string;
}

/**
 * PLAN.md: "revokeSession must verify the target session belongs to the
 * calling user before revoking — an explicit IDOR-class check with its own
 * test." Same NOT_FOUND whether the session doesn't exist or belongs to
 * someone else (API & Server-Action Contract: cross-tenant/cross-user
 * existence never leaks via a distinguishable error).
 */
export async function revokeSessionForUser(
  userId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; error: RevokeSessionError }> {
  const [session] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session || session.userId !== userId) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "Session not found." },
    };
  }

  await revokeSession(sessionId);
  return { ok: true };
}

/** Used by "Sign out of all other sessions" — excludes the caller's own current session. */
export async function revokeAllOtherSessionsForUser(
  userId: string,
  currentSessionId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.id, currentSessionId),
        isNull(sessions.revokedAt),
      ),
    );
}

/**
 * Cookie options for SESSION_COOKIE_NAME, per PLAN.md: httpOnly, secure in
 * prod, sameSite=lax. Kept as a plain object (no next/headers import here)
 * so this module stays framework-agnostic and unit-testable; the actual
 * `cookies().set(...)` call is wired in by signIn/signOut (Item 6).
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  };
}
