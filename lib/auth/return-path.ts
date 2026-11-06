import { env } from "@/lib/env";

/**
 * Return-after-login (SEC-H-01 follow-up). Where to send someone once they
 * have signed in, carried in a short-lived httpOnly cookie scoped to /login
 * rather than a URL parameter, so an invitation token never appears in the
 * login URL, browser history or request logs.
 *
 * `sanitizeReturnPath` is the only gate: it runs when the cookie is set and
 * again when it is read, and accepts only a same-origin relative path under
 * an allowlisted section. Anything else is dropped and the normal post-login
 * destination is used.
 */

export const RETURN_PATH_COOKIE = "post_login_return";
const RETURN_PATH_TTL_SECONDS = 15 * 60;
const MAX_RETURN_PATH_LENGTH = 1024;

/** Sections a signed-in person may be returned to. */
const ALLOWED_PREFIXES = ["/staff-invitation", "/academy", "/platform", "/account"] as const;

// Parsing base only; never used as a destination.
const PARSE_BASE = "https://return-path.invalid";

export function sanitizeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  // Exactly one leading slash: rejects absolute URLs, `//host` and `/\host`.
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // No backslashes, whitespace or control characters anywhere (browsers
  // normalize `\` to `/` and strip some whitespace, which enables `/\evil`).
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  // Encoded slashes or backslashes are never needed by an internal page.
  if (/%(2f|5c)/i.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (parsed.origin !== PARSE_BASE) return null;

  // After dot-segment normalization, the path must sit under an allowed section.
  const path = parsed.pathname;
  const allowed = ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!allowed) return null;

  // The fragment is never sent to the server; drop it.
  return `${path}${parsed.search}`;
}

export function returnPathCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    // Sent only with requests to the login page (where `signIn` reads it).
    path: "/login",
    maxAge: RETURN_PATH_TTL_SECONDS,
  };
}

/** Invitation tokens are 32 random bytes in base64url. */
export function isWellFormedInvitationToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
