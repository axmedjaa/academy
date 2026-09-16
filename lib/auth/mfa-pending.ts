import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * PLAN.md says signIn must "require challengeMfa before issuing a session"
 * once a platform_owner is enrolled — i.e. no `sessions` row exists between
 * password verification and a completed MFA step. PLAN.md never specifies
 * the mechanism for carrying "which user passed password check" across
 * that gap (no pending-challenge table exists anywhere in its schema), so
 * this is a judgment call: a short-lived, HMAC-signed cookie, not backed by
 * the DB. The same cookie also covers the "not yet enrolled" branch, since
 * the security text is equally explicit that no platform action should be
 * possible before enrollment completes either.
 *
 * The HMAC key is derived from MFA_ENCRYPTION_KEY (domain-separated via a
 * fixed label) rather than requiring a whole new secret — reusing the raw
 * key for two different primitives (AES-GCM encryption elsewhere, HMAC
 * here) without derivation would be poor practice, so a distinct key is
 * derived instead of reusing the raw bytes directly.
 */
export const MFA_PENDING_COOKIE_NAME = "mfa_pending";
const PENDING_MFA_TTL_MS = 10 * 60 * 1000;

function getSigningKey(): Buffer {
  return createHash("sha256")
    .update(Buffer.from(env.MFA_ENCRYPTION_KEY, "base64"))
    .update("mfa-pending-hmac-v1")
    .digest();
}

export function createPendingMfaToken(userId: string): string {
  const payload = JSON.stringify({
    userId,
    exp: Date.now() + PENDING_MFA_TTL_MS,
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", getSigningKey())
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

export function verifyPendingMfaToken(token: string): { userId: string } | null {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expectedSignature = createHmac("sha256", getSigningKey())
    .update(payloadB64)
    .digest("base64url");

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as { userId: string; exp: number };

    if (typeof payload.userId !== "string" || payload.exp < Date.now()) {
      return null;
    }

    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export function pendingMfaCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(PENDING_MFA_TTL_MS / 1000),
  };
}
