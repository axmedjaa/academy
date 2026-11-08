import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mfaRecoveryCodes } from "@/lib/db/schema";
import { getPlatformRole } from "@/lib/auth/auth-context";
import { verifyMfaEmailOtp } from "@/lib/auth/mfa-email-otp";
import { recordAudit } from "@/lib/audit";

/**
 * Two-step verification for platform staff (every platform role, security
 * audit SEC-M-09). The second step is a code emailed at every sign-in
 * (lib/auth/mfa-email-otp.ts); recovery codes are the backup for when the
 * email can't be reached.
 *
 * Authenticator-app (TOTP) verification has been retired. Existing
 * mfa_totp_credentials rows are kept untouched (no data is deleted) but are
 * no longer read: those accounts now receive email codes like everyone
 * else, and their recovery codes keep working.
 */

const RECOVERY_CODE_COUNT = 10;

function generateRecoveryCode(): string {
  const raw = randomBytes(5).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** How many unused recovery codes the account has (the codes themselves are only hashes). */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const rows = await db
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return rows.length;
}

export interface RegenerateRecoveryCodesError {
  code: "NOT_ELIGIBLE";
  message: string;
}

export type RegenerateRecoveryCodesResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: RegenerateRecoveryCodesError };

/**
 * Issues a fresh set of recovery codes, replacing the whole previous set.
 * Only for platform staff, the accounts two-step verification applies to.
 * All prior codes (used or not) are deleted, not just superseded, so a
 * potentially-compromised old code can never be used after a regeneration —
 * replace, not append, in one transaction. Codes are returned once and
 * stored only as SHA-256 hashes.
 */
export async function regenerateRecoveryCodesForUser(userId: string): Promise<RegenerateRecoveryCodesResult> {
  if (!(await getPlatformRole(userId))) {
    return {
      ok: false,
      error: { code: "NOT_ELIGIBLE", message: "Recovery codes are only used by platform staff accounts." },
    };
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.insert(mfaRecoveryCodes).values(
      recoveryCodes.map((recoveryCode) => ({
        userId,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    );

    // Audited inside the same transaction. Never the plaintext codes, only a count.
    await recordAudit(
      {
        actorUserId: userId,
        action: "regenerateRecoveryCodes",
        entityType: "mfa_recovery_codes",
        entityId: userId,
        after: { regeneratedCount: recoveryCodes.length },
      },
      tx,
    );
  });

  return { ok: true, recoveryCodes };
}

export type MfaChallengeMode = "email" | "recovery";

export interface MfaChallengeError {
  code: "INVALID_CODE";
  message: string;
}

export type MfaChallengeResult = { ok: true } | { ok: false; error: MfaChallengeError };

// Same message for a wrong, expired or reused code of either kind, so the
// response never reveals which case occurred.
const INVALID_MFA_CODE: MfaChallengeError = {
  code: "INVALID_CODE",
  message: "Invalid code.",
};

/**
 * Single-use: the code is claimed by one conditional UPDATE
 * (`used_at IS NULL`), so two parallel submissions of the same recovery code
 * can't both succeed.
 */
async function validateRecoveryCodeChallenge(userId: string, code: string): Promise<boolean> {
  const codeHash = hashRecoveryCode(code.trim().toUpperCase());

  const claimed = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, codeHash),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });

  if (claimed.length > 0) {
    await recordAudit({
      actorUserId: userId,
      action: "mfa_recovery_code_used",
      entityType: "mfa_recovery_codes",
      entityId: userId,
    });
  }
  return claimed.length > 0;
}

/**
 * The sign-in challenge: required before any session is issued to a
 * platform staff account. `userId` always comes from the signed pending-MFA
 * cookie, never from the client.
 */
export async function verifyMfaChallenge(
  userId: string,
  mode: MfaChallengeMode,
  code: string,
): Promise<MfaChallengeResult> {
  const valid =
    mode === "recovery" ? await validateRecoveryCodeChallenge(userId, code) : await verifyMfaEmailOtp(userId, code);

  return valid ? { ok: true } : { ok: false, error: INVALID_MFA_CODE };
}
