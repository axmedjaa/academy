import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { mfaRecoveryCodes, mfaTotpCredentials, users } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/auth/mfa-encryption";
import { verifyMfaEmailOtp } from "@/lib/auth/mfa-email-otp";
import { recordAudit } from "@/lib/audit";

const ISSUER = "Academy Management SaaS";
const RECOVERY_CODE_COUNT = 10;

function buildTotp(email: string, secretBase32: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: secretBase32,
  });
}

function generateRecoveryCode(): string {
  const raw = randomBytes(5).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Used by /mfa/setup (redirect away if already enrolled) and, later, Item
 * 14's forced-enrollment check in signIn. */
export async function hasVerifiedMfaCredential(userId: string): Promise<boolean> {
  const [credential] = await db
    .select({ id: mfaTotpCredentials.id })
    .from(mfaTotpCredentials)
    .where(
      and(
        eq(mfaTotpCredentials.userId, userId),
        isNotNull(mfaTotpCredentials.verifiedAt),
      ),
    )
    .limit(1);

  return credential !== undefined;
}

export interface EnrollMfaResult {
  secretBase32: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

/**
 * Starts (or resumes) TOTP enrollment for a user. Reuses an existing
 * unverified credential rather than always minting a fresh secret, so
 * refreshing the setup page mid-enrollment doesn't invalidate a QR code
 * the user already scanned into their authenticator app.
 */
export async function enrollMfaForUser(userId: string): Promise<EnrollMfaResult> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error("User not found");
  }

  const [existing] = await db
    .select()
    .from(mfaTotpCredentials)
    .where(
      and(
        eq(mfaTotpCredentials.userId, userId),
        isNull(mfaTotpCredentials.verifiedAt),
      ),
    )
    .orderBy(desc(mfaTotpCredentials.createdAt))
    .limit(1);

  let secretBase32: string;

  if (existing) {
    secretBase32 = decryptSecret(existing.secretEncrypted);
  } else {
    secretBase32 = new OTPAuth.Secret({ size: 20 }).base32;
    const [inserted] = await db
      .insert(mfaTotpCredentials)
      .values({
        userId,
        secretEncrypted: encryptSecret(secretBase32),
      })
      .returning({ id: mfaTotpCredentials.id });

    // Security finding #1: audited only here, on the "mint a fresh
    // secret" branch — resuming an existing unverified enrollment
    // (the `existing` branch above) is not a new mutation and must not
    // be audited a second time. Never include secretBase32/otpauthUrl
    // (it embeds the secret)/qrCodeDataUrl — those are the credential
    // secret itself, computed below, after this audit call.
    await recordAudit({
      actorUserId: userId,
      action: "enrollMfa",
      entityType: "mfa_credential",
      entityId: inserted.id,
    });
  }

  const totp = buildTotp(user.email, secretBase32);
  const otpauthUrl = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return { secretBase32, otpauthUrl, qrCodeDataUrl };
}

export interface VerifyMfaEnrollmentError {
  code: "INVALID_CODE";
  message: string;
}

export type VerifyMfaEnrollmentResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: VerifyMfaEnrollmentError };

const INVALID_CODE: VerifyMfaEnrollmentError = {
  code: "INVALID_CODE",
  message: "Invalid verification code.",
};

/**
 * Validates the 6-digit code against the pending enrollment's secret. On
 * success, marks the credential verified and generates one-time recovery
 * codes (PLAN.md: single-use, SHA-256-hashed, shown once at generation).
 * Verifying + issuing recovery codes happens in one transaction so a
 * credential is never left "verified" with no recovery codes.
 */
export async function verifyMfaEnrollmentForUser(
  userId: string,
  code: string,
): Promise<VerifyMfaEnrollmentResult> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { ok: false, error: INVALID_CODE };
  }

  const [credential] = await db
    .select()
    .from(mfaTotpCredentials)
    .where(
      and(
        eq(mfaTotpCredentials.userId, userId),
        isNull(mfaTotpCredentials.verifiedAt),
      ),
    )
    .orderBy(desc(mfaTotpCredentials.createdAt))
    .limit(1);

  if (!credential) {
    return { ok: false, error: INVALID_CODE };
  }

  const secretBase32 = decryptSecret(credential.secretEncrypted);
  const totp = buildTotp(user.email, secretBase32);

  // window: 1 tolerates ±1 time step (±30s) of clock drift — a standard
  // TOTP validation practice, not stated explicitly in PLAN.md.
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) {
    return { ok: false, error: INVALID_CODE };
  }

  const recoveryCodes = Array.from(
    { length: RECOVERY_CODE_COUNT },
    generateRecoveryCode,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(mfaTotpCredentials)
      .set({ verifiedAt: new Date() })
      .where(eq(mfaTotpCredentials.id, credential.id));

    await tx.insert(mfaRecoveryCodes).values(
      recoveryCodes.map((recoveryCode) => ({
        userId,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    );

    // Security finding #1: audited only on this success path, inside the
    // same transaction (passed `tx`, not `db`) so the audit write commits
    // or rolls back atomically with the mutation it protects. Never
    // include the plaintext `code` parameter or any recoveryCodes string —
    // only a count.
    await recordAudit(
      {
        actorUserId: userId,
        action: "verifyMfaEnrollment",
        entityType: "mfa_credential",
        entityId: credential.id,
        after: { verified: true, recoveryCodesGenerated: recoveryCodes.length },
      },
      tx,
    );
  });

  return { ok: true, recoveryCodes };
}

export interface RegenerateRecoveryCodesError {
  code: "NOT_ENROLLED";
  message: string;
}

export type RegenerateRecoveryCodesResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: RegenerateRecoveryCodesError };

/**
 * Item 15: replaces a user's entire recovery-code set. Requires an
 * existing verified TOTP credential — regenerating codes for MFA that was
 * never enrolled has nothing to regenerate. All prior codes (used or not)
 * are deleted, not just superseded, so a potentially-compromised old code
 * can never be used after a regeneration (that's the point of the
 * feature) — replace, not append, in one transaction.
 */
export async function regenerateRecoveryCodesForUser(
  userId: string,
): Promise<RegenerateRecoveryCodesResult> {
  if (!(await hasVerifiedMfaCredential(userId))) {
    return {
      ok: false,
      error: {
        code: "NOT_ENROLLED",
        message: "Set up two-factor authentication first.",
      },
    };
  }

  const recoveryCodes = Array.from(
    { length: RECOVERY_CODE_COUNT },
    generateRecoveryCode,
  );

  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.insert(mfaRecoveryCodes).values(
      recoveryCodes.map((recoveryCode) => ({
        userId,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    );

    // Security finding #1: audited only on this success path (the
    // NOT_ENROLLED early-return above never reaches here), inside the same
    // transaction via `tx`. Never include the plaintext recovery codes —
    // only a count.
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

export type MfaChallengeMode = "totp" | "recovery" | "email";

export interface MfaChallengeError {
  code: "INVALID_CODE";
  message: string;
}

export type MfaChallengeResult =
  | { ok: true }
  | { ok: false; error: MfaChallengeError };

// Same message for a wrong TOTP code, a wrong/reused recovery code, or no
// verified credential at all — "same lockout/error treatment as the login
// form" (DESIGN.md §3 MFA code component), i.e. a generic error, not one
// that reveals which of those cases occurred.
const INVALID_MFA_CODE: MfaChallengeError = {
  code: "INVALID_CODE",
  message: "Invalid code.",
};

async function validateTotpChallenge(
  userId: string,
  code: string,
): Promise<boolean> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return false;

  const [credential] = await db
    .select()
    .from(mfaTotpCredentials)
    .where(
      and(
        eq(mfaTotpCredentials.userId, userId),
        isNotNull(mfaTotpCredentials.verifiedAt),
      ),
    )
    .orderBy(desc(mfaTotpCredentials.createdAt))
    .limit(1);
  if (!credential) return false;

  const secretBase32 = decryptSecret(credential.secretEncrypted);
  const totp = buildTotp(user.email, secretBase32);

  return totp.validate({ token: code, window: 1 }) !== null;
}

async function validateRecoveryCodeChallenge(
  userId: string,
  code: string,
): Promise<boolean> {
  const codeHash = hashRecoveryCode(code.trim().toUpperCase());

  const [row] = await db
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, codeHash),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .limit(1);
  if (!row) return false;

  // Single-use (PLAN.md): marked used immediately, before returning success.
  await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(mfaRecoveryCodes.id, row.id));

  return true;
}

/**
 * The login-time MFA challenge (Item 14) — distinct from
 * verifyMfaEnrollmentForUser (Item 13), which only ever runs once, during
 * initial setup. Called on every subsequent login for an enrolled
 * platform_owner, per PLAN.md's "require challengeMfa before issuing a
 * session."
 *
 * "email" is an ADDITIONAL method alongside "totp" (never a replacement) —
 * see lib/auth/mfa-email-otp.ts's own doc comments for why it refuses to
 * validate anything for an account without a verified TOTP credential
 * (email OTP is not its own enrollment path).
 */
export async function verifyMfaChallenge(
  userId: string,
  mode: MfaChallengeMode,
  code: string,
): Promise<MfaChallengeResult> {
  const valid =
    mode === "totp"
      ? await validateTotpChallenge(userId, code)
      : mode === "recovery"
        ? await validateRecoveryCodeChallenge(userId, code)
        : await verifyMfaEmailOtp(userId, code);

  return valid ? { ok: true } : { ok: false, error: INVALID_MFA_CODE };
}
