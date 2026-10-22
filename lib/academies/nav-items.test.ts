import { describe, expect, it } from "vitest";
import { ACADEMY_NAV_ITEMS, getVisibleAcademyNavItems, groupNavItems } from "./nav-items";

describe("getVisibleAcademyNavItems", () => {
  it("never includes an attendance item for any role (PLAN.md: permanently out of scope)", () => {
    for (const role of ["academy_owner", "academy_admin", "manager", "admissions_officer", "finance_officer", "trainer"] as const) {
      const items = getVisibleAcademyNavItems(role);
      expect(items.some((item) => item.key.includes("attend") || item.label.toLowerCase().includes("attendance"))).toBe(false);
    }
    // Also assert it's absent from the master list itself, not just filtered out.
    expect(ACADEMY_NAV_ITEMS.some((item) => item.label.toLowerCase().includes("attendance"))).toBe(false);
  });

  it("shows academy_owner the design's full grouped tree, in order", () => {
    const groups = groupNavItems(getVisibleAcademyNavItems("academy_owner"));
    expect(groups.map((group) => [group.title, group.items.map((item) => item.label)])).toEqual([
      ["Overview", ["Dashboard"]],
      ["People", ["Students", "Admissions", "Staff", "Branches"]],
      ["Academy", ["Programs", "Courses", "Batches", "Timetable"]],
      ["Assessment", ["Exams", "Grades", "Results"]],
      ["Finance", ["Finance", "Fee periods", "Reports"]],
      ["Books", ["Books"]],
      ["Records", ["Certificates", "ID cards", "Audit log"]],
      ["Account", ["Settings"]],
    ]);
  });

  it("drops a whole group when a role can see none of its items", () => {
    const titles = groupNavItems(getVisibleAcademyNavItems("trainer")).map((group) => group.title);
    expect(titles).not.toContain("Account");
  });

  it("navigation-audit Phase 1: shows Branches to every role with academy.branches access, and hides it from finance_officer (no grant at all)", () => {
    for (const role of ["academy_owner", "academy_admin", "manager", "admissions_officer", "trainer"] as const) {
      expect(getVisibleAcademyNavItems(role).some((item) => item.key === "branches")).toBe(true);
    }
    expect(getVisibleAcademyNavItems("finance_officer").some((item) => item.key === "branches")).toBe(false);
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

  it("always shows Dashboard and Reports regardless of role (Notifications lives in the header bell)", () => {
    for (const role of ["academy_owner", "academy_admin", "manager", "admissions_officer", "finance_officer", "trainer"] as const) {
      const keys = getVisibleAcademyNavItems(role).map((item) => item.key);
      expect(keys).toEqual(expect.arrayContaining(["dashboard", "reports"]));
      expect(keys).not.toContain("notifications");
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

describe("permission-specific items", () => {
  it("F3: gives trainer Results via the exams/enter_marks alternate action", () => {
    // ACADEMY_RESULTS_ACTION has no entry for trainer, but listResults() also
    // admits ACADEMY_EXAMS_ACTION at "enter_marks", which trainer holds.
    expect(getVisibleAcademyNavItems("trainer").some((item) => item.key === "results")).toBe(true);
  });

  it("F3: still hides Results for roles with none on both the results and exams rows", () => {
    for (const role of ["admissions_officer", "finance_officer"] as const) {
      expect(getVisibleAcademyNavItems(role).some((item) => item.key === "results")).toBe(false);
    }
  });

  it("shows ID cards only to roles holding the id-cards row", () => {
    expect(getVisibleAcademyNavItems("academy_owner").some((item) => item.key === "id-cards")).toBe(true);
    expect(getVisibleAcademyNavItems("trainer").some((item) => item.key === "id-cards")).toBe(false);
  });

  it("every item points at a distinct /academy route", () => {
    const hrefs = ACADEMY_NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((href) => href.startsWith("/academy/"))).toBe(true);
  });
});
