import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { issueEmailChangeToken } from "@/lib/auth/email-change";
import { checkEmailChangeRateLimit } from "@/lib/auth/email-change-rate-limit";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Self-service "update my own account" — email + password only (no schema
 * change: `users` has no name/profile field at all today, and adding one is
 * a separate, deliberate decision, not bundled into this). Applies
 * identically to every account type (platform_owner, platform_admin, and
 * every academy role) since they're all just a `users` row — there is no
 * role-specific gate here beyond "this is your own account," matching how
 * `/account/security`'s existing session-management actions work.
 *
 * Both actions require re-entering the current password before changing
 * anything sensitive — the same "prove you still are this person" pattern
 * this codebase already uses for the login flow itself, not a new
 * convention. Pure/framework-agnostic (no "use server", no next/navigation)
 * so both are directly Vitest-testable against the real local Postgres DB,
 * matching this codebase's existing lib/*.ts split.
 */

export interface UpdateAccountActionError {
  code: "forbidden" | "validation" | "wrong_password" | "email_taken" | "rate_limited" | "email_send_failed";
  message: string;
}

const WRONG_PASSWORD: UpdateAccountActionError = {
  code: "wrong_password",
  message: "Current password is incorrect.",
};

const NOT_FOUND: UpdateAccountActionError = {
  code: "forbidden",
  message: "Account not found.",
};

function validationError(message: string): UpdateAccountActionError {
  return { code: "validation", message };
}

const updateEmailSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newEmail: z.string().trim().toLowerCase().email("Enter a valid email address."),
});

export type UpdateOwnEmailInput = z.input<typeof updateEmailSchema>;

export type UpdateOwnEmailResult =
  | { ok: true; status: "unchanged" }
  | { ok: true; status: "verification_sent"; newEmail: string }
  | { ok: false; error: UpdateAccountActionError };

/**
 * Does NOT change `users.email`. On success it only issues a
 * verification token and emails it to `newEmail` (lib/auth/email-change.ts)
 * — the address only takes effect once that link is clicked and
 * `applyEmailChangeToken` re-validates everything (including uniqueness
 * again, in case it was claimed in the meantime). This function still owns
 * every check that gates *requesting* a change: current password,
 * new-email format/no-op, and duplicate check against the email currently
 * in use by any account.
 */
export async function updateOwnEmail(
  actorContext: AuthContext,
  input: UpdateOwnEmailInput,
): Promise<UpdateOwnEmailResult> {
  const parsed = updateEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: validationError(parsed.error.issues[0]?.message ?? "Invalid input.") };
  }
  const { currentPassword, newEmail } = parsed.data;

  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actorContext.userId))
    .limit(1);
  if (!user) {
    return { ok: false, error: NOT_FOUND };
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    return { ok: false, error: WRONG_PASSWORD };
  }

  if (newEmail === user.email) {
    return { ok: true, status: "unchanged" };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, newEmail))
    .limit(1);
  if (existing) {
    return { ok: false, error: { code: "email_taken", message: "That email is already in use." } };
  }

  const rateLimit = await checkEmailChangeRateLimit(actorContext.userId);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: `Too many verification emails requested. Try again in ${rateLimit.retryAfterSeconds}s.`,
      },
    };
  }

  const issued = await issueEmailChangeToken(user.id, newEmail);
  if (!issued.ok) {
    return { ok: false, error: { code: "email_send_failed", message: issued.error } };
  }

  return { ok: true, status: "verification_sent", newEmail };
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm your new password."),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type ChangeOwnPasswordInput = z.input<typeof changePasswordSchema>;

export type ChangeOwnPasswordResult = { ok: true } | { ok: false; error: UpdateAccountActionError };

export async function changeOwnPassword(
  actorContext: AuthContext,
  input: ChangeOwnPasswordInput,
): Promise<ChangeOwnPasswordResult> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: validationError(parsed.error.issues[0]?.message ?? "Invalid input.") };
  }
  const { currentPassword, newPassword } = parsed.data;

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actorContext.userId))
    .limit(1);
  if (!user) {
    return { ok: false, error: NOT_FOUND };
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    return { ok: false, error: WRONG_PASSWORD };
  }

  const newPasswordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Never include the password/hash in the audit row — recordAudit redacts
  // regardless, but this also just never passes it in (same convention as
  // registerAcademy/createStaff's own audit calls).
  await recordAudit({
    actorUserId: actorContext.userId,
    actorRole: actorContext.platformRole,
    action: "changeOwnPassword",
    entityType: "user",
    entityId: user.id,
  });

  return { ok: true };
}

// Same "blank string -> undefined" convention used throughout this codebase
// (e.g. lib/academies/register.ts's optionalText) — an empty field means
// "leave this as-is," not "set it to empty."
function optionalTrimmed() {
  return z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

const updateAccountSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    // Same "optional -> undefined, format-checked only when present" chain
    // as lib/academies/register.ts's own optional `email` field.
    newEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value && value.length > 0 ? value : undefined))
      .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
        message: "Enter a valid email address.",
      }),
    newPassword: optionalTrimmed(),
    confirmPassword: optionalTrimmed(),
  })
  .refine((data) => data.newEmail !== undefined || data.newPassword !== undefined, {
    message: "Enter a new email or a new password — nothing to update otherwise.",
    path: ["newEmail"],
  })
  .refine((data) => data.newPassword === undefined || data.newPassword.length >= 12, {
    message: "New password must be at least 12 characters.",
    path: ["newPassword"],
  })
  .refine((data) => data.newPassword === undefined || data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type UpdateOwnAccountInput = z.input<typeof updateAccountSchema>;

export type UpdateOwnAccountResult =
  | { ok: true; emailVerificationSent?: string; passwordChanged: boolean }
  | { ok: false; error: UpdateAccountActionError };

/**
 * The single-form "Account" page's own action — updates email and/or
 * password in one submit, behind one current-password entry, rather than
 * making the person re-enter their current password twice across two
 * separate forms. Built on top of `updateOwnEmail`/`changeOwnPassword`
 * above (kept as-is, including their own tests) rather than duplicating
 * their verification/validation logic — this is an orchestration layer,
 * not a second implementation.
 *
 * `emailVerificationSent` carries the pending new address when a
 * verification email was actually sent — `users.email` itself does not
 * change until that link is clicked (see updateOwnEmail's doc comment).
 *
 * At least one of `newEmail`/`newPassword` must be provided (enforced by
 * the schema above) — submitting neither would be a no-op, which the UI
 * should never actually allow via its own "nothing changed" disabled state,
 * but this is still checked server-side rather than assumed.
 */
export async function updateOwnAccount(
  actorContext: AuthContext,
  input: UpdateOwnAccountInput,
): Promise<UpdateOwnAccountResult> {
  const parsed = updateAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: validationError(parsed.error.issues[0]?.message ?? "Invalid input.") };
  }
  const { currentPassword, newEmail, newPassword } = parsed.data;

  let emailVerificationSent: string | undefined;
  if (newEmail !== undefined) {
    const emailResult = await updateOwnEmail(actorContext, { currentPassword, newEmail });
    if (!emailResult.ok) {
      return emailResult;
    }
    if (emailResult.status === "verification_sent") {
      emailVerificationSent = emailResult.newEmail;
    }
  }

  let passwordChanged = false;
  if (newPassword !== undefined) {
    const passwordResult = await changeOwnPassword(actorContext, {
      currentPassword,
      newPassword,
      confirmPassword: newPassword,
    });
    if (!passwordResult.ok) {
      // The email half (if requested) already succeeded by this point —
      // surfaced as an error to fix and resubmit rather than silently
      // losing it; email itself is never rolled back, matching this
      // codebase's "no distributed rollback across independent actions"
      // convention (e.g. registerAcademy's own subscription-creation
      // failure path is the one place that DOES roll back, specifically
      // because it's all one transaction — this orchestration deliberately
      // is not).
      return passwordResult;
    }
    passwordChanged = true;
  }

  return { ok: true, emailVerificationSent, passwordChanged };
}
