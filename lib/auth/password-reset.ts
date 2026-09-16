import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { passwordResetTokens, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/lib/auth/password";
import { revokeAllSessionsForUser } from "@/lib/auth/session";

const DEFAULT_TOKEN_TTL_MINUTES = 60;
const TOKEN_TTL_MS =
  (env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? DEFAULT_TOKEN_TTL_MINUTES) *
  60 *
  1000;

function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Always succeeds from the caller's point of view — whether the email
 * exists, belongs to a disabled account, or not, the UI shows the exact
 * same neutral confirmation (DESIGN.md §11.8: "If that email exists, a
 * reset link has been sent." — identical either way). A token is only
 * actually issued for an existing, active account.
 *
 * No email provider exists yet anywhere in this project (deferred to
 * Phase 5's notification infrastructure) — the reset link is logged
 * instead, as an explicit placeholder for real delivery.
 */
export async function issuePasswordResetToken(email: string): Promise<void> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || user.status === "disabled") {
    return;
  }

  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  // Placeholder for real email delivery (no lib/email exists yet).
  logger.info("password reset link generated", {
    userId: user.id,
    resetLink: `/reset-password?token=${token}`,
  });
}

export interface ResetPasswordError {
  code: "INVALID_TOKEN";
  message: string;
}

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: ResetPasswordError };

const INVALID_TOKEN: ResetPasswordError = {
  code: "INVALID_TOKEN",
  message: "This reset link is invalid or has expired. Request a new one.",
};

/**
 * Validates the token (exists, unused, unexpired), sets the new password,
 * marks the token used, and revokes every existing session for that user —
 * the same reasoning as signOut, extended to "your old credentials, and
 * anything authenticated with them, are no longer valid" (not explicitly
 * stated in PLAN.md; a standard, closely-related security expectation for
 * this feature, flagged here rather than assumed silently).
 */
export async function applyPasswordReset(
  token: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  const tokenHash = hashResetToken(token);

  const [resetToken] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (!resetToken || resetToken.usedAt !== null) {
    return { ok: false, error: INVALID_TOKEN };
  }
  if (resetToken.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: INVALID_TOKEN };
  }

  const passwordHash = await hashPassword(newPassword);

  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, resetToken.userId));

  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, resetToken.id));

  await revokeAllSessionsForUser(resetToken.userId);

  return { ok: true };
}
