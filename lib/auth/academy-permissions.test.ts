import { describe, expect, it } from "vitest";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import {
  ACADEMY_SETTINGS_ACTION,
  getAcademyPermissionLevel,
  hasAcademyPermission,
} from "./academy-permissions";

// PLAN.md Master Permission Matrix, "Academy-level actions" table, row
// "Academy settings (direct edit)": Owner Full, Admin Full, Manager
// View/Edit, Admissions/Finance/Trainer none (`—`). One positive test per
// role that has access, one negative test per role that doesn't — matching
// PLAN.md's own testing bar ("every cell ... has a positive test ... and a
// negative test").
describe("hasAcademyPermission — academy.settings row", () => {
  it("grants academy_owner (Full)", () => {
    expect(hasAcademyPermission("academy_owner", ACADEMY_SETTINGS_ACTION)).toBe(true);
  });

  it("grants academy_admin (Full)", () => {
    expect(hasAcademyPermission("academy_admin", ACADEMY_SETTINGS_ACTION)).toBe(true);
  });

  it("grants manager (View/Edit)", () => {
    expect(hasAcademyPermission("manager", ACADEMY_SETTINGS_ACTION)).toBe(true);
  });

  it("denies admissions_officer", () => {
    expect(hasAcademyPermission("admissions_officer", ACADEMY_SETTINGS_ACTION)).toBe(false);
  });

  it("denies finance_officer", () => {
    expect(hasAcademyPermission("finance_officer", ACADEMY_SETTINGS_ACTION)).toBe(false);
  });

  it("denies trainer", () => {
    expect(hasAcademyPermission("trainer", ACADEMY_SETTINGS_ACTION)).toBe(false);
  });

  it("covers every ACADEMY_ROLES member (no role silently unhandled)", () => {
    const expected: Record<(typeof ACADEMY_ROLES)[number], boolean> = {
      academy_owner: true,
      academy_admin: true,
      manager: true,
      admissions_officer: false,
      finance_officer: false,
      trainer: false,
    };
    for (const role of ACADEMY_ROLES) {
      expect(hasAcademyPermission(role, ACADEMY_SETTINGS_ACTION)).toBe(expected[role]);
    }
  });
});

describe("getAcademyPermissionLevel", () => {
  it("distinguishes Owner/Admin's 'full' from Manager's 'view_edit', even though both grant access", () => {
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_SETTINGS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_SETTINGS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("manager", ACADEMY_SETTINGS_ACTION)).toBe("view_edit");
  });

  it("returns 'none' for a role with no entry for the action at all", () => {
    expect(getAcademyPermissionLevel("trainer", ACADEMY_SETTINGS_ACTION)).toBe("none");
  });

  it("returns 'none' for an action nobody has been given a row for yet (future extension point)", () => {
    expect(getAcademyPermissionLevel("academy_owner", "academy.branches")).toBe("none");
    expect(getAcademyPermissionLevel("manager", "academy.staff")).toBe("none");
  });
});
