import { eq } from "drizzle-orm";
import { db, type DbClient } from "@/lib/db";
import { platformWebsiteSettings, users } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  EMPTY_WEBSITE_SETTINGS,
  toPublicContact,
  websiteSettingsSchema,
  type PublicContactSettings,
  type WebsiteSettingsInput,
  type WebsiteSettingsValues,
} from "@/lib/marketing/website-settings-schema";

export {
  SOCIAL_NETWORKS,
  cleanText,
  hasPublicContact,
  toPublicContact,
  websiteSettingsSchema,
  type PublicContactSettings,
  type SocialKey,
  type WebsiteSettingsInput,
  type WebsiteSettingsValues,
} from "@/lib/marketing/website-settings-schema";

/**
 * Public website contact settings (Platform -> Website settings -> Contact
 * information). One platform-level row (`platform_website_settings`, a
 * singleton enforced by the database), outside every academy tenant.
 *
 * - Anyone can read the *public* projection (`getPublicContactSettings`):
 *   only the approved contact fields, never who changed them or when.
 * - Only `platform_owner` can read the editable record or change it
 *   (`platform.website.manage` is in lib/auth/permissions.ts's
 *   UNGRANTABLE_CAPABILITIES, so no admin grant can unlock it).
 * - Every change is Zod-validated here, on the server, and audited in the
 *   same transaction with before/after values.
 */

export const WEBSITE_SETTINGS_CAPABILITY = "platform.website.manage";

export interface WebsiteActionError {
  code: "forbidden" | "validation" | "not_found" | "rate_limited" | "unavailable";
  message: string;
  field?: string;
}

const FORBIDDEN: WebsiteActionError = {
  code: "forbidden",
  message: "Only the platform owner can manage website settings.",
};

export interface WebsiteSettingsRecord {
  values: WebsiteSettingsValues;
  updatedAt: Date | null;
  updatedByEmail: string | null;
}

type SettingsRow = typeof platformWebsiteSettings.$inferSelect;

function toValues(row: SettingsRow | undefined): WebsiteSettingsValues {
  if (!row) return { ...EMPTY_WEBSITE_SETTINGS };
  return {
    supportEmail: row.supportEmail,
    phone: row.phone,
    whatsappNumber: row.whatsappNumber,
    officeAddress: row.officeAddress,
    businessHours: row.businessHours,
    facebookUrl: row.facebookUrl,
    linkedinUrl: row.linkedinUrl,
    instagramUrl: row.instagramUrl,
    xUrl: row.xUrl,
    youtubeUrl: row.youtubeUrl,
    tiktokUrl: row.tiktokUrl,
    contactFormEnabled: row.contactFormEnabled,
  };
}

/** Public read: only the approved contact fields. Read fresh on every
 * request (the landing page is rendered per request), so a saved change is
 * live on the next page load without a redeploy. */
export async function getPublicContactSettings(executor: DbClient = db): Promise<PublicContactSettings> {
  const [row] = await executor.select().from(platformWebsiteSettings).where(eq(platformWebsiteSettings.id, true)).limit(1);
  return toPublicContact(toValues(row));
}

/** Owner read: the editable values plus who last changed them. */
export async function getWebsiteSettings(
  context: AuthContext,
): Promise<{ ok: true; settings: WebsiteSettingsRecord } | { ok: false; error: WebsiteActionError }> {
  if (!(await hasPermission(context, WEBSITE_SETTINGS_CAPABILITY))) {
    return { ok: false, error: FORBIDDEN };
  }
  const [row] = await db
    .select({ settings: platformWebsiteSettings, updatedByEmail: users.email })
    .from(platformWebsiteSettings)
    .leftJoin(users, eq(users.id, platformWebsiteSettings.updatedBy))
    .where(eq(platformWebsiteSettings.id, true))
    .limit(1);
  return {
    ok: true,
    settings: {
      values: toValues(row?.settings),
      updatedAt: row?.settings.updatedAt ?? null,
      updatedByEmail: row?.updatedByEmail ?? null,
    },
  };
}

/** Saves the whole contact settings record (platform owner only). */
export async function updateWebsiteSettings(
  context: AuthContext,
  input: WebsiteSettingsInput,
): Promise<{ ok: true; settings: WebsiteSettingsRecord } | { ok: false; error: WebsiteActionError }> {
  if (!(await hasPermission(context, WEBSITE_SETTINGS_CAPABILITY))) {
    return { ok: false, error: FORBIDDEN };
  }
  const parsed = websiteSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: { code: "validation", message: issue?.message ?? "Check the highlighted fields.", field: String(issue?.path[0] ?? "") },
    };
  }
  const values = parsed.data;

  const saved = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(platformWebsiteSettings)
      .where(eq(platformWebsiteSettings.id, true))
      .for("update")
      .limit(1);
    const now = new Date();
    const [row] = await tx
      .insert(platformWebsiteSettings)
      .values({ id: true, ...values, updatedAt: now, updatedBy: context.userId })
      .onConflictDoUpdate({
        target: platformWebsiteSettings.id,
        set: { ...values, updatedAt: now, updatedBy: context.userId },
      })
      .returning();
    await recordAudit(
      {
        actorUserId: context.userId,
        actorRole: context.platformRole,
        action: "updateWebsiteSettings",
        entityType: "platform_website_settings",
        before: toValues(before),
        after: values,
      },
      tx,
    );
    return row;
  });

  const [actor] = await db.select({ email: users.email }).from(users).where(eq(users.id, context.userId)).limit(1);
  return {
    ok: true,
    settings: { values: toValues(saved), updatedAt: saved.updatedAt, updatedByEmail: actor?.email ?? null },
  };
}
