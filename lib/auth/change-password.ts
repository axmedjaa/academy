import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessionsForUser } from "@/lib/auth/session";

/**
 * First sign-in with a temporary password (direct staff account creation,
 * lib/academies/staff.ts createStaff). Pure logic — no next/headers — so it
 * runs under Vitest; lib/auth/change-password-actions.ts wraps it with the
 * session cookie, the rate limit and the redirect.
 *
 * The person proves they hold the temporary password again, chooses a new
 * one under the same policy as every other password (passwordSchema), and
 * it must differ from the temporary one. In one transaction the new
 * Argon2id hash is written and `must_change_password` cleared — guarded by
 * `must_change_password = true`, so a second concurrent request cannot also
 * succeed. Then every session of the account is revoked (the temporary
 * password may have been seen by the administrator who set it); the caller
 * issues one fresh session.
 */

export type ChangeTemporaryPasswordErrorCode = "VALIDATION_ERROR" | "INVALID_CURRENT_PASSWORD" | "NOT_REQUIRED";

export interface ChangeTemporaryPasswordError {
  code: ChangeTemporaryPasswordErrorCode;
  message: string;
  /** Which form field the message belongs to, when it belongs to one. */
  field?: "currentPassword" | "newPassword" | "confirmPassword";
}

export type ChangeTemporaryPasswordResult = { ok: true } | { ok: false; error: ChangeTemporaryPasswordError };

export const changeTemporaryPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your temporary password").max(128, "Password must be at most 128 characters"),
    newPassword: passwordSchema.max(128, "Password must be at most 128 characters"),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "Choose a password different from your temporary password",
    path: ["newPassword"],
  });

export type ChangeTemporaryPasswordInput = z.input<typeof changeTemporaryPasswordSchema>;

const NOT_REQUIRED: ChangeTemporaryPasswordError = {
  code: "NOT_REQUIRED",
  message: "Your password has already been changed. Sign in again.",
};

export async function changeTemporaryPassword(
  userId: string,
  input: ChangeTemporaryPasswordInput,
): Promise<ChangeTemporaryPasswordResult> {
  const parsed = changeTemporaryPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: issue?.message ?? "Invalid input.",
        field: field === "currentPassword" || field === "newPassword" || field === "confirmPassword" ? field : undefined,
      },
    };
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash, status: users.status, mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== "active" || !user.mustChangePassword) return { ok: false, error: NOT_REQUIRED };

  if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
    return {
      ok: false,
      error: { code: "INVALID_CURRENT_PASSWORD", message: "Your temporary password is incorrect.", field: "currentPassword" },
    };
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);

  const changed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.mustChangePassword, true)))
      .returning({ id: users.id });
    if (rows.length === 0) return false;
    // Never includes either password or a hash.
    await recordAudit(
      {
        actorUserId: userId,
        action: "temporary_password_changed",
        entityType: "user",
        entityId: userId,
        before: { mustChangePassword: true },
        after: { mustChangePassword: false },
      },
      tx,
    );
    return true;
  });
  if (!changed) return { ok: false, error: NOT_REQUIRED };

  await revokeAllSessionsForUser(userId);
  return { ok: true };
}
