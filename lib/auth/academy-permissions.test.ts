import { describe, expect, it } from "vitest";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import {
  ACADEMY_AUDIT_LOG_ACTION,
  ACADEMY_BOOKS_ACTION,
  ACADEMY_CERTIFICATES_ACTION,
  ACADEMY_COURSES_BATCHES_ACTION,
  ACADEMY_EXAMS_ACTION,
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_FEE_PERIODS_ACTION,
  ACADEMY_GRADE_BANDS_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_RESULTS_ACTION,
  ACADEMY_SETTINGS_ACTION,
  ACADEMY_STAFF_ACTION,
  ACADEMY_STUDENT_ID_CARDS_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  ACADEMY_STUDENTS_ACTION,
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
    // "academy.branches"/"academy.staff"/"academy.students" were prior
    // examples here but are now populated (Phase 2 Items 34/35/38), and
    // "academy.exams" (Phase 3 Item 48) and "academy.certificates" (Phase 5
    // Item 57) are now populated too — swapped for actions no item has
    // claimed yet (Phase 5 Notifications/Reports, still unbuilt as of this
    // wave), to keep testing the fallback itself rather than a
    // since-populated row.
    expect(getAcademyPermissionLevel("academy_owner", "academy.finance")).toBe("none");
    expect(getAcademyPermissionLevel("manager", "academy.reports")).toBe("none");
  });
});

// Academy Owner rule (lib/auth/academy-permissions.ts): the Academy Owner
// can see and do everything inside their own academy, and the Academy
// Administrator holds exactly the same authority. On every row both hold
// that row's TOP level — the level its strictest gate checks for (e.g.
// reversal needs "full" on student payments / fee periods, "approve" on
// expenses, "manage" on income / books).
const OWNER_TOP_LEVELS = {
  [ACADEMY_SETTINGS_ACTION]: "full",
  [ACADEMY_AUDIT_LOG_ACTION]: "full",
  "academy.branches": "full",
  [ACADEMY_STAFF_ACTION]: "full",
  [ACADEMY_STUDENTS_ACTION]: "full",
  [ACADEMY_STUDENT_ID_CARDS_ACTION]: "full",
  [ACADEMY_COURSES_BATCHES_ACTION]: "full",
  [ACADEMY_GRADE_BANDS_ACTION]: "full",
  [ACADEMY_EXAMS_ACTION]: "full",
  [ACADEMY_RESULTS_ACTION]: "approve",
  [ACADEMY_STUDENT_PAYMENTS_ACTION]: "full",
  [ACADEMY_EXPENSES_ACTION]: "approve",
  [ACADEMY_INCOME_ACTION]: "manage",
  [ACADEMY_CERTIFICATES_ACTION]: "full",
  [ACADEMY_FEE_PERIODS_ACTION]: "full",
  [ACADEMY_BOOKS_ACTION]: "manage",
} as const;

describe("Academy Owner rule — Owner and Academy Administrator hold every row's top level", () => {
  for (const role of ["academy_owner", "academy_admin"] as const) {
    for (const [action, level] of Object.entries(OWNER_TOP_LEVELS)) {
      it(`${role} holds "${level}" on ${action}`, () => {
        expect(getAcademyPermissionLevel(role, action)).toBe(level);
      });
    }
  }

  it("Owner and Academy Administrator are identical on every row", () => {
    for (const action of Object.keys(OWNER_TOP_LEVELS)) {
      expect(getAcademyPermissionLevel("academy_admin", action)).toBe(getAcademyPermissionLevel("academy_owner", action));
    }
  });

  it("Trainer rule: a trainer holds only students (view), courses/batches (assigned) and exams (enter marks)", () => {
    const held = Object.keys(OWNER_TOP_LEVELS).filter((action) => getAcademyPermissionLevel("trainer", action) !== "none");
    expect(held.sort()).toEqual(
      ["academy.branches", ACADEMY_STUDENTS_ACTION, ACADEMY_COURSES_BATCHES_ACTION, ACADEMY_EXAMS_ACTION].sort(),
    );
    expect(getAcademyPermissionLevel("trainer", ACADEMY_STUDENTS_ACTION)).toBe("view");
    expect(getAcademyPermissionLevel("trainer", ACADEMY_EXAMS_ACTION)).toBe("enter_marks");
    for (const action of [
      ACADEMY_STAFF_ACTION,
      ACADEMY_STUDENT_PAYMENTS_ACTION,
      ACADEMY_EXPENSES_ACTION,
      ACADEMY_INCOME_ACTION,
      ACADEMY_FEE_PERIODS_ACTION,
      ACADEMY_CERTIFICATES_ACTION,
      ACADEMY_BOOKS_ACTION,
      ACADEMY_RESULTS_ACTION,
    ]) {
      expect(getAcademyPermissionLevel("trainer", action)).toBe("none");
    }
  });

  it("no other role is widened on the finance rows", () => {
    expect(getAcademyPermissionLevel("manager", ACADEMY_STUDENT_PAYMENTS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("manager", ACADEMY_EXPENSES_ACTION)).toBe("approve");
    expect(getAcademyPermissionLevel("manager", ACADEMY_INCOME_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("manager", ACADEMY_BOOKS_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("finance_officer", ACADEMY_STUDENT_PAYMENTS_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("finance_officer", ACADEMY_EXPENSES_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("trainer", ACADEMY_INCOME_ACTION)).toBe("none");
    expect(getAcademyPermissionLevel("admissions_officer", ACADEMY_STUDENT_PAYMENTS_ACTION)).toBe("none");
  });
});
