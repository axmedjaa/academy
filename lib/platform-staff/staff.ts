import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  platformAdminPermissions,
  platformMemberships,
  users,
} from "@/lib/db/schema";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import { isGrantableCapability } from "@/lib/platform-staff/capabilities";
import { z } from "zod";

// PLAN.md §4/§5, DESIGN.md §8: "platform.staff.manage covers creating/
// managing platform staff accounts and granting/revoking any platform
// permission... a platform_admin can never manage staff or grants,
// regardless of what else they've been granted." This is already in
// UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts) — hasPermission()
// returns true for this capability only for platform_owner.
const STAFF_MANAGE_CAPABILITY = "platform.staff.manage";

export interface StaffActionError {
  code:
    | "forbidden"
    | "validation"
    | "email_taken"
    | "target_not_found"
    | "target_not_platform_admin"
    | "ungrantable";
  message: string;
}

const FORBIDDEN: StaffActionError = {
  code: "forbidden",
  message: "You don't have permission to manage platform staff.",
};

async function requireStaffManagePermission(
  actorContext: AuthContext,
): Promise<StaffActionError | null> {
  const allowed = await hasPermission(actorContext, STAFF_MANAGE_CAPABILITY);
  return allowed ? null : FORBIDDEN;
}

const createAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: passwordSchema,
});

export type CreatePlatformAdminAccountResult =
  | { ok: true; userId: string }
  | { ok: false; error: StaffActionError };

/**
 * Creates a new platform_admin account. Platform_owner accounts are not
 * created through this flow — PLAN.md's "Seed & Demonstration Data" seeds
 * exactly one MFA-enrolled platform_owner (scripts/seed.ts); this is the
 * general "create any platform staff account" flow DESIGN.md §8 describes
 * for /platform/staff, and staff accounts are platform_admin by
 * definition (a second platform_owner isn't a scenario PLAN.md describes
 * anywhere).
 */
export async function createPlatformAdminAccount(
  actorContext: AuthContext,
  input: { email: string; password: string },
): Promise<CreatePlatformAdminAccountResult> {
  const forbidden = await requireStaffManagePermission(actorContext);
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = createAccountSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const { email, password } = parsed.data;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return {
      ok: false,
      error: {
        code: "email_taken",
        message: "An account with that email already exists.",
      },
    };
  }

  const passwordHash = await hashPassword(password);

  const userId = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id });

    await tx
      .insert(platformMemberships)
      .values({ userId: user.id, role: "platform_admin" });

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "a sensitive mutation cannot succeed if its audit write fails").
    // Never includes the password/hash — before/after are redacted by
    // recordAudit() regardless, but this also just never passes it in.
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        action: "createPlatformAdminAccount",
        entityType: "platform_membership",
        entityId: user.id,
        after: { email, role: "platform_admin" },
      },
      tx,
    );

    return user.id;
  });

  return { ok: true, userId };
}

export type GrantPlatformPermissionResult =
  | { ok: true }
  | { ok: false; error: StaffActionError };

/**
 * Grants a single capability to a platform_admin account.
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

  const parsedTargetUserId = z
    .string()
    .uuid("Enter a valid account id.")
    .safeParse(targetUserId);
  if (!parsedTargetUserId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedTargetUserId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
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
    .select({ role: platformMemberships.role })
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

  const parsedTargetUserId = z
    .string()
    .uuid("Enter a valid account id.")
    .safeParse(targetUserId);
  if (!parsedTargetUserId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedTargetUserId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
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

export interface PlatformStaffAccount {
  userId: string;
  email: string;
  role: "platform_owner" | "platform_admin";
  status: "active" | "disabled";
  grantedCapabilities: string[];
}

/**
 * Lists every platform_owner/platform_admin account plus each admin's
 * granted capabilities, for the /platform/staff account list. Callers must
 * already have checked hasPermission(context, "platform.staff.manage")
 * themselves — this helper does not re-check, matching how e.g.
 * app/protected/page.tsx gates the page once rather than in every helper
 * it calls.
 */
export async function listPlatformStaff(): Promise<PlatformStaffAccount[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: platformMemberships.role,
      status: users.status,
    })
    .from(platformMemberships)
    .innerJoin(users, eq(users.id, platformMemberships.userId));

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

  return rows.map((row) => ({
    ...row,
    grantedCapabilities: grantsByUser.get(row.userId) ?? [],
  }));
}
