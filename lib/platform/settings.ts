/**
 * PLAN.md Phase 5, Item 61b — `/platform/settings` ("Global feature
 * switches, simple toggle form" per DESIGN.md's Role-to-UI matrix).
 *
 * ---------------------------------------------------------------------
 * GENUINE SPEC GAP — read before changing anything in this file
 * ---------------------------------------------------------------------
 * Neither PLAN.md nor DESIGN.md names a single concrete switch this page
 * must offer, and this item is explicitly barred from touching
 * `lib/db/schema.ts` this wave. `lib/db/schema.ts` was checked first for
 * anything resembling a generic key-value platform-config table (the task
 * brief's own suggested escape hatch) — there is none: no
 * `platform_settings`/`platform_config`/feature-flag table of any kind
 * exists anywhere in that file today (grepped for
 * platform_settings/platformSettings/platform_config/feature_flag/
 * key_value and found zero matches).
 *
 * Per the task brief's explicit instruction for exactly this situation:
 * "if nothing suitable exists... implement it as an in-memory/env-var-
 * backed read-only stub with a clearly documented comment that real
 * persistence requires a schema addition in a later wave — do not silently
 * invent a schema change... build the page as a read-only display of
 * current (env-derived) settings instead."
 *
 * So `getPlatformSettings` below is a READ-ONLY stub. It reads three
 * plausible, low-risk global switches this codebase's own Phase 5 work
 * would need a platform-wide (not per-academy-plan) on/off for, each
 * sourced from an environment variable with a safe default, and returns
 * them for display only:
 *
 *   - `smsGloballyEnabled` (`PLATFORM_SMS_ENABLED`, default `true`): a
 *     platform-wide kill switch for SMS delivery, distinct from each
 *     academy's own plan-level `sms_enabled` allowance
 *     (`subscription_plans.sms_enabled` — a per-plan feature flag, not a
 *     platform-wide one). Useful if the platform's SMS provider needs to be
 *     disabled everywhere at once regardless of which academies' plans
 *     otherwise permit it.
 *   - `newAcademyRegistrationsOpen` (`PLATFORM_REGISTRATIONS_OPEN`, default
 *     `true`): whether `/platform/academies/new`-style registration is
 *     currently being accepted platform-wide.
 *   - `maintenanceMode` (`PLATFORM_MAINTENANCE_MODE`, default `false`): a
 *     platform-wide maintenance banner/lockout flag.
 *
 * THERE IS NO WRITE PATH. No `updatePlatformSettings`/toggle action exists
 * in this file — a toggle that silently did nothing (or, worse, wrote to
 * process memory that resets on every deploy/restart and is never shared
 * across server instances) would be actively misleading in a multi-instance
 * deployment, which is exactly the "silently invent a workaround" outcome
 * the task brief says to avoid. `app/platform/settings/page.tsx` renders
 * these three values as plain read-only text with an explicit note
 * explaining why there's no toggle yet, rather than a "simple toggle form"
 * that would falsely imply changes persist.
 *
 * FOLLOW-UP (flagged, not resolved here): making this page an actual
 * "simple toggle form" per DESIGN.md requires a schema addition — a
 * `platform_settings` table (or a generic key-value config table other
 * future switches could also use) — in a later wave that IS permitted to
 * touch `lib/db/schema.ts`.
 */

export const PLATFORM_SETTINGS_CAPABILITY = "platform.settings.manage";

export interface PlatformSettings {
  smsGloballyEnabled: boolean;
  newAcademyRegistrationsOpen: boolean;
  maintenanceMode: boolean;
  /** Always true today — documents to the UI that these values are not
   * persisted anywhere and only reflect this server process's current
   * environment variables at read time. */
  readOnly: true;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Read-only, env-derived snapshot of the platform's global feature
 * switches. See this module's top comment for why there is no persistence
 * and no corresponding write function.
 */
export function getPlatformSettings(): PlatformSettings {
  return {
    smsGloballyEnabled: readBooleanEnv("PLATFORM_SMS_ENABLED", true),
    newAcademyRegistrationsOpen: readBooleanEnv("PLATFORM_REGISTRATIONS_OPEN", true),
    maintenanceMode: readBooleanEnv("PLATFORM_MAINTENANCE_MODE", false),
    readOnly: true,
  };
}
