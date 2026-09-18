import { describe, expect, it } from "vitest";
import { ACADEMY_NAV_ITEMS, getVisibleAcademyNavItems, getVisibleAcademyNavSubItems } from "./nav-items";

describe("getVisibleAcademyNavItems", () => {
  it("never includes an attendance item for any role (PLAN.md: permanently out of scope)", () => {
    for (const role of ["academy_owner", "academy_admin", "manager", "admissions_officer", "finance_officer", "trainer"] as const) {
      const items = getVisibleAcademyNavItems(role);
      expect(items.some((item) => item.key.includes("attend") || item.label.toLowerCase().includes("attendance"))).toBe(false);
    }
    // Also assert it's absent from the master list itself, not just filtered out.
    expect(ACADEMY_NAV_ITEMS.some((item) => item.label.toLowerCase().includes("attendance"))).toBe(false);
  });

  it("shows the full tree to academy_owner", () => {
    const items = getVisibleAcademyNavItems("academy_owner");
    const keys = items.map((item) => item.key);
    expect(keys).toEqual([
      "dashboard",
      "students",
      "staff",
      "academics",
      "exams",
      "finance",
      "certificates",
      "reports",
      "notifications",
      "audit-log",
      "settings",
    ]);
  });

  it("hides Finance for trainer (DESIGN.md §4.2: 'Finance never appears for a Trainer')", () => {
    const items = getVisibleAcademyNavItems("trainer");
    expect(items.some((item) => item.key === "finance")).toBe(false);
  });

  it("hides Audit Log for every role except academy_owner/academy_admin (Decision #18)", () => {
    for (const role of ["manager", "admissions_officer", "finance_officer", "trainer"] as const) {
      expect(getVisibleAcademyNavItems(role).some((item) => item.key === "audit-log")).toBe(false);
    }
    expect(getVisibleAcademyNavItems("academy_owner").some((item) => item.key === "audit-log")).toBe(true);
    expect(getVisibleAcademyNavItems("academy_admin").some((item) => item.key === "audit-log")).toBe(true);
  });

  it("always shows Dashboard, Reports, Notifications regardless of role", () => {
    for (const role of ["academy_owner", "academy_admin", "manager", "admissions_officer", "finance_officer", "trainer"] as const) {
      const keys = getVisibleAcademyNavItems(role).map((item) => item.key);
      expect(keys).toEqual(expect.arrayContaining(["dashboard", "reports", "notifications"]));
    }
  });

  it("F2: hides Settings for roles with no academy.settings access, shows it for roles that have it", () => {
    // ACADEMY_SETTINGS_ACTION: owner/admin="full", manager="view_edit" — all
    // non-"none". admissions_officer/finance_officer/trainer have no entry
    // ("none") — app/academy/settings/page.tsx's getAcademySettings blocks
    // the whole page for them, so the nav item must not be shown either.
    for (const role of ["academy_owner", "academy_admin", "manager"] as const) {
      expect(getVisibleAcademyNavItems(role).some((item) => item.key === "settings")).toBe(true);
    }
    for (const role of ["admissions_officer", "finance_officer", "trainer"] as const) {
      expect(getVisibleAcademyNavItems(role).some((item) => item.key === "settings")).toBe(false);
    }
  });
});

describe("getVisibleAcademyNavSubItems", () => {
  it("gives finance_officer visibility into Certificates sub-items only where permitted", () => {
    // finance_officer has "none" on ACADEMY_CERTIFICATES_ACTION per academy-permissions.ts
    const subItems = getVisibleAcademyNavSubItems("finance_officer", "certificates");
    expect(subItems).toEqual([]);
  });

  it("gives academy_owner both Certificates and ID Cards sub-items", () => {
    const subItems = getVisibleAcademyNavSubItems("academy_owner", "certificates");
    expect(subItems.map((item) => item.label).sort()).toEqual(["Certificates", "ID Cards"]);
  });

  it("Phase 4 gap fix: gives every role with student-payments access an Approvals sub-item, and hides it for admissions_officer", () => {
    // ACADEMY_STUDENT_PAYMENTS_ACTION: owner/admin/manager/trainer = "view"
    // or above, finance_officer = "manage" — all five are non-"none".
    // admissions_officer has no entry ("none").
    for (const role of ["academy_owner", "academy_admin", "manager", "finance_officer", "trainer"] as const) {
      expect(getVisibleAcademyNavSubItems(role, "finance").some((item) => item.label === "Approvals")).toBe(true);
    }
    expect(getVisibleAcademyNavSubItems("admissions_officer", "finance").some((item) => item.label === "Approvals")).toBe(
      false,
    );
  });

  it("F3: gives trainer the Results sub-item via the exams/enter_marks alternate action", () => {
    // ACADEMY_RESULTS_ACTION has no entry for trainer ("none"), but
    // lib/academies/results.ts's listResults() also admits access via
    // ACADEMY_EXAMS_ACTION at "enter_marks" or above, which trainer holds —
    // the nav must reflect that OR, not just the first action.
    const subItems = getVisibleAcademyNavSubItems("trainer", "exams");
    expect(subItems.some((item) => item.label === "Results")).toBe(true);
  });

  it("F3: still hides Results for roles with none on both the results and exams rows", () => {
    // admissions_officer and finance_officer have "none" on both
    // ACADEMY_RESULTS_ACTION and ACADEMY_EXAMS_ACTION.
    for (const role of ["admissions_officer", "finance_officer"] as const) {
      const subItems = getVisibleAcademyNavSubItems(role, "exams");
      expect(subItems.some((item) => item.label === "Results")).toBe(false);
    }
  });
});
