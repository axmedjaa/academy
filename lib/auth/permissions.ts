import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformAdminPermissions } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Every capability in this set always requires platform_owner, no matter
 * what a platform_admin has been granted — enforced here, not by policy
 * convention (PLAN.md Cross-Cutting Architecture Decisions). The set's
 * membership is the authoritative rule, not its size — never summarize
 * this as a count anywhere (PLAN.md's own instruction, restated here).
 *
 * plans.manage / platform.revenue.view / platform.staff.manage /
 * platform.settings.manage are named capability identifiers; the rest are
 * the literal server-action names PLAN.md itself uses for these actions
 * (Phase 1, not yet built) — using the same names now means those actions
 * won't need a different capability identifier when they're implemented.
 *
 * `platform.settings.manage` (Phase 5, Item 61b, `/platform/settings`):
 * PLAN.md's Master Permission Matrix closes the grantable-capability list
 * to exactly three entries (`recordSubscriptionPayment`, `queryAuditLogs`,
 * `getPlatformReports` — see lib/platform-staff/capabilities.ts's
 * `GRANTABLE_CAPABILITIES`); global platform feature switches are not among
 * them, and DESIGN.md's `/platform/settings` row gives no role breakdown at
 * all (unlike `/platform/staff`/`/platform/plans`/the revenue view, each of
 * which spells out "owner only" explicitly). Rather than leaving that
 * silent and letting `hasPermission` fall through to "any capability string
 * a platform_admin happens to have a grant row for" (which nothing in this
 * codebase can currently produce for this capability anyway, since it's not
 * in `GRANTABLE_CAPABILITIES`), this is an explicit judgment call: treat it
 * the same as this codebase's other platform-wide, no-scope levers (plan
 * pricing, staff/grant management) and require `platform_owner`. Flagged
 * here as a genuine PLAN.md/DESIGN.md gap, not a discovered rule — worth
 * confirming against a future, more explicit spec update.
 */
export const UNGRANTABLE_CAPABILITIES = new Set([
  "plans.manage",
  "platform.revenue.view",
  "platform.staff.manage",
  "platform.settings.manage",
  "registerAcademy",
  "approveAcademy",
  "activateAcademy",
  "suspendAcademy",
  "reactivateAcademy",
  "cancelAcademy",
  "closeAcademy",
  "deleteAcademy",
  "renewSubscription",
  "verifySubscriptionPayment",
  "rejectSubscriptionPayment",
  "reverseSubscriptionPayment",
]);

async function hasGrantedPlatformPermission(
  userId: string,
  capability: string,
): Promise<boolean> {
  const [grant] = await db
    .select({ id: platformAdminPermissions.id })
    .from(platformAdminPermissions)
    .where(
      and(
        eq(platformAdminPermissions.userId, userId),
        eq(platformAdminPermissions.capability, capability),
      ),
    )
    .limit(1);

  return grant !== undefined;
}

/**
 * The single path to authorization (PLAN.md: "A single hasPermission(context,
 * capability, resource?) function is the only path to authorization").
 *
 * `resource` has no use yet — academy-level, resource-scoped checks (e.g. a
 * branch-limited role acting on a specific branchId) can't exist until
 * academy_memberships is built (Phase 1+); the parameter is kept in the
 * signature now so call sites don't need to change shape later.
 */
export async function hasPermission(
  context: AuthContext | null,
  capability: string,
  resource?: unknown,
): Promise<boolean> {
  void resource;

  if (!context) return false;

  if (UNGRANTABLE_CAPABILITIES.has(capability)) {
    return context.platformRole === "platform_owner";
  }

  if (context.platformRole === "platform_owner") {
    return true;
  }

  if (context.platformRole === "platform_admin") {
    return hasGrantedPlatformPermission(context.userId, capability);
  }

  // Academy-level role -> capability map doesn't exist yet (no
  // academy_memberships until Phase 1) — added when that phase's roles
  // and actions are built.
  return false;
}
