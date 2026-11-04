import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  academyMemberships,
  auditLogs,
  emailChangeTokens,
  mfaEmailOtps,
  mfaRecoveryCodes,
  mfaTotpCredentials,
  passwordResetTokens,
  platformAdminPermissions,
  platformMemberships,
  sessions,
  users,
} from "@/lib/db/schema";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { PLATFORM_ROLES, type PlatformRole } from "@/lib/auth/roles";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import { isGrantableCapability } from "@/lib/platform-staff/capabilities";
import { countActiveOwnersExcluding, lockStaffMutations, type StaffTx } from "@/lib/platform-staff/owner-guard";
import { z } from "zod";

// PLAN.md §4/§5, DESIGN.md §8: "platform.staff.manage covers creating/
// managing platform staff accounts and granting/revoking any platform
// permission... a platform_admin can never manage staff or grants,
// regardless of what else they've been granted." This is already in
// UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts) — hasPermission()
// returns true for this capability only for an active platform_owner.
// Academy roles never have a platformRole, so they can never pass it.
const STAFF_MANAGE_CAPABILITY = "platform.staff.manage";

export interface StaffActionError {
  code:
    | "forbidden"
    | "validation"
    | "email_taken"
    | "target_not_found"
    | "target_not_platform_admin"
    | "ungrantable"
    | "self_action"
    | "last_owner"
    | "archived"
    | "not_archived"
    | "has_history";
  message: string;
}

export type StaffResult<T = object> = ({ ok: true } & T) | { ok: false; error: StaffActionError };

const FORBIDDEN: StaffActionError = {
  code: "forbidden",
  message: "You don't have permission to manage platform staff.",
};

const NOT_FOUND: StaffActionError = { code: "target_not_found", message: "Staff account not found." };

const EMAIL_TAKEN: StaffActionError = {
  code: "email_taken",
  message: "An account with that email already exists.",
};

const LAST_OWNER: StaffActionError = {
  code: "last_owner",
  message: "This is the last active Platform Owner. Make another account an owner first.",
};

async function requireStaffManagePermission(
  actorContext: AuthContext,
): Promise<StaffActionError | null> {
  const allowed = await hasPermission(actorContext, STAFF_MANAGE_CAPABILITY);
  return allowed ? null : FORBIDDEN;
}

function validationError(issues: { message: string }[]): StaffActionError {
  return { code: "validation", message: issues[0]?.message ?? "Invalid input." };
}

const userIdSchema = z.string().uuid("Enter a valid account id.");

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

type Tx = StaffTx;

async function loadTarget(tx: Tx, userId: string) {
  const [row] = await tx
    .select({
      userId: users.id,
      email: users.email,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      role: platformMemberships.role,
      fullName: platformMemberships.fullName,
      archivedAt: platformMemberships.archivedAt,
    })
    .from(platformMemberships)
    .innerJoin(users, eq(users.id, platformMemberships.userId))
    .where(eq(platformMemberships.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Revokes every live session for a user inside the caller's transaction. */
async function revokeSessionsTx(tx: Tx, userId: string): Promise<number> {
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

/** Revokes every grant row for a user; returns the capabilities removed. */
async function revokeAllGrantsTx(tx: Tx, userId: string): Promise<string[]> {
  const removed = await tx
    .delete(platformAdminPermissions)
    .where(eq(platformAdminPermissions.userId, userId))
    .returning({ capability: platformAdminPermissions.capability });
  return removed.map((row) => row.capability);
}

const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the person's full name.")
  .max(120, "Name must be 120 characters or fewer.");

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

const roleSchema = z.enum(PLATFORM_ROLES, { message: "Choose a valid platform role." });

// ─── Create ──────────────────────────────────────────────────────────────

const createStaffSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema,
});

export type CreatePlatformStaffResult = StaffResult<{ userId: string }>;

/**
 * Creates a platform staff account with the chosen platform role. A new
 * Platform Admin starts with no grants; a new Platform Owner is forced into
 * MFA enrollment on first sign-in by the existing sign-in flow
 * (lib/auth/actions.ts) before any session is issued.
 */
export async function createPlatformStaffAccount(
  actorContext: AuthContext,
  input: { fullName: string; email: string; password: string; role: string },
): Promise<CreatePlatformStaffResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = createStaffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: validationError(parsed.error.issues) };
  const { fullName, email, password, role } = parsed.data;

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return { ok: false, error: EMAIL_TAKEN };

  const passwordHash = await hashPassword(password);

  try {
    const userId = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, passwordHash }).returning({ id: users.id });
      await tx.insert(platformMemberships).values({ userId: user.id, role, fullName });

      // Same-transaction audit write (Cross-Cutting Architecture Decisions:
      // "a sensitive mutation cannot succeed if its audit write fails").
      // Never includes the password/hash.
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: actorContext.platformRole,
          action: role === "platform_admin" ? "createPlatformAdminAccount" : "createPlatformStaffAccount",
          entityType: "platform_membership",
          entityId: user.id,
          after: { email, fullName, role },
        },
        tx,
      );
      return user.id;
    });
    return { ok: true, userId };
  } catch (err) {
    // A concurrent create with the same email loses on users_email_unique.
    if (pgErrorCode(err) === "23505") return { ok: false, error: EMAIL_TAKEN };
    throw err;
  }
}

export type CreatePlatformAdminAccountResult = CreatePlatformStaffResult;

/**
 * Original Phase 1 entry point, kept for existing callers/tests: creates a
 * Platform Admin. New UI goes through createPlatformStaffAccount.
 */
export async function createPlatformAdminAccount(
  actorContext: AuthContext,
  input: { email: string; password: string; fullName?: string },
): Promise<CreatePlatformAdminAccountResult> {
  const fallbackName = input.email.split("@")[0] ?? "";
  return createPlatformStaffAccount(actorContext, {
    fullName: input.fullName ?? (fallbackName.length >= 2 ? fallbackName : "Platform Admin"),
    email: input.email,
    password: input.password,
    role: "platform_admin",
  });
}

// ─── Update (name, email, role) ──────────────────────────────────────────

const updateStaffSchema = z.object({
  userId: userIdSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  role: roleSchema,
});

export type UpdatePlatformStaffResult = StaffResult<{ sessionsRevoked: number }>;

/**
 * Edits an active staff account. Server-side rules:
 *  - archived accounts must be restored first;
 *  - the actor can't change their own role or email here (lock-out guard —
 *    their own email goes through the verified /account email-change flow);
 *  - demoting a Platform Owner requires another active owner to remain;
 *  - any role change revokes the target's sessions so the new role only
 *    applies after a fresh sign-in (a newly promoted owner then has to pass
 *    MFA before getting a session), and clears admin grants (owners need
 *    none; a later demotion must not silently restore old grants);
 *  - an email change invalidates outstanding password-reset and
 *    email-change links, which were addressed to the old inbox.
 */
export async function updatePlatformStaff(
  actorContext: AuthContext,
  input: { userId: string; fullName: string; email: string; role: string },
): Promise<UpdatePlatformStaffResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = updateStaffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: validationError(parsed.error.issues) };
  const { userId, fullName, email, role } = parsed.data;

  try {
    return await db.transaction(async (tx): Promise<UpdatePlatformStaffResult> => {
      await lockStaffMutations(tx);
      const target = await loadTarget(tx, userId);
      if (!target) return { ok: false, error: NOT_FOUND };
      if (target.archivedAt) {
        return { ok: false, error: { code: "archived", message: "Restore this account before editing it." } };
      }

      const isSelf = userId === actorContext.userId;
      const roleChanged = target.role !== role;
      const emailChanged = target.email !== email;
      const nameChanged = (target.fullName ?? "") !== fullName;

      if (isSelf && roleChanged) {
        return { ok: false, error: { code: "self_action", message: "You can't change your own role." } };
      }
      if (isSelf && emailChanged) {
        return {
          ok: false,
          error: { code: "self_action", message: "Change your own email from Account settings, where it is verified." },
        };
      }
      if (!roleChanged && !emailChanged && !nameChanged) return { ok: true, sessionsRevoked: 0 };

      if (roleChanged && target.role === "platform_owner") {
        if ((await countActiveOwnersExcluding(tx, userId)) === 0) return { ok: false, error: LAST_OWNER };
      }

      if (emailChanged) {
        const [taken] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, email), ne(users.id, userId)))
          .limit(1);
        if (taken) return { ok: false, error: EMAIL_TAKEN };
        const now = new Date();
        await tx.update(users).set({ email, updatedAt: now }).where(eq(users.id, userId));
        await tx
          .update(passwordResetTokens)
          .set({ usedAt: now })
          .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
        await tx
          .update(emailChangeTokens)
          .set({ usedAt: now })
          .where(and(eq(emailChangeTokens.userId, userId), isNull(emailChangeTokens.usedAt)));
      }

      await tx
        .update(platformMemberships)
        .set({ fullName, role: role as PlatformRole, updatedAt: new Date() })
        .where(eq(platformMemberships.userId, userId));

      if (nameChanged || emailChanged) {
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: actorContext.platformRole,
            action: "updatePlatformStaff",
            entityType: "platform_membership",
            entityId: userId,
            before: { fullName: target.fullName, email: target.email },
            after: { fullName, email },
          },
          tx,
        );
      }

      let sessionsRevoked = 0;
      if (roleChanged) {
        const grantsRevoked = await revokeAllGrantsTx(tx, userId);
        sessionsRevoked = await revokeSessionsTx(tx, userId);
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: actorContext.platformRole,
            action: "changePlatformStaffRole",
            entityType: "platform_membership",
            entityId: userId,
            before: { role: target.role, grants: grantsRevoked },
            after: { role },
            context: { sessionsRevoked },
          },
          tx,
        );
      }

      return { ok: true, sessionsRevoked };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") return { ok: false, error: EMAIL_TAKEN };
    throw err;
  }
}

// ─── Archive / restore ───────────────────────────────────────────────────

const reasonSchema = z.string().trim().max(500, "Reason must be 500 characters or fewer.").optional();

export type ArchivePlatformStaffResult = StaffResult<{ sessionsRevoked: number; signInDisabled: boolean }>;

/**
 * Archives a staff account without deleting anything:
 *  - platform_memberships.archived_at is set, so the membership grants no
 *    platform role anywhere (lib/auth/auth-context.ts);
 *  - every live session is revoked in the same transaction;
 *  - admin grants are revoked (recorded in the audit row) so a restore
 *    starts from no grants;
 *  - users.status becomes "disabled", which blocks sign-in and rejects any
 *    session — UNLESS the same user also holds an active academy
 *    membership (academy createStaff reuses existing users by email). In
 *    that case only platform access is removed: disabling the user row
 *    would also cut off their academy job, which is outside platform staff
 *    management. The result's signInDisabled says which happened.
 * Refuses the actor's own account and the last active Platform Owner.
 */
export async function archivePlatformStaff(
  actorContext: AuthContext,
  input: { userId: string; reason?: string },
): Promise<ArchivePlatformStaffResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsedId = userIdSchema.safeParse(input.userId);
  if (!parsedId.success) return { ok: false, error: validationError(parsedId.error.issues) };
  const parsedReason = reasonSchema.safeParse(input.reason);
  if (!parsedReason.success) return { ok: false, error: validationError(parsedReason.error.issues) };
  const userId = parsedId.data;
  const reason = parsedReason.data || undefined;

  if (userId === actorContext.userId) {
    return { ok: false, error: { code: "self_action", message: "You can't archive your own account." } };
  }

  return db.transaction(async (tx): Promise<ArchivePlatformStaffResult> => {
    await lockStaffMutations(tx);
    const target = await loadTarget(tx, userId);
    if (!target) return { ok: false, error: NOT_FOUND };
    if (target.archivedAt) {
      return { ok: false, error: { code: "archived", message: "This account is already archived." } };
    }
    if (target.role === "platform_owner" && (await countActiveOwnersExcluding(tx, userId)) === 0) {
      return { ok: false, error: LAST_OWNER };
    }

    const now = new Date();
    await tx
      .update(platformMemberships)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(platformMemberships.userId, userId));

    const [academyAccess] = await tx
      .select({ id: academyMemberships.id })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, userId), eq(academyMemberships.status, "active")))
      .limit(1);
    const signInDisabled = !academyAccess;
    if (signInDisabled) {
      await tx.update(users).set({ status: "disabled", updatedAt: now }).where(eq(users.id, userId));
    }

    const grantsRevoked = await revokeAllGrantsTx(tx, userId);
    const sessionsRevoked = await revokeSessionsTx(tx, userId);

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "archivePlatformStaff",
        entityType: "platform_membership",
        entityId: userId,
        before: { role: target.role, status: target.status, grants: grantsRevoked },
        after: { archived: true, status: signInDisabled ? "disabled" : target.status },
        context: { sessionsRevoked, signInDisabled },
        reason,
      },
      tx,
    );

    return { ok: true, sessionsRevoked, signInDisabled };
  });
}

export type RestorePlatformStaffResult = StaffResult;

/**
 * Restores an archived account with the role it had. Access returns only
 * through a fresh sign-in (archiving revoked every session); a restored
 * Platform Owner still has to pass MFA. Grants are not restored.
 */
export async function restorePlatformStaff(
  actorContext: AuthContext,
  input: { userId: string },
): Promise<RestorePlatformStaffResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsedId = userIdSchema.safeParse(input.userId);
  if (!parsedId.success) return { ok: false, error: validationError(parsedId.error.issues) };
  const userId = parsedId.data;

  return db.transaction(async (tx): Promise<RestorePlatformStaffResult> => {
    await lockStaffMutations(tx);
    const target = await loadTarget(tx, userId);
    if (!target) return { ok: false, error: NOT_FOUND };
    if (!target.archivedAt) {
      return { ok: false, error: { code: "not_archived", message: "This account is not archived." } };
    }

    const now = new Date();
    await tx
      .update(platformMemberships)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(platformMemberships.userId, userId));
    await tx
      .update(users)
      .set({ status: "active", failedLoginAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, userId));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "restorePlatformStaff",
        entityType: "platform_membership",
        entityId: userId,
        before: { archived: true, status: target.status },
        after: { archived: false, status: "active", role: target.role },
      },
      tx,
    );
    return { ok: true };
  });
}

// ─── Permanent delete ────────────────────────────────────────────────────

/**
 * Whether an archived account has any history that permanent deletion
 * would erase or orphan: it has signed in (sessions = login history), it
 * has acted (audit rows name it as actor — audit_logs.actor_user_id is a
 * real FK and audit history is never deleted), or it holds any academy
 * membership. Every other business table referencing users.id is covered
 * by its FK: the delete below fails and nothing is removed.
 */
async function hasHistory(tx: Tx, userId: string, lastLoginAt: Date | null): Promise<boolean> {
  if (lastLoginAt) return true;
  const [row] = await tx.execute<{ has_history: boolean }>(sql`
    select (
      exists (select 1 from ${sessions} where ${sessions.userId} = ${userId})
      or exists (select 1 from ${auditLogs} where ${auditLogs.actorUserId} = ${userId})
      or exists (select 1 from ${academyMemberships} where ${academyMemberships.userId} = ${userId})
    ) as has_history
  `).then((result) => result.rows);
  return Boolean(row?.has_history);
}

const HAS_HISTORY: StaffActionError = {
  code: "has_history",
  message: "This account has sign-in or activity history, so it stays archived instead of being deleted.",
};

export type DeletePlatformStaffResult = StaffResult;

/**
 * Permanently deletes an archived staff account that has no history. Only
 * the account's own credentials are removed (user row, membership, grants,
 * unused reset/email-change/MFA rows). Audit rows about the account are
 * kept: they reference it by entity_id (no FK), and this delete writes one
 * more. If any FK still references the user, the whole transaction rolls
 * back and the account stays archived.
 */
export async function deletePlatformStaffPermanently(
  actorContext: AuthContext,
  input: { userId: string; confirmEmail: string },
): Promise<DeletePlatformStaffResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsedId = userIdSchema.safeParse(input.userId);
  if (!parsedId.success) return { ok: false, error: validationError(parsedId.error.issues) };
  const userId = parsedId.data;

  if (userId === actorContext.userId) {
    return { ok: false, error: { code: "self_action", message: "You can't delete your own account." } };
  }

  try {
    return await db.transaction(async (tx): Promise<DeletePlatformStaffResult> => {
      await lockStaffMutations(tx);
      const target = await loadTarget(tx, userId);
      if (!target) return { ok: false, error: NOT_FOUND };
      if (!target.archivedAt) {
        return { ok: false, error: { code: "not_archived", message: "Archive this account before deleting it." } };
      }
      // Typed confirmation, checked server-side so a stray call can't skip it.
      if (input.confirmEmail.trim().toLowerCase() !== target.email) {
        return { ok: false, error: { code: "validation", message: "Type the account's email exactly to confirm." } };
      }
      if (await hasHistory(tx, userId, target.lastLoginAt)) return { ok: false, error: HAS_HISTORY };

      await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      await tx.delete(emailChangeTokens).where(eq(emailChangeTokens.userId, userId));
      await tx.delete(mfaEmailOtps).where(eq(mfaEmailOtps.userId, userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      await tx.delete(mfaTotpCredentials).where(eq(mfaTotpCredentials.userId, userId));
      await tx.delete(platformAdminPermissions).where(eq(platformAdminPermissions.userId, userId));
      await tx.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: actorContext.platformRole,
          action: "deletePlatformStaff",
          entityType: "platform_membership",
          entityId: userId,
          before: { email: target.email, fullName: target.fullName, role: target.role },
        },
        tx,
      );
      return { ok: true };
    });
  } catch (err) {
    // 23503 foreign_key_violation: some business record still points at
    // this user. The transaction rolled back; nothing was deleted.
    if (pgErrorCode(err) === "23503") return { ok: false, error: HAS_HISTORY };
    throw err;
  }
}

// ─── Grants ──────────────────────────────────────────────────────────────

export type GrantPlatformPermissionResult =
  | { ok: true }
  | { ok: false; error: StaffActionError };

/**
 * Grants a single capability to an active platform_admin account.
 *
 * Defense in depth (PLAN.md Item 31's "ungrantable-capability denial
 * test"): hasPermission() already ignores a platform_admin_permissions row
 * for an ungrantable capability even if one exists (lib/auth/
 * permissions.test.ts), but this action must refuse to ever WRITE such a
 * row in the first place — never rely solely on hasPermission() ignoring
 * bad data at read time.
 */
export async function grantPlatformPermission(
  actorContext: AuthContext,
  targetUserId: string,
  capability: string,
): Promise<GrantPlatformPermissionResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsedTargetUserId = userIdSchema.safeParse(targetUserId);
  if (!parsedTargetUserId.success) {
    return { ok: false, error: validationError(parsedTargetUserId.error.issues) };
  }

  if (UNGRANTABLE_CAPABILITIES.has(capability) || !isGrantableCapability(capability)) {
    return {
      ok: false,
      error: {
        code: "ungrantable",
        message: `"${capability}" can never be granted to a platform_admin — owner only.`,
      },
    };
  }

  // A left join against users (not a bare select from platformMemberships)
  // so a user who exists but has no platform membership row at all (e.g. an
  // academy-only user) is distinguished from a targetUserId that isn't a
  // real user — the former is target_not_platform_admin, the latter is
  // target_not_found.
  const [target] = await db
    .select({ role: platformMemberships.role, archivedAt: platformMemberships.archivedAt })
    .from(users)
    .leftJoin(platformMemberships, eq(platformMemberships.userId, users.id))
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target) {
    return {
      ok: false,
      error: { code: "target_not_found", message: "Account not found." },
    };
  }
  if (target.role !== "platform_admin") {
    return {
      ok: false,
      error: {
        code: "target_not_platform_admin",
        message: "Permissions can only be granted to platform_admin accounts.",
      },
    };
  }
  if (target.archivedAt) {
    return {
      ok: false,
      error: { code: "archived", message: "Restore this account before granting permissions." },
    };
  }

  const [granted] = await db
    .insert(platformAdminPermissions)
    .values({ userId: targetUserId, capability })
    .onConflictDoNothing()
    .returning({ userId: platformAdminPermissions.userId });

  // Only write an audit row when a row was actually inserted — if the
  // capability was already granted, onConflictDoNothing() skipped the
  // insert and this is a no-op that must not be logged as a fresh grant.
  if (granted) {
    await recordAudit({
      actorUserId: actorContext.userId,
      actorRole: actorContext.platformRole,
      action: "grantPlatformPermission",
      entityType: "platform_admin_permission",
      entityId: targetUserId,
      after: { capability },
    });
  }

  return { ok: true };
}

export type RevokePlatformPermissionResult =
  | { ok: true }
  | { ok: false; error: StaffActionError };

export async function revokePlatformPermission(
  actorContext: AuthContext,
  targetUserId: string,
  capability: string,
): Promise<RevokePlatformPermissionResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsedTargetUserId = userIdSchema.safeParse(targetUserId);
  if (!parsedTargetUserId.success) {
    return { ok: false, error: validationError(parsedTargetUserId.error.issues) };
  }

  const [revoked] = await db
    .delete(platformAdminPermissions)
    .where(
      and(
        eq(platformAdminPermissions.userId, targetUserId),
        eq(platformAdminPermissions.capability, capability),
      ),
    )
    .returning({ userId: platformAdminPermissions.userId });

  // Only write an audit row when a row was actually deleted — revoking a
  // capability that was never granted is a no-op and must not be logged as
  // a real revocation.
  if (revoked) {
    await recordAudit({
      actorUserId: actorContext.userId,
      actorRole: actorContext.platformRole,
      action: "revokePlatformPermission",
      entityType: "platform_admin_permission",
      entityId: targetUserId,
      before: { capability },
    });
  }

  return { ok: true };
}

// ─── List ────────────────────────────────────────────────────────────────

export interface PlatformStaffAccount {
  userId: string;
  email: string;
  fullName: string | null;
  role: PlatformRole;
  /** users.status — "disabled" blocks sign-in entirely. */
  status: "active" | "disabled";
  archivedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  grantedCapabilities: string[];
  /** Archived and without history (see hasHistory) — the UI's hint only; the server re-checks. */
  canPermanentlyDelete: boolean;
}

/**
 * Lists every platform staff account (active and archived) plus each
 * admin's granted capabilities. Never selects password hashes, MFA data or
 * session tokens. Callers must already have checked
 * hasPermission(context, "platform.staff.manage") themselves — this helper
 * does not re-check, matching how e.g. app/protected/page.tsx gates the
 * page once rather than in every helper it calls.
 */
export async function listPlatformStaff(): Promise<PlatformStaffAccount[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      fullName: platformMemberships.fullName,
      role: platformMemberships.role,
      status: users.status,
      archivedAt: platformMemberships.archivedAt,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      hasHistory: sql<boolean>`(
        ${users.lastLoginAt} is not null
        or exists (select 1 from ${sessions} where ${sessions.userId} = ${users.id})
        or exists (select 1 from ${auditLogs} where ${auditLogs.actorUserId} = ${users.id})
        or exists (select 1 from ${academyMemberships} where ${academyMemberships.userId} = ${users.id})
      )`,
    })
    .from(platformMemberships)
    .innerJoin(users, eq(users.id, platformMemberships.userId))
    .orderBy(asc(users.createdAt));

  const grants = await db
    .select({
      userId: platformAdminPermissions.userId,
      capability: platformAdminPermissions.capability,
    })
    .from(platformAdminPermissions);

  const grantsByUser = new Map<string, string[]>();
  for (const grant of grants) {
    const list = grantsByUser.get(grant.userId) ?? [];
    list.push(grant.capability);
    grantsByUser.set(grant.userId, list);
  }

  return rows.map(({ hasHistory: history, ...row }) => ({
    ...row,
    grantedCapabilities: grantsByUser.get(row.userId) ?? [],
    canPermanentlyDelete: row.archivedAt !== null && !history,
  }));
}
