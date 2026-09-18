import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { notificationPreferences } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  MANDATORY_NOTIFICATION_TEMPLATE_IDS,
  NOTIFICATION_TEMPLATE_IDS,
  type NotificationTemplateId,
} from "@/lib/notifications/templates";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 5, Item 59 — notification-preference storage + read/write
 * functions. DESIGN.md §9.8/§9.11: "optional event types get a normal
 * toggle; mandatory ones... render as a disabled, always-on toggle." This
 * file is the storage-and-validation half of that; the toggle UI itself
 * lives in app/academy/settings/notification-preferences-section.tsx.
 *
 * ---------------------------------------------------------------------
 * Scoping: per-user-per-academy (see lib/db/schema.ts's
 * `notificationPreferences` module comment for the full judgment-call
 * writeup — DESIGN.md places the toggle UI inside the academy-scoped
 * `/academy/settings` screen, and a user can belong to more than one
 * academy, so a pure per-user-global row would be the wrong shape).
 * `academyId` here is always the caller's OWN resolved academy — never a
 * client-supplied value trusted at face value — resolved via
 * `checkAcademyAccessForContext` exactly like every other `/academy/*`
 * action in this codebase (see lib/academies/settings.ts's own comment on
 * why this re-check happens per-action rather than being threaded down
 * from the layout).
 *
 * ---------------------------------------------------------------------
 * Mandatory-template enforcement: application layer, not a DB constraint
 * ---------------------------------------------------------------------
 * Per this item's own brief: "a mandatory template must never actually be
 * stored as disabled — enforce this at the application layer... not a DB
 * constraint, since DB-level enum-conditional checks are awkward in
 * Postgres and the check only needs to hold for writes this codebase
 * itself performs." `setNotificationPreference` below is this table's ONLY
 * write path in this codebase, so gating it here is sufficient — a Postgres
 * CHECK constraint referencing `MANDATORY_NOTIFICATION_TEMPLATE_IDS`
 * (a TypeScript `Set`, not a DB-visible value) would need that set
 * duplicated into SQL and kept in sync by hand, which is exactly the
 * "awkward, unnecessary for a single-writer table" tradeoff this item
 * calls out.
 *
 * ---------------------------------------------------------------------
 * Known gap, explicitly out of scope for this item (per task brief)
 * ---------------------------------------------------------------------
 * `enqueueNotification` (lib/notifications/notifications.ts) does not
 * consult this table at all yet — every event is still enqueued
 * unconditionally regardless of what's stored here (that module's own
 * comment already says as much). Wiring that check in is a follow-up for a
 * later wave: two other agents are actively extending
 * `enqueueNotification` in this same wave for trigger-point wiring, and
 * changing its core logic now would race with that work. This file only
 * builds the storage + read/write surface; a row's mere existence has no
 * runtime effect on delivery yet.
 */

export interface NotificationPreferenceActionError {
  code: "forbidden" | "validation" | "blocked" | "mandatory_template";
  message: string;
}

const FORBIDDEN: NotificationPreferenceActionError = {
  code: "forbidden",
  message: "You don't have access to this academy's notification preferences.",
};

const MANDATORY_TEMPLATE_ERROR: NotificationPreferenceActionError = {
  code: "mandatory_template",
  message: "This notification is required and cannot be turned off.",
};

interface ResolvedPreferencesAccess {
  academyId: string;
}

type ResolvePreferencesAccessResult =
  | { ok: true; access: ResolvedPreferencesAccess }
  | { ok: false; error: NotificationPreferenceActionError };

/**
 * Resolves the caller's own academy via the same access-gate every other
 * `/academy/*` action uses, then requires the caller-supplied `academyId`
 * to match it exactly — never trusting the parameter on its own. A
 * mismatch (a guessed/foreign academyId) collapses into the identical
 * `FORBIDDEN` response as "no access at all", so this never confirms or
 * denies whether the guessed id even exists (same IDOR-safe posture as
 * `checkAcademyAccessForContext`'s own "not_a_member" branch).
 */
async function resolvePreferencesAccess(
  actorContext: AuthContext,
  academyId: string,
): Promise<ResolvePreferencesAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  if (access.academyId !== academyId) {
    return { ok: false, error: FORBIDDEN };
  }
  return { ok: true, access: { academyId: access.academyId } };
}

export interface NotificationPreferenceView {
  templateId: NotificationTemplateId;
  enabled: boolean;
  mandatory: boolean;
}

export type GetNotificationPreferencesResult =
  | { ok: true; preferences: NotificationPreferenceView[] }
  | { ok: false; error: NotificationPreferenceActionError };

/**
 * Every template id in `NOTIFICATION_TEMPLATE_IDS`, in that fixed order,
 * with its current enabled/disabled state — defaulting to enabled when no
 * row exists for (user, academy, template), per this item's own "a row's
 * absence means using the default" rule — and whether it's mandatory (from
 * `MANDATORY_NOTIFICATION_TEMPLATE_IDS`), so the settings UI can render a
 * disabled always-on toggle for those without a second lookup.
 */
export async function getNotificationPreferences(
  actorContext: AuthContext,
  academyId: string,
): Promise<GetNotificationPreferencesResult> {
  const resolved = await resolvePreferencesAccess(actorContext, academyId);
  if (!resolved.ok) return resolved;

  const rows = await db
    .select({
      templateId: notificationPreferences.templateId,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, actorContext.userId),
        eq(notificationPreferences.academyId, resolved.access.academyId),
      ),
    );

  const enabledByTemplate = new Map(rows.map((row) => [row.templateId, row.enabled]));

  const preferences: NotificationPreferenceView[] = NOTIFICATION_TEMPLATE_IDS.map((templateId) => ({
    templateId,
    enabled: enabledByTemplate.get(templateId) ?? true,
    mandatory: MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(templateId),
  }));

  return { ok: true, preferences };
}

const setNotificationPreferenceInputSchema = z.object({
  templateId: z.enum(NOTIFICATION_TEMPLATE_IDS),
  enabled: z.boolean(),
});

export type SetNotificationPreferenceResult =
  | { ok: true; preference: NotificationPreferenceView }
  | { ok: false; error: NotificationPreferenceActionError };

/**
 * Upserts a `notification_preferences` row for (caller, academy, template).
 * Rejects `enabled: false` on a mandatory template id with the clean
 * `mandatory_template` validation error described in this file's module
 * comment — checked BEFORE the upsert runs, so a mandatory template is
 * never even briefly written as disabled.
 *
 * `onConflictDoUpdate` targets the exact three columns the
 * `notification_preferences_user_academy_template_unique` constraint
 * covers (see lib/db/schema.ts's `notificationPreferences` table) — the
 * `academyId` value here is always the caller's own concrete (non-null)
 * academy id (never the platform-level null case, which no `/academy/*`
 * caller can reach through this function), so ordinary equality-based
 * conflict matching applies.
 */
export async function setNotificationPreference(
  actorContext: AuthContext,
  academyId: string,
  templateId: string,
  enabled: boolean,
): Promise<SetNotificationPreferenceResult> {
  const resolved = await resolvePreferencesAccess(actorContext, academyId);
  if (!resolved.ok) return resolved;

  const parsed = setNotificationPreferenceInputSchema.safeParse({ templateId, enabled });
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }

  if (!parsed.data.enabled && MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(parsed.data.templateId)) {
    return { ok: false, error: MANDATORY_TEMPLATE_ERROR };
  }

  const [row] = await db
    .insert(notificationPreferences)
    .values({
      userId: actorContext.userId,
      academyId: resolved.access.academyId,
      templateId: parsed.data.templateId,
      enabled: parsed.data.enabled,
    })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.userId,
        notificationPreferences.academyId,
        notificationPreferences.templateId,
      ],
      set: { enabled: parsed.data.enabled, updatedAt: new Date() },
    })
    .returning({ templateId: notificationPreferences.templateId, enabled: notificationPreferences.enabled });

  return {
    ok: true,
    preference: {
      templateId: row.templateId as NotificationTemplateId,
      enabled: row.enabled,
      mandatory: MANDATORY_NOTIFICATION_TEMPLATE_IDS.has(row.templateId as NotificationTemplateId),
    },
  };
}
