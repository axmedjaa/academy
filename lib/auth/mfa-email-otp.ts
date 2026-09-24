import { randomInt, createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mfaEmailOtps, mfaTotpCredentials, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/client";
import { mfaEmailOtpEmail } from "@/lib/email/templates";
import { checkMfaEmailOtpRateLimit } from "@/lib/auth/mfa-email-otp-rate-limit";

// Duplicated (not imported) from lib/auth/mfa.ts's hasVerifiedMfaCredential
// on purpose — that module will import verifyMfaEmailOtp/sendMfaEmailOtp
// from this one to wire the "email" challenge mode in, so importing the
// other direction back would create a module cycle. The query is a
// one-line existence check; keeping it duplicated is cheaper than a cycle.
async function hasVerifiedTotpCredential(userId: string): Promise<boolean> {
  const [credential] = await db
    .select({ id: mfaTotpCredentials.id })
    .from(mfaTotpCredentials)
    .where(and(eq(mfaTotpCredentials.userId, userId), isNotNull(mfaTotpCredentials.verifiedAt)))
    .limit(1);
  return credential !== undefined;
}

const DEFAULT_TTL_MINUTES = 10;
const TOKEN_TTL_MS = (env.MFA_EMAIL_OTP_TTL_MINUTES ?? DEFAULT_TTL_MINUTES) * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// Namespaced by userId: unlike the 256-bit tokens elsewhere in this
// codebase, a 6-digit code has far too little entropy for a bare sha256 to
// stand in for a globally-unique identifier — two different users can
// plausibly land on the same code. Lookups are always additionally scoped
// by the userId column itself (never by codeHash alone); this namespacing
// only prevents the hash value itself from leaking "these two users got
// the same code" to anyone with raw DB read access.
function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

export type SendMfaEmailOtpResult =
  | { ok: true }
  | { ok: false; error: { code: "RATE_LIMITED" | "NOT_ENROLLED" | "SEND_FAILED"; message: string } };

/**
 * An ADDITIONAL login-time MFA method alongside the existing authenticator-
 * app TOTP (lib/auth/mfa.ts) — never a replacement, and never an
 * enrollment path of its own: this refuses to send anything for an account
 * that doesn't already have a verified TOTP credential, so a not-yet-
 * enrolled platform_owner can't use this to skip TOTP enrollment (the
 * pending-MFA cookie that gates every caller of this function is shared
 * between the "not enrolled -> /mfa/setup" and "enrolled -> /mfa/challenge"
 * branches, so this check has to be enforced here, not just by page
 * routing).
 *
 * Invalidates any still-outstanding code for this user first, so at most
 * one code is ever valid at a time — requesting/resending supersedes
 * whatever was sent before.
 */
export async function sendMfaEmailOtp(userId: string): Promise<SendMfaEmailOtpResult> {
  if (!(await hasVerifiedTotpCredential(userId))) {
    return { ok: false, error: { code: "NOT_ENROLLED", message: "Set up two-factor authentication first." } };
  }

  const rateLimit = await checkMfaEmailOtpRateLimit(userId);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: { code: "RATE_LIMITED", message: `Too many codes requested. Try again in ${rateLimit.retryAfterSeconds}s.` },
    };
  }

  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return { ok: false, error: { code: "SEND_FAILED", message: "We couldn't send the code. Please try again." } };
  }

  await db
    .update(mfaEmailOtps)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaEmailOtps.userId, userId), isNull(mfaEmailOtps.usedAt)));

  const code = generateCode();
  const codeHash = hashCode(userId, code);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(mfaEmailOtps).values({ userId, codeHash, expiresAt });

  await recordAudit({
    actorUserId: userId,
    action: "mfa_email_otp_requested",
    entityType: "user",
    entityId: userId,
  });

  const content = mfaEmailOtpEmail({ code, expiresInMinutes: TOKEN_TTL_MS / 60_000 });
  const result = await sendEmail({ to: user.email, subject: content.subject, html: content.html, text: content.text });
  if (!result.ok) {
    // sendEmail() (lib/email/client.ts) already logged the provider's own
    // error name/message/status for this same call — this second, MFA-
    // specific line exists so a log search for "mfa email otp" finds which
    // userId/recipient/subject that provider failure belongs to, without
    // repeating any secret. Never the OTP code, never the API key.
    logger.error("mfa email otp failed to send", { userId, recipient: user.email, subject: content.subject, providerError: result.error });
    return { ok: false, error: { code: "SEND_FAILED", message: "We couldn't send the code. Please try again." } };
  }

  return { ok: true };
}

/**
 * Verifies a submitted email-OTP code for `userId` (already resolved from
 * the pending-MFA cookie by the caller — never a client-supplied id).
 * Brute-force protection is layered: the caller (lib/auth/mfa-actions.ts's
 * challengeMfa) already applies the shared per-IP mfa-challenge rate limit
 * to this whole endpoint, and independently, each stored code tracks its
 * own `attempts` count — once a code hits MAX_VERIFY_ATTEMPTS wrong
 * guesses it's dead even if not yet expired, forcing a fresh resend rather
 * than allowing unlimited guesses against one still-valid code.
 */
export async function verifyMfaEmailOtp(userId: string, code: string): Promise<boolean> {
  if (!(await hasVerifiedTotpCredential(userId))) {
    return false;
  }

  const [row] = await db
    .select()
    .from(mfaEmailOtps)
    .where(and(eq(mfaEmailOtps.userId, userId), isNull(mfaEmailOtps.usedAt)))
    .orderBy(desc(mfaEmailOtps.createdAt))
    .limit(1);

  if (!row) return false;
  if (row.expiresAt.getTime() <= Date.now()) return false;
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) return false;

  const submittedHash = hashCode(userId, code.trim());
  if (submittedHash !== row.codeHash) {
    await db.update(mfaEmailOtps).set({ attempts: row.attempts + 1 }).where(eq(mfaEmailOtps.id, row.id));
    return false;
  }

  // Single-use: marked used immediately, before returning success.
  await db.update(mfaEmailOtps).set({ usedAt: new Date() }).where(eq(mfaEmailOtps.id, row.id));

  await recordAudit({
    actorUserId: userId,
    action: "mfa_email_otp_verified",
    entityType: "user",
    entityId: userId,
  });

  return true;
}
