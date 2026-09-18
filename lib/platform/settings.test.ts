import { afterEach, describe, expect, it } from "vitest";
import { getPlatformSettings } from "./settings";

/**
 * lib/platform/settings.ts is a pure, env-var-backed READ-ONLY stub (see
 * that file's module comment for the full "no schema table exists, this
 * item can't add one, build a read-only display instead" reasoning) — it
 * touches no database table, so unlike every other test in this codebase
 * there's no Postgres fixture setup/teardown here, just environment
 * variable manipulation around the three flags this function reads.
 */

const ENV_KEYS = ["PLATFORM_SMS_ENABLED", "PLATFORM_REGISTRATIONS_OPEN", "PLATFORM_MAINTENANCE_MODE"] as const;
const originalValues = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("getPlatformSettings", () => {
  it("defaults to sms enabled, registrations open, maintenance mode off when no env vars are set", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    const settings = getPlatformSettings();
    expect(settings).toEqual({
      smsGloballyEnabled: true,
      newAcademyRegistrationsOpen: true,
      maintenanceMode: false,
      readOnly: true,
    });
  });

  it("reads each flag from its own env var, case-insensitively", () => {
    process.env.PLATFORM_SMS_ENABLED = "false";
    process.env.PLATFORM_REGISTRATIONS_OPEN = "FALSE";
    process.env.PLATFORM_MAINTENANCE_MODE = "True";

    const settings = getPlatformSettings();
    expect(settings.smsGloballyEnabled).toBe(false);
    expect(settings.newAcademyRegistrationsOpen).toBe(false);
    expect(settings.maintenanceMode).toBe(true);
  });

  it("treats an empty string the same as unset (falls back to the default)", () => {
    process.env.PLATFORM_MAINTENANCE_MODE = "   ";
    expect(getPlatformSettings().maintenanceMode).toBe(false);
  });

  it("always reports readOnly: true — no persistence exists yet", () => {
    expect(getPlatformSettings().readOnly).toBe(true);
  });
});
