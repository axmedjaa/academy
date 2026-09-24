import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailChangeTokens, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/client";
import { verifyEmailChangeEmail } from "@/lib/email/templates";
import { checkEmailChangeRateLimit } from "@/lib/auth/email-change-rate-limit";

const DEFAULT_TOKEN_TTL_MINUTES = 60;
const TOKEN_TTL_MS =
  (env.EMAIL_CHANGE_TOKEN_TTL_MINUTES ?? DEFAULT_TOKEN_TTL_MINUTES) * 60 * 1000;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type IssueEmailChangeResult = { ok: true } | { ok: false; error: string };

/**
 * Mints a single-use, TTL-bound token — same shape/security convention as
 * lib/auth/password-reset.ts's passwordResetTokens (hashed at rest, raw
 * value only ever sent once) — and emails it ONLY to `newEmail`.
 * `users.email` is never touched here or anywhere else until
 * `applyEmailChangeToken` verifies this token; the old email stays
 * authoritative in the meantime. The caller (lib/auth/update-account.ts)
 * has already verified the current password and pre-checked that
 * `newEmail` isn't already in use before calling this.
 *
 * If the send fails (or email isn't configured), the token row already
 * exists but nothing about the account has changed and the caller reports
 * a safe error to the user — no partial state, and the request can simply
 * be retried.
 */
export async function issueEmailChangeToken(
  userId: string,
  newEmail: string,
): Promise<IssueEmailChangeResult> {
  // Invalidate any still-pending verification for this user first, so a
  // fresh request/resend leaves at most one valid link outstanding rather
  // than accumulating several that would all still work.
  await db
    .update(emailChangeTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailChangeTokens.userId, userId), isNull(emailChangeTokens.usedAt)));

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(emailChangeTokens).values({ userId, newEmail, tokenHash, expiresAt });

  await recordAudit({
    actorUserId: userId,
    action: "email_change_verification_requested",
    entityType: "user",
    entityId: userId,
  });

  if (!env.APP_URL) {
    logger.error("email change verification email not sent: APP_URL is not configured", { userId });
    return { ok: false, error: "Email delivery is not configured. Contact an administrator." };
  }

  const verifyUrl = `${env.APP_URL.replace(/\/$/, "")}/account/verify-email?token=${token}`;
  const content = verifyEmailChangeEmail({ verifyUrl, expiresInMinutes: TOKEN_TTL_MS / 60_000 });

  const result = await sendEmail({
    to: newEmail,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
  if (!result.ok) {
    logger.error("email change verification email failed to send", { userId });
    return { ok: false, error: "We couldn't send the verification email. Please try again." };
  }

  return { ok: true };
}

export type ApplyEmailChangeError =
  | { code: "expired"; message: string }
  | { code: "invalid_or_used"; message: string }
  | { code: "email_taken"; message: string };

export type ApplyEmailChangeResult =
  | { ok: true; email: string }
  | { ok: false; error: ApplyEmailChangeError };

const INVALID_OR_USED: ApplyEmailChangeError = {
  code: "invalid_or_used",
  message: "This verification link is invalid or has already been used.",
};

const EXPIRED: ApplyEmailChangeError = {
  code: "expired",
  message: "This verification link has expired.",
};

/**
 * Re-validates the token (exists, unused, unexpired) AND re-checks
 * new-email uniqueness at verify time — not just at request time, since
 * someone else could have claimed `newEmail` in the interim — before
 * actually changing `users.email`. The email flip, token consumption, and
 * audit row are one DB transaction, so a failure partway through never
 * leaves the account half-changed.
 */
export async function applyEmailChangeToken(token: string): Promise<ApplyEmailChangeResult> {
  const tokenHash = hashToken(token);

  const [row] = await db
    .select()
    .from(emailChangeTokens)
    .where(eq(emailChangeTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row || row.usedAt !== null) {
    return { ok: false, error: INVALID_OR_USED };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: EXPIRED };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, row.newEmail))
    .limit(1);
  if (existing && existing.id !== row.userId) {
    return { ok: false, error: { code: "email_taken", message: "That email is already in use." } };
  }

  const previousEmail = await db.transaction(async (tx) => {
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1);

    await tx.update(users).set({ email: row.newEmail, updatedAt: new Date() }).where(eq(users.id, row.userId));
    await tx.update(emailChangeTokens).set({ usedAt: new Date() }).where(eq(emailChangeTokens.id, row.id));

    await recordAudit(
      {
        actorUserId: row.userId,
        action: "email_address_changed",
        entityType: "user",
        entityId: row.userId,
        before: { email: user?.email },
        after: { email: row.newEmail },
      },
      tx,
    );

    return user?.email;
  });

  logger.info("email address changed via verification", { userId: row.userId, hadPreviousEmail: Boolean(previousEmail) });

  return { ok: true, email: row.newEmail };
}

export interface PendingEmailChange {
  newEmail: string;
  expiresAt: Date;
}

/** For `/account/security`'s "Verification pending" UI state — never exposes the token itself, only the pending address and expiry. */
export async function getPendingEmailChange(userId: string): Promise<PendingEmailChange | null> {
  const [row] = await db
    .select({ newEmail: emailChangeTokens.newEmail, expiresAt: emailChangeTokens.expiresAt })
    .from(emailChangeTokens)
    .where(and(eq(emailChangeTokens.userId, userId), isNull(emailChangeTokens.usedAt)))
    .orderBy(emailChangeTokens.createdAt)
    .limit(1);

  if (!row || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return row;
}

export type ResendEmailChangeResult = { ok: true } | { ok: false; error: string };

/**
 * "Resend verification email" — reuses the pending token's own `newEmail`
 * rather than asking the user to retype it or re-enter their current
 * password (this only re-sends to an address they already asked to
 * verify), but is still gated by the same reused rate-limit utility as the
 * original request (lib/auth/email-change-rate-limit.ts) so it can't be
 * used to spam that inbox.
 */
export async function resendEmailChangeVerification(userId: string): Promise<ResendEmailChangeResult> {
  const pending = await getPendingEmailChange(userId);
  if (!pending) {
    return { ok: false, error: "There's no pending email change to resend." };
  }

  const rateLimit = await checkEmailChangeRateLimit(userId);
  if (!rateLimit.allowed) {
    return { ok: false, error: `Too many verification emails requested. Try again in ${rateLimit.retryAfterSeconds}s.` };
  }

  return issueEmailChangeToken(userId, pending.newEmail);
}
