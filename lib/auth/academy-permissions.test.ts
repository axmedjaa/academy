import { describe, expect, it } from "vitest";
import { ACADEMY_ROLES } from "@/lib/auth/roles";
import {
  ACADEMY_BOOKS_ACTION,
  ACADEMY_EXPENSES_ACTION,
  ACADEMY_FEE_PERIODS_ACTION,
  ACADEMY_GRADE_BANDS_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_RESULTS_ACTION,
  ACADEMY_SETTINGS_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
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

// Later architecture decision: "no approval workflow should ever block
// Owner/Academy Administrator/Manager on an action they are already
// authorized to perform." The only permission-LEVEL change this required
// anywhere in the matrix was Academy Administrator's row on
// ACADEMY_GRADE_BANDS_ACTION (raised "manage" -> "full", matching Owner/
// Manager, so Academy Administrator gains real approve/self-decide
// authority on grade configurations). Every other row — including the
// three closely related finance/results rows this scenario specifically
// touched — is asserted unchanged here, so a regression that accidentally
// widened Academy Administrator's access elsewhere would fail loudly.
describe("Academy Administrator's grade-bands permission expansion is scoped to that one row only", () => {
  it("ACADEMY_GRADE_BANDS_ACTION: academy_admin is 'full', matching Owner/Manager", () => {
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_GRADE_BANDS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_GRADE_BANDS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("manager", ACADEMY_GRADE_BANDS_ACTION)).toBe("full");
  });

  it("every other row Academy Administrator holds is UNCHANGED by this expansion", () => {
    // Results: already "approve" before this change (untouched here — the
    // self-decide behavior change for results lives in results.ts's own
    // logic, not in a permission-level change).
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_RESULTS_ACTION)).toBe("approve");
    // Expenses: level itself still "approve" (unrelated later change —
    // see the "Expenses self-approval" describe block below for why
    // Academy Administrator CAN now create/submit despite this level never
    // changing: expense-records.ts's own `canCreate` function was widened
    // to also accept "approve", not this permission row).
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_EXPENSES_ACTION)).toBe("approve");
    // Student payments / fee periods: still "manage" (raised in an earlier,
    // separate, explicitly-approved change) — not "full", so Academy
    // Administrator still cannot reverse/adjust a student payment.
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_STUDENT_PAYMENTS_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_FEE_PERIODS_ACTION)).toBe("manage");
  });
});

// Later architecture decision: "for ALL finance workflows, Owner/Academy
// Administrator/Manager/Finance Officer must be able to approve their own
// records — do not block on requestedBy === decidedBy for these four
// roles." Applied to Expenses (the only finance workflow with a real
// approval step — see lib/academies/expense-records.ts's own module
// comment). The only permission-LEVEL change this required was Owner's row
// on ACADEMY_EXPENSES_ACTION ("view" -> "manage", so Owner gains
// create/submit capability it previously had none of at all). Admin/
// Manager/Finance Officer's LEVELS are all unchanged — every behavior
// difference for them (Admin/Manager gaining create; Finance Officer
// gaining self-approve without general approve authority) lives in
// expense-records.ts's function-level logic (`canCreate`'s widened check,
// and the new role-based `SELF_APPROVE_ROLES` self-decide path),
// deliberately NOT expressed as further permission-matrix changes.
describe("Owner's expenses permission expansion is scoped to that one row only", () => {
  it("ACADEMY_EXPENSES_ACTION: academy_owner is 'manage', Admin/Manager/Finance Officer unchanged", () => {
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_EXPENSES_ACTION)).toBe("manage");
    expect(getAcademyPermissionLevel("academy_admin", ACADEMY_EXPENSES_ACTION)).toBe("approve");
    expect(getAcademyPermissionLevel("manager", ACADEMY_EXPENSES_ACTION)).toBe("approve");
    expect(getAcademyPermissionLevel("finance_officer", ACADEMY_EXPENSES_ACTION)).toBe("manage");
  });

  it("every other row Owner holds is UNCHANGED by this expansion", () => {
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_INCOME_ACTION)).toBe("view");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_BOOKS_ACTION)).toBe("view");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_STUDENT_PAYMENTS_ACTION)).toBe("view");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_FEE_PERIODS_ACTION)).toBe("view");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_GRADE_BANDS_ACTION)).toBe("full");
    expect(getAcademyPermissionLevel("academy_owner", ACADEMY_RESULTS_ACTION)).toBe("approve");
  });
});
