import {
  ACADEMY_AUDIT_LOG_ACTION,
  ACADEMY_BOOKS_ACTION,
  ACADEMY_CERTIFICATES_ACTION,
  ACADEMY_COURSES_BATCHES_ACTION,
  ACADEMY_EXAMS_ACTION,
  ACADEMY_FEE_PERIODS_ACTION,
  ACADEMY_GRADE_BANDS_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_RESULTS_ACTION,
  ACADEMY_SETTINGS_ACTION,
  ACADEMY_STAFF_ACTION,
  ACADEMY_STUDENT_ID_CARDS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Academy Console navigation — Screen Inventory "Main navigation", from the
 * active `academy-engine.js` NAVDEF (HANDOFF.md: the authoritative design
 * source). Flat items under group headings:
 *
 *   Overview: Dashboard
 *   People: Students, Admissions, Staff, Branches
 *   Academy: Programs, Courses, Batches, Timetable
 *   Assessment: Exams, Grades, Results
 *   Finance: Finance, Fee periods, Reports
 *   Books: Books (Stock and Book sales are tabs of the Books page)
 *   Records: Certificates, ID cards, Audit log
 *   Account: Settings
 *
 * Notifications, My activity and Account settings live in the header (bell
 * and account menu), as in the reference. No attendance item exists
 * anywhere (Decision #21).
 *
 * Every `requiredAction` is the exact permission row the page's own backend
 * already gates on — never a new or different check. Items a role cannot
 * use are omitted, never disabled (DESIGN.md §3.1/§5). Pure and DB-free so
 * it stays unit-testable.
 */
export interface AcademyNavItem {
  key: string;
  label: string;
  href: string;
  /** Icon name rendered by app/academy/_shell/icons.tsx. */
  icon: string;
  group: string;
  /** `null` = visible to every active academy member. */
  requiredAction: string | null;
  /** Some reads are gated on an OR of two rows (lib/academies/results.ts's
   * `listResults` admits ACADEMY_RESULTS_ACTION or, for Trainers,
   * ACADEMY_EXAMS_ACTION at "enter_marks"). */
  alternateAction?: string;
  /** Extra route prefixes that should light this item up (child pages
   * reached from inside it, e.g. Books → Stock). */
  matchPrefixes?: string[];
}

export const ACADEMY_NAV_ITEMS: readonly AcademyNavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/academy/dashboard", icon: "dashboard", group: "Overview", requiredAction: null },

  { key: "students", label: "Students", href: "/academy/students", icon: "group", group: "People", requiredAction: ACADEMY_STUDENTS_ACTION },
  { key: "admissions", label: "Admissions", href: "/academy/admissions", icon: "user_plus", group: "People", requiredAction: ACADEMY_STUDENTS_ACTION },
  { key: "staff", label: "Staff", href: "/academy/staff", icon: "badge", group: "People", requiredAction: ACADEMY_STAFF_ACTION },
  // No named constant exists for this row in academy-permissions.ts.
  { key: "branches", label: "Branches", href: "/academy/branches", icon: "apartment", group: "People", requiredAction: "academy.branches" },

  { key: "programs", label: "Programs", href: "/academy/programs", icon: "school", group: "Academy", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { key: "courses", label: "Courses", href: "/academy/courses", icon: "menu_book", group: "Academy", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { key: "batches", label: "Batches", href: "/academy/batches", icon: "layers", group: "Academy", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { key: "timetable", label: "Timetable", href: "/academy/timetable", icon: "calendar", group: "Academy", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },

  { key: "exams", label: "Exams", href: "/academy/exams", icon: "fact_check", group: "Assessment", requiredAction: ACADEMY_EXAMS_ACTION },
  { key: "grades", label: "Grades", href: "/academy/grades", icon: "sliders", group: "Assessment", requiredAction: ACADEMY_GRADE_BANDS_ACTION },
  {
    key: "results",
    label: "Results",
    href: "/academy/results",
    icon: "clipboard",
    group: "Assessment",
    requiredAction: ACADEMY_RESULTS_ACTION,
    alternateAction: ACADEMY_EXAMS_ACTION,
  },

  // DESIGN.md §4.2: "Finance never appears for a Trainer" — gated on the
  // income row, which every finance-facing role holds and Trainer does not.
  {
    key: "finance",
    label: "Finance",
    href: "/academy/finance",
    icon: "payments",
    group: "Finance",
    requiredAction: ACADEMY_INCOME_ACTION,
    matchPrefixes: ["/academy/receipts"],
  },
  { key: "fee-periods", label: "Fee periods", href: "/academy/finance/fee-periods", icon: "receipt_long", group: "Finance", requiredAction: ACADEMY_FEE_PERIODS_ACTION },
  // The reports hub gates each tab on its own row; the entry stays visible
  // to every member, unchanged from before.
  { key: "reports", label: "Reports", href: "/academy/reports", icon: "bar_chart", group: "Finance", requiredAction: null, matchPrefixes: ["/academy/finance-reports"] },

  { key: "books", label: "Books", href: "/academy/books", icon: "book", group: "Books", requiredAction: ACADEMY_BOOKS_ACTION },

  { key: "certificates", label: "Certificates", href: "/academy/certificates", icon: "workspace_premium", group: "Records", requiredAction: ACADEMY_CERTIFICATES_ACTION },
  { key: "id-cards", label: "ID cards", href: "/academy/id-cards", icon: "idcard", group: "Records", requiredAction: ACADEMY_STUDENT_ID_CARDS_ACTION },
  // Owner/Admin only (Decision #18) — the audit-log row grants nobody else.
  { key: "audit-log", label: "Audit log", href: "/academy/audit-logs", icon: "history", group: "Records", requiredAction: ACADEMY_AUDIT_LOG_ACTION },

  // The settings page gates its whole content on this row (F2).
  { key: "settings", label: "Settings", href: "/academy/settings", icon: "settings", group: "Account", requiredAction: ACADEMY_SETTINGS_ACTION },
] as const;

function isVisible(role: AcademyRole, item: AcademyNavItem): boolean {
  if (item.requiredAction === null) return true;
  if (getAcademyPermissionLevel(role, item.requiredAction) !== "none") return true;
  return item.alternateAction !== undefined && getAcademyPermissionLevel(role, item.alternateAction) !== "none";
}

/** Pure: role -> the exact nav items to render, in order. */
export function getVisibleAcademyNavItems(role: AcademyRole): AcademyNavItem[] {
  return ACADEMY_NAV_ITEMS.filter((item) => isVisible(role, item));
}

export interface NavGroup<T> {
  title: string;
  items: T[];
}

/** Groups already-filtered items by `group`, keeping first-seen order. A
 * group whose every item was filtered out simply never appears. */
export function groupNavItems<T extends { group: string }>(items: readonly T[]): NavGroup<T>[] {
  const groups: NavGroup<T>[] = [];
  for (const item of items) {
    const existing = groups.find((group) => group.title === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ title: item.group, items: [item] });
  }
  return groups;
}
