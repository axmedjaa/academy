import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  academyUsage,
  subscriptionPlans,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_SETTINGS_ACTION,
  getAcademyPermissionLevel,
  hasAcademyPermission,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 2, Item 41 — "`updateAcademySettings` (expanded fields,
 * direct edit — no approval step), `getOwnAcademyUsage`" at `/academy/settings`.
 *
 * Both actions below resolve "which academy, with what role" via
 * `checkAcademyAccessForContext` (lib/academies/access-gate.ts, Item 27) —
 * never a client-supplied `academyId`, per that file's own IDOR-safe
 * design and the task brief's explicit instruction not to duplicate it.
 * `app/academy/layout.tsx` already ran this same check once to decide
 * whether to render this page's route at all; calling it again here is the
 * documented tradeoff from that layout's own comment ("a future page that
 * needs academyId or membershipRole for its own queries will have to
 * resolve that itself... via a fresh checkAcademyAccess call") — Next.js
 * layouts have no channel for passing resolved data down to pages other
 * than props/params, and access-gate.ts is out of scope to change.
 *
 * "grace" (Past Due, within the 7-day window) is treated as fully
 * functional here, matching the layout's own rendering rule (DESIGN.md
 * §11.1: "Full, with a persistent banner") — only "blocked" refuses the
 * action.
 */

export interface AcademySettingsActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked";
  message: string;
}

const FORBIDDEN: AcademySettingsActionError = {
  code: "forbidden",
  message: "You don't have permission to view or edit this academy's settings.",
};

// Same "blank string -> undefined, not stored as empty text" convention as
// lib/academies/register.ts's optionalText helper — duplicated rather than
// imported/exported from register.ts, which belongs to a different item
// and is not in this item's file list to modify.
function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

/**
 * DESIGN.md §9.11 "Academy Profile": "Full field set (name, type, address,
 * phone, email, website, logo, registration number, primary contact).
 * Saves directly — no approval step, no 'pending change' state." That
 * field list — matched exactly against lib/db/schema.ts's `academies`
 * columns — deliberately excludes two columns this item's brief says
 * already exist on the table:
 *   - `slug`: a URL/identity-bearing column (unique-indexed, referenced
 *     nowhere in DESIGN.md's editable field list) — treated as immutable
 *     post-registration, same posture as `defaultCurrency` below.
 *   - `defaultCurrency`: not named in DESIGN.md §9.11's field set either,
 *     and changing an academy's currency after it has any financial
 *     activity (Phase 2+ student payments, Phase 1 subscription payments)
 *     would silently mis-denominate historical records — nothing in
 *     PLAN.md names a currency-change action anywhere, so this is treated
 *     as fixed at registration.
 * Both are judgment calls (DESIGN.md doesn't say "immutable" in so many
 * words, it simply never lists them as editable), documented here rather
 * than silently omitted.
 */
export const updateAcademySettingsSchema = z.object({
  name: z.string().trim().min(1, "Academy name is required").max(200),
  type: optionalText(100),
  address: optionalText(500),
  phone: optionalText(50),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid academy email address",
    }),
  website: optionalText(300),
  logoRef: optionalText(500),
  registrationNumber: optionalText(100),
  primaryContactName: optionalText(200),
  primaryContactPhone: optionalText(50),
});

export type UpdateAcademySettingsInput = z.input<typeof updateAcademySettingsSchema>;

export interface AcademySettingsRecord {
  id: string;
  name: string;
  slug: string;
  defaultCurrency: string;
  type: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoRef: string | null;
  registrationNumber: string | null;
  primaryContactName: string | null;
  primaryContactPhone: string | null;
}

function toRecord(row: typeof academies.$inferSelect): AcademySettingsRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultCurrency: row.defaultCurrency,
    type: row.type,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    logoRef: row.logoRef,
    registrationNumber: row.registrationNumber,
    primaryContactName: row.primaryContactName,
    primaryContactPhone: row.primaryContactPhone,
  };
}

export type UpdateAcademySettingsResult =
  | { ok: true; academy: AcademySettingsRecord }
  | { ok: false; error: AcademySettingsActionError };

export type GetAcademySettingsResult =
  | { ok: true; academy: AcademySettingsRecord; permissionLevel: string }
  | { ok: false; error: AcademySettingsActionError };

/**
 * Not one of the two actions PLAN.md names for this item, but a small
 * addition this item's own page needs: `/academy/settings` has to render
 * the current field values in the edit form, which requires a read path.
 * Gated identically to `updateAcademySettings` (same `academy.settings`
 * row) rather than left ungated, since "can view the settings screen at
 * all" and "can edit it" are the same permission for every role that has
 * either (see the `manager`/"View/Edit" comment in
 * lib/auth/academy-permissions.ts). Also returns the resolved
 * `AcademyPermissionLevel` (as a string) so the page/form can decide
 * whether to render Save as enabled without a second permission call.
 */
export async function getAcademySettings(
  actorContext: AuthContext,
): Promise<GetAcademySettingsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  const permissionLevel = getAcademyPermissionLevel(
    access.membershipRole,
    ACADEMY_SETTINGS_ACTION,
  );
  if (permissionLevel === "none") {
    return { ok: false, error: FORBIDDEN };
  }

  const [existing] = await db
    .select()
    .from(academies)
    .where(eq(academies.id, access.academyId))
    .limit(1);

  if (!existing) {
    return { ok: false, error: { code: "not_found", message: "Academy not found." } };
  }

  return { ok: true, academy: toRecord(existing), permissionLevel };
}

/**
 * PLAN.md §4: `updateAcademySettings` — "expanded fields, direct edit, no
 * approval step" (Decision #14 per DESIGN.md §9.11). Gated by the new
 * `academy.settings` row (lib/auth/academy-permissions.ts): Owner/Admin
 * `Full`, Manager `View/Edit` may both submit; every other role is
 * refused, matching the Master Permission Matrix's `—` cells.
 *
 * Full-object update (every field resubmitted), same convention as
 * lib/subscriptions/plans.ts's updateSubscriptionPlan — DESIGN.md §9.11
 * describes one profile form, not per-field PATCH semantics.
 */
export async function updateAcademySettings(
  actorContext: AuthContext,
  input: UpdateAcademySettingsInput,
): Promise<UpdateAcademySettingsResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  if (!hasAcademyPermission(access.membershipRole, ACADEMY_SETTINGS_ACTION)) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = updateAcademySettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(academies)
      .where(eq(academies.id, access.academyId))
      .limit(1);

    // Defensive/unreachable in practice: checkAcademyAccessForContext just
    // resolved this exact academyId from an active membership + a real
    // academies row (its own closure check reads from the same table).
    // Never trust a prior lookup to short-circuit this one, same posture
    // as access-gate.ts's own "academy not found" defensive branch.
    if (!existing) {
      return null;
    }

    const [updated] = await tx
      .update(academies)
      .set({
        name: data.name,
        type: data.type,
        address: data.address,
        phone: data.phone,
        email: data.email,
        website: data.website,
        logoRef: data.logoRef,
        registrationNumber: data.registrationNumber,
        primaryContactName: data.primaryContactName,
        primaryContactPhone: data.primaryContactPhone,
      })
      .where(eq(academies.id, access.academyId))
      .returning();

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "a sensitive mutation cannot succeed if its audit write fails").
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: access.membershipRole,
        academyId: access.academyId,
        action: "updateAcademySettings",
        entityType: "academy",
        entityId: access.academyId,
        before: toRecord(existing),
        after: data,
      },
      tx,
    );

    return updated;
  });

  if (!result) {
    return { ok: false, error: { code: "not_found", message: "Academy not found." } };
  }

  return { ok: true, academy: toRecord(result) };
}

export interface OwnAcademyUsageMetrics {
  activeStudentsCount: number;
  activeStaffCount: number;
  branchCount: number;
  courseCount: number;
  storageUsedBytes: number;
  calculatedAt: Date;
}

export interface OwnAcademyUsageLimits {
  maxBranches: number;
  maxStudents: number;
  maxStaff: number;
  maxCourses: number;
  maxStorageBytes: number;
}

export type GetOwnAcademyUsageResult =
  | {
      ok: true;
      academyId: string;
      planName: string | null;
      /** `null` when `recalculateUsage` (lib/subscriptions/usage.ts, Item 29)
       * has never run for this academy yet — no snapshot row exists. */
      usage: OwnAcademyUsageMetrics | null;
      /** `null` when the academy has no subscription/plan to compare against
       * (shouldn't happen for anything past `checkAcademyAccessForContext`'s
       * "full"/"grace" gate, which already requires a subscription row, but
       * kept nullable defensively rather than assumed). */
      limits: OwnAcademyUsageLimits | null;
    }
  | { ok: false; error: AcademySettingsActionError };

/**
 * PLAN.md §4: `getOwnAcademyUsage` — "a NEW, self-scoped read (the
 * caller's own academy only, never a client-supplied academyId)".
 *
 * DESIGN.md §9.11 places the "Usage" sub-section (usage-vs-allowance bars,
 * "own-academy view") directly inside the `/academy/settings` screen
 * alongside "Academy Profile" — the Master Permission Matrix has no
 * separate row for it. Judgment call, documented per the task brief: this
 * reuses the exact same `academy.settings` gate as
 * `updateAcademySettings` rather than inventing an ungated or
 * separately-gated read, since DESIGN.md bundles the widget into the one
 * screen that row already governs and no role gains settings-*view*
 * access without also being on that row (Owner/Admin/Manager only — the
 * same three roles PLAN.md's Phase 1 already granted "read-only view of
 * own academy profile" to, before this item existed).
 *
 * Queries `academy_usage`/`academy_subscriptions`/`subscription_plans`
 * directly, scoped to the one resolved `academyId`, rather than calling
 * lib/subscriptions/usage.ts's `listAcademyUsageOverview()` (an
 * all-academies platform-admin query) and filtering client-side — avoids
 * an unnecessary full-table scan across every academy on the platform for
 * a single-academy read. Mirrors that file's own "latest row per academy"
 * pattern (order by the relevant timestamp, limit 1) rather than
 * duplicating its exported logic, which is out of scope to modify.
 */
export async function getOwnAcademyUsage(
  actorContext: AuthContext,
): Promise<GetOwnAcademyUsageResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  if (!hasAcademyPermission(access.membershipRole, ACADEMY_SETTINGS_ACTION)) {
    return { ok: false, error: FORBIDDEN };
  }

  const [subscription] = await db
    .select({
      planName: subscriptionPlans.name,
      maxBranches: subscriptionPlans.maxBranches,
      maxStudents: subscriptionPlans.maxStudents,
      maxStaff: subscriptionPlans.maxStaff,
      maxCourses: subscriptionPlans.maxCourses,
      maxStorageBytes: subscriptionPlans.maxStorageBytes,
    })
    .from(academySubscriptions)
    .innerJoin(subscriptionPlans, eq(academySubscriptions.planId, subscriptionPlans.id))
    .where(eq(academySubscriptions.academyId, access.academyId))
    .orderBy(desc(academySubscriptions.startsAt))
    .limit(1);

  const [usageRow] = await db
    .select()
    .from(academyUsage)
    .where(eq(academyUsage.academyId, access.academyId))
    .orderBy(desc(academyUsage.calculatedAt))
    .limit(1);

  return {
    ok: true,
    academyId: access.academyId,
    planName: subscription?.planName ?? null,
    usage: usageRow
      ? {
          activeStudentsCount: usageRow.activeStudentsCount,
          activeStaffCount: usageRow.activeStaffCount,
          branchCount: usageRow.branchCount,
          courseCount: usageRow.courseCount,
          storageUsedBytes: usageRow.storageUsedBytes,
          calculatedAt: usageRow.calculatedAt,
        }
      : null,
    limits: subscription
      ? {
          maxBranches: subscription.maxBranches,
          maxStudents: subscription.maxStudents,
          maxStaff: subscription.maxStaff,
          maxCourses: subscription.maxCourses,
          maxStorageBytes: subscription.maxStorageBytes,
        }
      : null,
  };
}
