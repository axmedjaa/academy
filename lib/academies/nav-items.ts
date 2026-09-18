import {
  ACADEMY_AUDIT_LOG_ACTION,
  ACADEMY_CERTIFICATES_ACTION,
  ACADEMY_COURSES_BATCHES_ACTION,
  ACADEMY_EXAMS_ACTION,
  ACADEMY_GRADE_BANDS_ACTION,
  ACADEMY_INCOME_ACTION,
  ACADEMY_RESULTS_ACTION,
  ACADEMY_SETTINGS_ACTION,
  ACADEMY_STAFF_ACTION,
  ACADEMY_STUDENT_ID_CARDS_ACTION,
  ACADEMY_STUDENT_PAYMENTS_ACTION,
  ACADEMY_STUDENTS_ACTION,
  getAcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * DESIGN.md §4.2 "Academy Navigation" — the exact, complete nav tree:
 *
 *   Dashboard, Students & Admissions, Staff, Academics (Programs / Courses /
 *   Batches / Timetable), Exams & Results, Finance, Certificates & IDs,
 *   Reports, Notifications, Audit Log, Settings.
 *
 * "No item for attendance exists anywhere in this tree (Decision #21) and
 * none ever will — there is no placeholder, disabled item, or 'coming soon'
 * state for it." — honored below by simply never defining one; the Stitch
 * mockups' own "Attendance" sidebar entry (dashboard_1/code.html) is
 * deliberately dropped, not adapted.
 *
 * Per DESIGN.md §2/§5: "inaccessible items omitted entirely (never shown
 * disabled)". `getVisibleAcademyNavItems` is the pure function that turns a
 * role into the exact filtered list a real page renders — kept here,
 * DB-free, so it's unit-testable without a running Postgres instance (this
 * codebase's existing convention for permission tables, e.g.
 * lib/auth/academy-permissions.ts itself has no DB dependency either).
 */
export interface AcademyNavItem {
  key: string;
  label: string;
  href: string;
  /** Material-symbol-style icon name, rendered as inline SVG by the shell
   * (app/academy/_shell/icons.tsx) — never an icon-font/CDN dependency. */
  icon: string;
  /** `null` = always visible to any active academy member (Dashboard,
   * Reports, Notifications). Non-null = only visible when
   * `getAcademyPermissionLevel(role, action) !== "none"`. */
  requiredAction: string | null;
}

export const ACADEMY_NAV_ITEMS: readonly AcademyNavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/academy/dashboard", icon: "dashboard", requiredAction: null },
  {
    key: "students",
    label: "Students & Admissions",
    href: "/academy/students",
    icon: "group",
    requiredAction: ACADEMY_STUDENTS_ACTION,
  },
  { key: "staff", label: "Staff", href: "/academy/staff", icon: "badge", requiredAction: ACADEMY_STAFF_ACTION },
  {
    key: "academics",
    label: "Academics",
    href: "/academy/programs",
    icon: "school",
    requiredAction: ACADEMY_COURSES_BATCHES_ACTION,
  },
  {
    key: "exams",
    label: "Exams & Results",
    href: "/academy/exams",
    icon: "fact_check",
    requiredAction: ACADEMY_EXAMS_ACTION,
  },
  {
    key: "finance",
    label: "Finance",
    href: "/academy/finance",
    icon: "payments",
    // DESIGN.md §4.2: "Finance never appears for a Trainer." Trainer's own
    // ACADEMY_STUDENT_PAYMENTS_ACTION level is "view" (not "none"), so this
    // deliberately does NOT gate on that row (which a Trainer *does* pass) —
    // ACADEMY_EXPENSES_ACTION is the row Trainer also holds "view" on, so
    // neither alone excludes them. Gating on ACADEMY_INCOME_ACTION instead:
    // Trainer has no entry there at all ("none"), and every role that should
    // see Finance (Owner/Admin/Manager/Finance Officer) does have an entry —
    // see academy-permissions.ts's ACADEMY_INCOME_ACTION rows. Documented
    // judgment call: this is a nav-visibility choice only, not a new
    // permission row; page-level reads still gate independently.
    requiredAction: ACADEMY_INCOME_ACTION,
  },
  {
    key: "certificates",
    label: "Certificates & IDs",
    href: "/academy/certificates",
    icon: "workspace_premium",
    requiredAction: ACADEMY_CERTIFICATES_ACTION,
  },
  { key: "reports", label: "Reports", href: "/academy/reports", icon: "bar_chart", requiredAction: null },
  {
    key: "notifications",
    label: "Notifications",
    href: "/academy/notifications",
    icon: "notifications",
    requiredAction: null,
  },
  {
    key: "audit-log",
    label: "Audit Log",
    href: "/academy/audit-logs",
    icon: "receipt_long",
    // DESIGN.md §4.2: "Audit Log appears only for Academy Owner/Admin
    // (Decision #18)" — ACADEMY_AUDIT_LOG_ACTION's table already grants
    // exactly Owner/Admin "full" and nobody else (see
    // academy-permissions.ts), so this is a direct, unmodified reuse.
    requiredAction: ACADEMY_AUDIT_LOG_ACTION,
  },
  {
    key: "settings",
    label: "Settings",
    href: "/academy/settings",
    icon: "settings",
    // F2 fix: was `null` (always visible). app/academy/settings/page.tsx's
    // getAcademySettings gates the ENTIRE page on ACADEMY_SETTINGS_ACTION —
    // Admissions Officer/Finance Officer/Trainer all have "none" there and
    // would hit a full "Access denied" page, violating DESIGN.md §3.1/§5's
    // "omitted entirely, never shown then blocked" rule.
    requiredAction: ACADEMY_SETTINGS_ACTION,
  },
] as const;

/**
 * Several DESIGN.md §4.2 top-level lines are themselves a small group of
 * existing routes (e.g. "Academics (Programs / Courses / Batches /
 * Timetable)") — these sub-items are how the shell keeps every existing
 * `/academy/*` page (built in earlier phases, before any navigation
 * existed at all) reachable, rather than leaving them typed-URL-only.
 * `requiredAction` per sub-item mirrors exactly the permission row that
 * page's own backend already gates on (grepped from each route's
 * lib/academies/*.ts before adding it here) — never a new or different
 * check than the page enforces itself.
 */
export interface AcademyNavSubItem {
  parentKey: string;
  label: string;
  href: string;
  requiredAction: string;
  /** F3 fix: some backend reads (lib/academies/results.ts's `listResults`)
   * are gated on an OR of two different permission rows rather than one —
   * `listResults` allows access via EITHER `ACADEMY_RESULTS_ACTION` (Owner/
   * Admin/Manager's approve authority) OR `ACADEMY_EXAMS_ACTION` at
   * "enter_marks" level or above (Trainer's submit authority). A single
   * `requiredAction` field can't express that, so this optional second
   * action is additive — only the "Results" entry below sets it; every
   * other entry is unaffected. */
  alternateAction?: string;
}

export const ACADEMY_NAV_SUBITEMS: readonly AcademyNavSubItem[] = [
  { parentKey: "students", label: "Students", href: "/academy/students", requiredAction: ACADEMY_STUDENTS_ACTION },
  { parentKey: "students", label: "Admissions", href: "/academy/admissions", requiredAction: ACADEMY_STUDENTS_ACTION },

  { parentKey: "staff", label: "Staff", href: "/academy/staff", requiredAction: ACADEMY_STAFF_ACTION },
  { parentKey: "staff", label: "Branches", href: "/academy/branches", requiredAction: "academy.branches" },

  { parentKey: "academics", label: "Programs", href: "/academy/programs", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { parentKey: "academics", label: "Courses", href: "/academy/courses", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { parentKey: "academics", label: "Batches", href: "/academy/batches", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },
  { parentKey: "academics", label: "Timetable", href: "/academy/timetable", requiredAction: ACADEMY_COURSES_BATCHES_ACTION },

  { parentKey: "exams", label: "Exams", href: "/academy/exams", requiredAction: ACADEMY_EXAMS_ACTION },
  {
    parentKey: "exams",
    label: "Results",
    href: "/academy/results",
    requiredAction: ACADEMY_RESULTS_ACTION,
    // F3 fix: listResults() also admits Trainer via ACADEMY_EXAMS_ACTION's
    // "enter_marks" level (canSubmitLevel) — see AcademyNavSubItem's own
    // doc comment on alternateAction.
    alternateAction: ACADEMY_EXAMS_ACTION,
  },
  { parentKey: "exams", label: "Grade Bands", href: "/academy/grades", requiredAction: ACADEMY_GRADE_BANDS_ACTION },

  { parentKey: "finance", label: "Finance", href: "/academy/finance", requiredAction: ACADEMY_INCOME_ACTION },
  {
    parentKey: "finance",
    label: "Approvals",
    href: "/academy/finance/approvals",
    // Confirmed Phase 4 audit gap fix — reads the same
    // ACADEMY_STUDENT_PAYMENTS_ACTION row the page itself gates on
    // (listStudentPayments). Visible to any non-"none" level; the page's
    // own `canApprove` check (Manager-only) decides whether the actual
    // queue or a permission-denied message renders.
    requiredAction: ACADEMY_STUDENT_PAYMENTS_ACTION,
  },
  { parentKey: "finance", label: "Finance Reports", href: "/academy/finance-reports", requiredAction: ACADEMY_INCOME_ACTION },

  {
    parentKey: "certificates",
    label: "Certificates",
    href: "/academy/certificates",
    requiredAction: ACADEMY_CERTIFICATES_ACTION,
  },
  {
    parentKey: "certificates",
    label: "ID Cards",
    href: "/academy/id-cards",
    requiredAction: ACADEMY_STUDENT_ID_CARDS_ACTION,
  },
] as const;

function isVisible(role: AcademyRole, requiredAction: string | null): boolean {
  if (requiredAction === null) return true;
  return getAcademyPermissionLevel(role, requiredAction) !== "none";
}

/** Pure: role -> the exact nav items a real page should render, in order.
 * Never shows an inaccessible item disabled (DESIGN.md §3.1/§5: "omitted
 * entirely"). */
export function getVisibleAcademyNavItems(role: AcademyRole): AcademyNavItem[] {
  return ACADEMY_NAV_ITEMS.filter((item) => isVisible(role, item.requiredAction));
}

export function getVisibleAcademyNavSubItems(role: AcademyRole, parentKey: string): AcademyNavSubItem[] {
  return ACADEMY_NAV_SUBITEMS.filter((item) => {
    if (item.parentKey !== parentKey) return false;
    if (getAcademyPermissionLevel(role, item.requiredAction) !== "none") return true;
    return item.alternateAction !== undefined && getAcademyPermissionLevel(role, item.alternateAction) !== "none";
  });
}
