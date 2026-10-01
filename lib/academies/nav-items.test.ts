import { describe, expect, it } from "vitest";
import {
  ACADEMY_NAV_ITEMS,
  getVisibleAcademyNavItems,
  getVisibleAcademyNavSubItems,
  hasExpandableSubItems,
} from "./nav-items";

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
      "branches",
      "academics",
      "exams",
      "finance",
      "books",
      "certificates",
      "reports",
      "notifications",
      "audit-log",
      "settings",
    ]);
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

  it("navigation-audit Phase 1: gives academy_owner only the ID Cards sub-item under certificates — the redundant self-referencing 'Certificates' entry (same href as the parent) is gone", () => {
    const subItems = getVisibleAcademyNavSubItems("academy_owner", "certificates");
    expect(subItems.map((item) => item.label)).toEqual(["ID Cards"]);
  });

  it("navigation-audit Phase 1: finance sub-items are just Fee Periods — no self-referencing 'Finance' entry and no 'Finance Reports' entry (that route is now a redirect to /academy/reports)", () => {
    const subItems = getVisibleAcademyNavSubItems("academy_owner", "finance");
    expect(subItems.map((item) => item.label)).toEqual(["Fee Periods"]);
  });

  it("navigation-audit Phase 1: books sub-items are Stock and Book Sales — no self-referencing 'Books' entry", () => {
    const subItems = getVisibleAcademyNavSubItems("academy_owner", "books");
    expect(subItems.map((item) => item.label)).toEqual(["Stock", "Book Sales"]);
  });

  it("navigation-audit Phase 1: Branches is a standalone top-level item with no sub-items of its own", () => {
    expect(getVisibleAcademyNavSubItems("academy_owner", "branches")).toEqual([]);
  });

  it("no longer has an Approvals sub-item under Finance for any role (student-payment approval workflow removed)", () => {
    for (const role of [
      "academy_owner",
      "academy_admin",
      "manager",
      "finance_officer",
      "trainer",
      "admissions_officer",
    ] as const) {
      expect(getVisibleAcademyNavSubItems(role, "finance").some((item) => item.label === "Approvals")).toBe(false);
    }
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

describe("hasExpandableSubItems", () => {
  const item = { key: "staff", label: "Staff", href: "/academy/staff", icon: "badge", requiredAction: null };

  it("returns false for an empty sub-items list (plain leaf item)", () => {
    expect(hasExpandableSubItems(item, [])).toBe(false);
  });

  it("returns false for the Staff-shaped case: one sub-item whose href duplicates the parent's own href", () => {
    const subItems = [{ parentKey: "staff", label: "Staff", href: "/academy/staff", requiredAction: "staff" }];
    expect(hasExpandableSubItems(item, subItems)).toBe(false);
  });

  it("returns true for a single sub-item with a distinct href (e.g. Finance's Fee Periods)", () => {
    const financeItem = { key: "finance", label: "Finance", href: "/academy/finance", icon: "payments", requiredAction: null };
    const subItems = [{ parentKey: "finance", label: "Fee Periods", href: "/academy/finance/fee-periods", requiredAction: "fee_periods" }];
    expect(hasExpandableSubItems(financeItem, subItems)).toBe(true);
  });

  it("returns true for multiple sub-items (e.g. Academics)", () => {
    const academicsItem = { key: "academics", label: "Academics", href: "/academy/programs", icon: "school", requiredAction: null };
    const subItems = [
      { parentKey: "academics", label: "Programs", href: "/academy/programs", requiredAction: "courses" },
      { parentKey: "academics", label: "Courses", href: "/academy/courses", requiredAction: "courses" },
    ];
    expect(hasExpandableSubItems(academicsItem, subItems)).toBe(true);
  });
});
