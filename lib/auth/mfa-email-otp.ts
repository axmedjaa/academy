import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mfaEmailOtps, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/client";
import { mfaEmailOtpEmail } from "@/lib/email/templates";
import { checkMfaEmailOtpRateLimit } from "@/lib/auth/mfa-email-otp-rate-limit";
import { rateLimitMessage } from "@/lib/auth/rate-limit-message";

/**
 * Email verification codes: the primary second step of sign-in for platform
 * staff (every platform role, security audit SEC-M-09). signIn sends one
 * automatically once the password is correct; /mfa/challenge verifies it
 * (recovery codes are the backup, lib/auth/mfa.ts).
 *
 * - A code is 6 random digits from the CSPRNG (`randomInt`).
 * - Only a hash is stored, namespaced by userId (see hashCode).
 * - A code expires after MFA_EMAIL_OTP_TTL_MINUTES (default 10) and is dead
 *   after MAX_VERIFY_ATTEMPTS guesses, counted atomically in the database so
 *   parallel guesses can't share one count.
 * - Sending a new code invalidates every earlier one; a verified code is
 *   marked used in the same conditional UPDATE that accepts it, so it can
 *   only ever log in once.
 * - Sends are limited per user: a short cooldown between sends plus the
 *   windowed limit in mfa-email-otp-rate-limit.ts.
 * - The code is never logged or audited.
 */

const DEFAULT_TTL_MINUTES = 10;
const TOKEN_TTL_MS = (env.MFA_EMAIL_OTP_TTL_MINUTES ?? DEFAULT_TTL_MINUTES) * 60 * 1000;
export const MAX_VERIFY_ATTEMPTS = 5;
/** Minimum time between two codes for the same account ("Resend code" countdown). */
export const RESEND_COOLDOWN_SECONDS = 60;

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// Namespaced by userId: a 6-digit code has far too little entropy for a
// bare sha256 to stand in for a globally-unique identifier — two different
// users can plausibly land on the same code. Lookups are always scoped by
// the userId column itself (never by codeHash alone); this namespacing only
// prevents the hash itself from leaking "these two users got the same code"
// to anyone with raw DB read access.
function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function latestCode(userId: string) {
  const [row] = await db
    .select()
    .from(mfaEmailOtps)
    .where(eq(mfaEmailOtps.userId, userId))
    .orderBy(desc(mfaEmailOtps.createdAt))
    .limit(1);
  return row;
}

function secondsUntilResend(createdAt: Date | undefined, now = Date.now()): number {
  if (!createdAt) return 0;
  return Math.max(0, Math.ceil((createdAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000));
}

export type SendMfaEmailOtpResult =
  | { ok: true; resendAvailableInSeconds: number }
  | {
      ok: false;
      error: { code: "RATE_LIMITED" | "SEND_FAILED"; message: string; retryAfterSeconds?: number };
    };

/**
 * Sends a fresh code to the account's own email address (resolved here from
 * the user id, never taken from the client). Callers pass a userId that is
 * already server-resolved from the signed pending-MFA cookie.
 */
export async function sendMfaEmailOtp(userId: string): Promise<SendMfaEmailOtpResult> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return { ok: false, error: { code: "SEND_FAILED", message: "We couldn't send the code. Please try again." } };
  }

  // Cooldown first, so a quick double-click or re-login doesn't use up the
  // windowed allowance (or the inbox). The earlier code stays valid.
  const wait = secondsUntilResend((await latestCode(userId))?.createdAt);
  if (wait > 0) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: `Please wait ${wait} seconds before requesting another code.`,
        retryAfterSeconds: wait,
      },
    };
  }

  const rateLimit = await checkMfaEmailOtpRateLimit(userId);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: rateLimitMessage(rateLimit, "Too many codes requested."),
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
    };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  // At most one usable code: every earlier one is retired with the insert.
  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(mfaEmailOtps)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaEmailOtps.userId, userId), isNull(mfaEmailOtps.usedAt)));
    const [row] = await tx
      .insert(mfaEmailOtps)
      .values({ userId, codeHash: hashCode(userId, code), expiresAt })
      .returning({ id: mfaEmailOtps.id });
    return row;
  });

  await recordAudit({
    actorUserId: userId,
    action: "mfa_email_otp_requested",
    entityType: "user",
    entityId: userId,
  });

  const content = mfaEmailOtpEmail({ code, expiresInMinutes: TOKEN_TTL_MS / 60_000 });
  const result = await sendEmail({ to: user.email, subject: content.subject, html: content.html, text: content.text });
  if (!result.ok) {
    // A code nobody received is removed, so it can't be guessed at and the
    // resend cooldown doesn't apply to a send that never happened.
    await db.delete(mfaEmailOtps).where(eq(mfaEmailOtps.id, inserted.id));
    // sendEmail() already logged the provider's own error; this line ties
    // it to the account. Never the code, never the API key.
    logger.error("mfa email otp failed to send", { userId, subject: content.subject, providerError: result.error });
    return { ok: false, error: { code: "SEND_FAILED", message: "We couldn't send the code. Please try again." } };
  }

  return { ok: true, resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS };
}

export interface MfaEmailOtpStatus {
  /** A code was sent and can still be entered. */
  codeActive: boolean;
  resendAvailableInSeconds: number;
}

/** What /mfa/challenge shows: whether a code is waiting and the resend countdown. */
export async function getMfaEmailOtpStatus(userId: string): Promise<MfaEmailOtpStatus> {
  const row = await latestCode(userId);
  const now = Date.now();
  const codeActive =
    row !== undefined && row.usedAt === null && row.expiresAt.getTime() > now && row.attempts < MAX_VERIFY_ATTEMPTS;
  return { codeActive, resendAvailableInSeconds: secondsUntilResend(row?.createdAt, now) };
}

/**
 * Verifies a submitted code for `userId` (resolved from the pending-MFA
 * cookie by the caller, never client-supplied). Brute force is limited
 * three ways: the per-IP and per-user challenge limits in challengeMfa, and
 * this code's own attempt count. The count is taken with one conditional
 * UPDATE before comparing, so N parallel guesses use N attempts; acceptance
 * is a second conditional UPDATE on `used_at IS NULL`, so two parallel
 * correct submissions can't both log in.
 */
export async function verifyMfaEmailOtp(userId: string, code: string): Promise<boolean> {
  const [row] = await db
    .select({ id: mfaEmailOtps.id })
    .from(mfaEmailOtps)
    .where(and(eq(mfaEmailOtps.userId, userId), isNull(mfaEmailOtps.usedAt)))
    .orderBy(desc(mfaEmailOtps.createdAt))
    .limit(1);
  if (!row) return false;

  const [counted] = await db
    .update(mfaEmailOtps)
    .set({ attempts: sql`${mfaEmailOtps.attempts} + 1` })
    .where(
      and(
        eq(mfaEmailOtps.id, row.id),
        eq(mfaEmailOtps.userId, userId),
        isNull(mfaEmailOtps.usedAt),
        gt(mfaEmailOtps.expiresAt, new Date()),
        lt(mfaEmailOtps.attempts, MAX_VERIFY_ATTEMPTS),
      ),
    )
    .returning({ codeHash: mfaEmailOtps.codeHash });
  if (!counted) return false;

  if (!sameHash(hashCode(userId, code.trim()), counted.codeHash)) return false;

  const claimed = await db
    .update(mfaEmailOtps)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaEmailOtps.id, row.id), isNull(mfaEmailOtps.usedAt)))
    .returning({ id: mfaEmailOtps.id });
  if (claimed.length === 0) return false;

  await recordAudit({
    actorUserId: userId,
    action: "mfa_email_otp_verified",
    entityType: "user",
    entityId: userId,
  });

  return true;
}
