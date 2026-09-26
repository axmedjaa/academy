# Academy Management SaaS — UI/UX Design Specification

**Status**: Implementation-ready. **Authoritative for**: screens, navigation, layout, components, interaction patterns, states, responsive behavior, permission-aware UI, visual hierarchy, UX copy.

**Not authoritative for**: data model, server actions, business-rule enforcement, security controls — those live in `PLAN.md`, which this document never contradicts. Where this document states a business rule (e.g., grace-period length, allowance behavior), it is restating a `PLAN.md` decision for UI-copy purposes only; `PLAN.md` remains the source of truth if the two ever diverge. `REQUIREMENTS_GAP_ANALYSIS.md` documents *why* each rule exists and is not needed to implement the UI.

**The UI is never the security boundary.** Every permission-aware behavior described here (hidden nav items, disabled buttons, locked fields) is a *presentation* of access control that is enforced server-side per `PLAN.md`; this document assumes that enforcement exists and describes only how the interface reflects it.

A companion file, `DESIGN_PROMPT.md`, is a separate artifact — a copy-paste prompt for an external AI design tool (Stitch/Claude Design) to generate visual mockups. This document is the implementation spec the engineering team builds against; it and `DESIGN_PROMPT.md` describe the same product and should never visually contradict each other, but this file is structured for building, not for pasting into a design tool.

---

## 1. Visual System

Concise reference — full token rationale lives in `DESIGN_PROMPT.md` §3; restated here so this document is self-contained for implementation.

- **Palette**: primary `#1B2A4A` (navy, surfaces/headers) / `#2F5FE0` (interactive blue); neutrals `#F7F8FA` (bg) / `#FFFFFF` (card) / `#E2E5EA` (border) / `#6B7280` (muted text) / `#111827` (text).
- **Status colors** (one meaning each, used identically everywhere): gray = draft/neutral; amber = pending/awaiting approval; green = approved/active/verified/paid; red = rejected/suspended/overdue/error/at-limit; deep teal/violet = published/final/locked; **muted slate** = closed/archived (deliberately duller than every other state — reads as permanently inert, never confused with "suspended" red); blue = informational.
- **Type**: one sans-serif family (e.g. Inter), tabular numerals for money/IDs, clear size hierarchy (page title > section header > table header > body > caption).
- **Spacing**: 8px base scale (4/8/12/16/24/32/48); card padding 24px desktop / 16px mobile.
- **Radius**: 6–8px controls/badges, 12px cards/modals.
- **Elevation**: flat + 1px border at rest; soft shadow only on floating elements (dropdown, modal, toast).
- **Accessibility floor**: WCAG AA contrast everywhere; every status/state is color **+** icon **+** text label, never color alone; visible focus rings on all interactive elements; all icon-only controls carry an accessible label; all tables/menus are keyboard-navigable.

---

## 2. App Shell

**Desktop (≥1280px)**
- Left sidebar (collapsible): context switcher at top (Platform ⟷ Academy — see §2.1), grouped nav below, active item highlighted, inaccessible items omitted entirely (never shown disabled — see §5).
- Header: breadcrumbs + page title (left); Academy/Branch context chip (academy console only), notification bell (unread badge), user menu (right).
- Page header: title, optional one-line description, primary action button top-right, secondary actions in overflow.
- Content: cards/tables/forms, sticky table headers on long lists.

**Tablet (768–1024px)**: sidebar → icon rail or drawer; tables keep primary columns, secondary columns move to an expandable row; forms single-column.

**Mobile (≤428px)**: sidebar → slide-in drawer (hamburger trigger); header condenses to menu/title/bell/avatar; tables → stacked card-per-row (label/value pairs, same status badges, row actions as a "⋯" menu, same pagination); forms → full-screen, single column, sticky bottom Save/Cancel bar; primary action button becomes sticky/floating on long lists.

### 2.1 Context Switcher

A Platform Owner/Administrator and an Academy user are **structurally different navigation trees that never blend**. A user with only a platform membership never sees academy concepts (branches, students) in their shell; a user with only an academy membership never sees platform concepts (other academies, plans). This is not a "switcher" in the sense of toggling views — it is which shell renders at all, determined by the authenticated session's membership, never by a client-side toggle.

### 2.2 Academy/Branch Context Chip (academy console only)

A persistent element in the header showing the current academy name and, where relevant, the active branch filter.
- **Academy-wide role** (Owner/Admin/Manager/Finance — see §5): branch selector is a free dropdown ("All branches" or a specific one).
- **Branch-limited role** (Admissions, Trainer): the chip shows their assigned branch(es) as a **locked** label, not a dropdown — if assigned to more than one, a read-only dropdown lets them switch *between their own* branches only, never see "All branches" or any branch they aren't assigned to.
- Every list screen scoped by branch shows a small persistent caption under its filter bar reflecting the active scope, e.g. *"Showing students in: Downtown Branch"* — scoping is never silent.

---

## 3. Reusable Components

Defined once; every screen in §7–§10 reuses these rather than inventing new patterns.

| Component | Spec |
|---|---|
| **Status badge** | Rounded, colored per §1 status palette, icon + label always paired. One component, reused for academy-subscription status, result status, payment status, certificate status, notification type — never a bespoke badge per module. |
| **Usage/allowance bar** | Horizontal progress bar + "N / limit" label. Green under 80%, amber 80–99%, red at 100% (blocked). Always paired with the specific resource name — never a generic "usage" bar. |
| **Data table** | Sticky sortable header; filter bar above (search + dropdown filters + optional date range, active filters as removable chips); status badges in the status column; row actions as inline icons (1–2 actions) or a "⋯" overflow menu (3+); checkbox column + contextual bulk-action bar only where bulk action is meaningful; pagination (page numbers + prev/next + page-size + "Showing X–Y of Z"); Export button (only on the four screens listed in §11.6) beside the filter bar, respecting active filters. |
| **Form** | Labels always visible above the field; required fields marked (not color-only); consistent input/select/date/number styling; currency fields `$`-prefixed, two-decimal, right-aligned tabular numerals; file-upload fields show a drop-zone + thumbnail/filename preview + remove/replace; inline field-level validation on blur/submit; specific, actionable error text; Submit/Cancel bottom-right desktop, full-width stacked mobile; multi-step forms (Academy Registration only) get a step indicator + back/next + final review step. |
| **Modal / confirmation dialog** | Plain confirmations for reversible actions ("Archive Branch"); **strong-worded** confirmations (see §11.7 copy library) for one-way actions (Close Academy, Cancel Certificate, Reverse Transaction) — always name the specific record and the specific consequence, never a bare "Are you sure?". |
| **Toast** | Bottom-corner, auto-dismissing, used for successful async actions (save/publish/approve) that don't need a full page state change. |
| **Alert/banner** | Full-width, persistent (not auto-dismissing), used for page-level states: subscription-suspended, academy-closed, permission-denied, onboarding-incomplete. |
| **Tabs** | Used for entity detail pages with distinct sub-views (Academy Detail: Overview/Branches/Subscription/Usage/Payments/Audit; Student Profile: Overview/Enrollment/Documents/Payments/Results/ID Card). |
| **Stepper** | Two uses: (a) multi-step forms, (b) workflow-state visualization (Exam Result: Draft → Marks Entered → Submitted → Under Review → Approved/Rejected → Published). |
| **Approval queue** | A filtered list view (submitted-but-undecided items) with an Approve/Reject action pair per row; Reject always opens a modal requiring a reason; the actor's own submissions are visually excluded or shown with Approve disabled + tooltip (see §11.4). |
| **Permission-locked control** | A toggle/button rendered visibly present but disabled, with a tooltip explaining why — used only where the *absence* of the control would be confusing (e.g. "Owner only" capabilities in Platform Staff grants, "You can't approve your own transaction"). Everywhere else, an inaccessible action is simply omitted, not shown disabled (see §5). |
| **File upload / drop-zone** | Drag-or-browse control, thumbnail or filename preview once attached, remove/replace action, inline validation (type/size), and — for academy-owned files (documents, ID photos, logo) only — a live allowance check that blocks the upload with the standard limit-reached message (§11.2) if the academy is at its storage cap. |
| **MFA code input** | 6-digit input (auto-advancing boxes optional), a distinct "Use a recovery code instead" link that swaps it for a single-field recovery-code input, same loading/error/lockout treatment as the login form. |
| **Audit-log row** | Expandable row: actor name + role, action, target entity/record, branch (if applicable), result (success/failure badge), timestamp; expands to show before/after values. Identical component on both `/platform/audit-logs` and `/academy/audit-logs`. |
| **Read-only/locked banner** | A persistent, non-dismissible strip at the top of a record or page indicating it cannot be edited — used for Published results (deep teal/violet, lock icon) and Closed academies (muted slate, archive icon). Visually distinct from each other (§1) so "locked because finalized" is never confused with "locked because closed." |

### 3.1 Standard Screen States

Defined once, applied to every list/detail/form screen in §7–§10 unless a screen explicitly overrides it:

- **Loading**: skeleton rows/cards matching the content shape — never a full-page spinner except initial app load or the auth screens.
- **Empty**: simple line icon + one-line explanation + primary action if relevant ("No students yet — Add your first student").
- **Error**: retry action for transient failures; specific inline messages for validation; see Permission-denied below for authorization failures specifically.
- **Success**: toast or inline badge after save/publish/approve.
- **Validation**: inline, field-level, on blur/submit.
- **Confirmation**: required before any consequential action (see §3 Modal spec and §11.7 copy library).
- **Permission-denied**: a calm full-section message ("You don't have permission to view this") — never a raw error page, never reachable via a visible-but-disabled nav item (the nav item simply isn't there — see §5). A *specific* action inside a page a user can otherwise view (e.g., a Trainer viewing a result they can't approve) is disabled with a tooltip instead of the page being blocked.
- **No-access (subscription/closure)**: full-page, non-dismissible — see §11.1.
- **Search-no-results**: distinct from Empty — "No results for '{query}'" + a clear-filters action.

---

## 4. Navigation Structure

### 4.1 Platform Navigation

```
Dashboard
Academies
Subscriptions
Plans
Payments
Usage & Allowances
Platform Staff
Reports
Audit Logs
Settings
```
Visible in full only to `platform_owner`. A `platform_admin` sees only the items their explicit grants cover, and even then only the actions actually grantable to that role (e.g., an admin granted the payment capability sees **Payments** with a Record-Payment form, but never the Verify/Reject/Reverse row actions, which are `platform_owner`-only) — **Plans** and **Platform Staff** never appear for any `platform_admin`, regardless of grants. Per `PLAN.md`'s Master Permission Matrix (`PLANNING_GAPS_RESOLUTION.md` §1), the following are **never grantable to a `platform_admin`, full stop**: academy approval/activation/suspension/reactivation/cancellation/closure, subscription renewal, subscription-payment verification/reject/reversal, plan pricing, platform-wide revenue reports, and platform staff/grant management. A `platform_admin`'s grantable surface is limited to: recording a subscription payment (not verifying it), viewing platform audit logs, and viewing non-revenue usage/reports. A `platform_admin` cannot create or manage other platform staff accounts and cannot grant, revoke, or otherwise manage anyone's permissions, including their own.

### 4.2 Academy Navigation

```
Dashboard
Students & Admissions
Staff
Academics (Programs / Courses / Batches / Timetable)
Exams & Results
Finance
Certificates & IDs
Reports
Notifications
Audit Log
Settings
```
Per-role visibility is defined in §5. `Finance` never appears for a Trainer. `Audit Log` appears only for Academy Owner/Admin (Decision #18). No item for attendance exists anywhere in this tree (Decision #21) and none ever will — there is no placeholder, disabled item, or "coming soon" state for it.

---

## 5. Role-to-UI Visibility Matrix

`Full` = view/create/edit; `Manage` = create/edit within own scope; `View` = read-only; `Approve` = decision-making on submitted items; `—` = not visible at all (nav/action omitted, not disabled). Matches `PLAN.md`'s permission tables exactly — no capability here is invented.

| Area | Platform Owner | Platform Admin | Academy Owner | Academy Admin | Manager | Admissions | Finance | Trainer |
|---|---|---|---|---|---|---|---|---|
| Academies (register/approve/activate/suspend/close) | Full | **— (never grantable)** | View own | — | — | — | — | — |
| Subscriptions (renew) | Full | **— (never grantable)** | View own | — | — | — | — | — |
| Payments (record) | Full | Per grant | — | — | — | — | — | — |
| Payments (verify/reject/reverse) | Full | **— (never grantable)** | — | — | — | — | — | — |
| Plans (pricing) | Full | **— (never grantable)** | — | — | — | — | — | — |
| Platform Revenue Reports | Full | **— (never grantable)** | — | — | — | — | — | — |
| Platform Staff/Grants | Full | — | — | — | — | — | — | — |
| Platform Audit Logs | Full | Per grant | — | — | — | — | — | — |
| Academy Settings | — | — | Full | Full | View/Edit | — | — | — |
| Branches | — | — | Full | Full | Manage | View assigned | — | View assigned |
| Staff | — | — | Full | Full | Manage | — | — | View self/assigned |
| Students | — | — | Full | Full | Manage | Manage assigned | View | View assigned |
| Courses/Batches | — | — | Full | Full | Manage | View assigned | — | Manage assigned |
| Exams (mark entry) | — | — | Full | Full | Manage | — | — | Enter marks (assigned only) |
| Grade Bands | — | — | Full | Manage | Manage/Approve | — | — | — |
| Result Approval/Publish | — | — | Approve | Approve | Approve | — | — | Submit only |
| Student Payments | — | — | View | View | Approve/Manage | — | Manage (not own) | View |
| Expenses | — | — | View | Approve | Approve | — | Create/Submit | View |
| Certificates | — | — | Full | Manage | Manage | — | — | View |
| ID Cards | — | — | Full | Manage | Manage | Manage assigned | — | — |
| Academy Audit Log | — | — | Full | Full | — | — | — | — |
| Export (Reports/Students/Finance/Audit) | — | — | Per own view rights | Per own view rights | Per own view rights | Per own view rights | Per own view rights | Per own view rights |

**Branch scope**: an `assigned` qualifier means the capability applies only within that role's assigned branch(es), per §2.2 — **Admissions Officer and Trainer are branch-limited**; Academy Owner, Academy Administrator, Manager, and Finance Officer are academy-wide (no `assigned` qualifier anywhere in their row). Admissions Officer's branch selector is locked exactly like Trainer's (§2.2) and can never show or select "All branches."

**Rule for building any screen**: if a role's cell is `—`, the corresponding nav item and every action tied to it are absent from that role's UI entirely — not rendered, not disabled, not grayed out. A disabled-with-tooltip treatment is reserved for the narrow cases in §3's "Permission-locked control" (self-approval, permanently-owner-only capabilities) where the *absence* of a familiar control would itself be confusing.

---

## 6. Screen Pattern Definitions

Three generic patterns cover the large majority of screens in §7–§10. Each screen entry below states only its *deltas* from the relevant pattern — not full state descriptions, per §3.1.

**Pattern A — List screen**: filter bar + data table (§3) + primary "Add/New" action (if role permits) + row actions. States: Standard (§3.1).

**Pattern B — Detail screen**: header card (key identity fields + status badge) + tabs (§3) for sub-sections + role-gated action buttons. States: Standard (§3.1), plus a locked/read-only banner where applicable (§3).

**Pattern C — Form screen**: the Form component (§3) either full-page or in a modal, depending on complexity (a single free-text field like "Reject reason" is a modal; a multi-field entity like "Register Student" is a full page). States: Standard (§3.1), with the allowance-limit-reached variant (§11.2) on any capped-resource creation form.

---

## 7. Authentication & Account Screens

| Screen | Pattern | Roles | Notes |
|---|---|---|---|
| `/login` | C (modal-style centered card) | All | Email + password → primary "Sign in". Generic invalid-credentials error (§11.8 wording, never reveals whether the email exists). Lockout state after repeated failures (rate-limited server-side). For a `platform_owner` account, successful password entry routes to MFA Challenge below instead of issuing a session — never skippable. |
| `/mfa/setup` (Platform Owner only, forced on first login) | C | Platform Owner | QR code + manual-entry fallback code + 6-digit confirmation input (MFA code component, §3). On success: **one-time** recovery-codes reveal with an explicit "Save these now — they will not be shown again" warning and a confirm-you've-saved checkbox before continuing. No skip option. |
| `/mfa/challenge` (every login after enrollment) | C | Platform Owner | MFA code component (§3); "Use a recovery code instead" link; same lockout/error treatment as login. |
| `/forgot-password` | C | All | Single email field; neutral confirmation regardless of whether the email exists (§11.8). |
| `/reset-password` | C | All | New + confirm password, inline hint "At least 8 characters" (Decision #16, no complexity rules, no forced expiry); expired/invalid-token state offers "Request a new link." |
| `/account/security` | B | All (any authenticated user) | Active-sessions list (device/browser, IP, last-active, "this device" flag) with per-row Revoke + "Sign out of all other sessions." For Platform Owner accounts only: an MFA sub-section showing enrollment status + "Regenerate recovery codes" (re-confirmation required, then the same one-time reveal as setup). |

---

## 8. Platform Owner Screens

| Screen | Pattern | Notes (deltas only) |
|---|---|---|
| `/platform/dashboard` | — (custom) | KPI cards (academies, active subscriptions, revenue this period, expiring-soon count) + activity feed + alerts panel (e.g. "3 academies pending approval"). |
| `/platform/academies` | A | Columns: name, status badge (derived — §11.1), plan, branch count, student count. |
| `/platform/academies/new` | C (multi-step) | Steps: Academy profile (name, type, address, phone, email, website, logo, registration number, primary contact) → Owner account → Default branch → Plan + allowances → Subscription dates → Review. |
| `/platform/academies/[id]` | B | Tabs: Overview (incl. Created-by/Approved-by metadata + **Onboarding Checklist** widget gating Activate — §11.3), Branches, Subscription & Plan, Usage vs. Allowances (bars per resource, §3), Payment History, Audit Log (scoped). Actions: Approve, Activate (disabled until checklist complete), Suspend, Reactivate, Cancel, **Close** (strongest-worded confirmation in the product, §11.7). **All of these actions are `platform_owner`-only and are absent — not disabled — from every `platform_admin`'s view of this page, regardless of any grant** (§5, Planning Gaps Resolution §1); an admin with view access sees the same tabs read-only with no action buttons. |
| `/platform/subscriptions` | A | Status badge shows the derived label including grace-period countdown (§11.1) and an "Expiring in N days" amber flag near `ends_at`. Row action: **Renew** — disabled with a tooltip if no verified payment exists for that subscription yet (§11.5); never offered on a `Cancelled` subscription (tooltip: "Cancelled subscriptions can't be renewed — register a new subscription instead," §11.5). **Renew is `platform_owner`-only and absent for every `platform_admin`** (§5). |
| `/platform/plans` | A + C | List of plan templates + create/edit form (name, price, billing period, per-resource limits, feature flags); Retire (not delete) if any academy is on it. Entirely absent for `platform_admin` regardless of grants (§5). |
| `/platform/payments` | A + C | Record-Payment form: academy, subscription, amount (USD, cents-precise), method, reference, received date, notes, **optional evidence upload** (thumbnail once attached) — grantable to `platform_admin`. Row actions: Verify / Reject / Reverse, each with a reason-required confirmation — **`platform_owner`-only, never grantable** (§5); a `platform_admin` granted the record-payment capability sees the form but no Verify/Reject/Reverse buttons on any row. |
| `/platform/usage` | A | Per-academy usage bars (§3) vs. plan limits; over-limit rows visually flagged even though this view is informational (enforcement happens at creation time, not here). |
| `/platform/staff` | A + C | **Visible and usable by `platform_owner` only — absent entirely from every `platform_admin`'s nav and every direct URL, regardless of any grant** (staff/grant management is itself permanently owner-only, alongside plan pricing and revenue reports). Account list + permission-grant screen: individual capability toggles **plus preset buttons** above them ("Apply Support preset," "Apply Finance preset," "Apply Onboarding preset," "Apply Technical preset" — UI-only convenience, ticks the same underlying toggles, no separate group concept, no permission-group database model). Plan-pricing, platform-revenue-report, staff/grant-management, and every academy-lifecycle/payment-verification capability (academy registration, approval, activation, suspension, reactivation, cancellation, closure, subscription renewal, and payment verification/rejection/reversal) render as a locked row labeled "Owner only — this permission cannot be granted" (§11.7) wherever they'd otherwise appear as a toggle — never as a toggle. |
| `/platform/reports` | — (custom) | Revenue view with group-by (Month/Plan/Academy/Method) and an explicit visual split between **Collected** (verified payments) and **Expected/Pending** (upcoming renewals not yet paid) revenue; active-academy trend; expiring-subscriptions list. Export button. Entirely absent for `platform_admin` unless individually granted (and the revenue sub-view specifically is never grantable — §5). |
| `/platform/audit-logs` | A | Audit-log-row component (§3); filter by actor/role/action/academy/branch/result/date; Export button. |
| `/platform/settings` | C | Global feature switches, simple toggle form. |

---

## 9. Academy Screens

### 9.1 Dashboard
`/academy/dashboard` — custom layout. Summary cards (active students, staff, upcoming exams, pending approvals, recent payments), alerts ("3 results awaiting your approval"), compact usage indicator (e.g. "82 / 100 students") linking to Settings.

### 9.2 Students & Admissions

**Admissions Officer is branch-limited** (§2.2, §5): every screen below shows only students/admissions belonging to their assigned branch(es), with the persistent "Showing students in: {branch}" scope caption (§2.2) — they never see an "All branches" option and can never view or act on another branch's students, even via a guessed URL (same IDOR protection as Trainer).

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/students` | A | Columns: student ID, name, branch, program/batch, status, enrollment date. Export button (Decision — export scope §11.6). |
| `/academy/students/new` | C | Personal/contact info, branch, initial batch enrollment, documents. Auto-generated Student ID previewed live (`STD-000123` format) with a note: *"Unique within this academy."* Allowance-limit-reached state (§11.2) replaces the Save button if the academy is at its student cap. **No bulk/CSV import anywhere on this screen or any other** (Decision #8) — one student at a time only. |
| `/academy/admissions` | A (board/pipeline variant) | Applied → Documents Pending → Enrolled stages, quick advance action per row. |
| Student Profile `/academy/students/[id]` | B | Tabs: Overview, Enrollment, Documents, Payments/Charges (read summary, links to Finance), Results, ID Card. |

### 9.3 Staff

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/staff` | A | Columns: name, role, assigned branches (chips), status. |
| `/academy/staff/new`, Staff Detail | C / B | Tabs on detail: Profile, Role & Permissions, Branch Assignments (multi-select chips), Course Assignments, Documents. |
| Roles & Permissions (reference view, within Settings or Staff) | — | Read-only matrix mirroring §5 — "Full/Manage/View/Approve/—" badges per role × capability. |
| `/academy/branches` | A + C | Columns: name, code, address, phone, status, staff/student counts. Allowance-limit-reached state on creation past the branch cap. |

### 9.4 Academics

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/programs`, `/academy/courses`, `/academy/batches` | A (hierarchical) | Programs → Courses → Batches. Course creation shows the allowance-limit-reached state (§11.2) past the plan's course cap. Batch detail (B pattern): Overview, Enrolled Students, Trainer Assignment, Timetable entries, Exams. |
| `/academy/timetable` | Custom (weekly grid) | Per branch/batch grid (day × time). "Add Entry" form: batch, day, start/end time, room, trainer. **No attendance/check-in affordance anywhere on this screen or its data model — informational scheduling only** (Decision #21). |

### 9.5 Exams & Results

The result lifecycle is the most workflow-critical part of the product — every screen in this section uses the Stepper component (§3) for `Draft → Marks Entered → Submitted → Under Review → Approved/Rejected → Published`, and the **Published** state always renders the Read-only/locked banner (§3), teal/violet, lock icon.

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/exams` | A + C | List per batch/course + create form (batch, name, max marks, date). |
| Mark Entry (within exam detail) | Custom (spreadsheet-style table) | One row per enrolled student, numeric input, live pass/fail preview from the academy's active grade bands, "unsaved changes" indicator, **"Submit for Review"** distinct from **"Save Draft."** Restricted server-side to the trainer's assigned batches — a Trainer never even sees Mark Entry for a batch they aren't assigned to (item absent, not disabled). |
| Review/Approval (within exam detail) | Approval queue (§3) | Approve/Reject pair, Reject requires a reason; detail view shows marks + the grade-band breakdown used. |
| Publish | Confirmation modal, separate from Approve | Approving finalizes correctness; publishing makes it official and immediately locked (§11.7 wording: *"Published results are locked and cannot be edited directly."*). Two distinct actions/clicks, never combined. |
| Result Correction (from a Published result) | C (modal: original vs. proposed + reason) | The **only** path to changing a published value — routes through the same Approve/Reject queue; the resulting before/after is visible on the result's history via the audit-log row component (§3). |
| `/academy/grades` | A + C | Editable band table (min/max mark, label, pass/fail toggle), **inline** overlap/gap validation as you type — never only on submit. "Submit for Approval" moves Draft → Pending; only an Approved config can become Active. Clear Active/Draft/Pending/Retired badges. |
| `/academy/results` | A | Per batch/exam/student, marks + grade + pass/fail + status badge. |

### 9.6 Finance

*(Charges, manual payments, receipts, income/expenses, approvals — not a general ledger. No online payment entry point exists anywhere in this section — Decision #23; every payment is manually recorded after the fact.)*

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/finance` (dashboard tab) | Custom | Summary cards (outstanding charges, payments this period, income vs. expenses, pending approvals) + simple chart. |
| Charges tab | A + C | Create-charge form (student, description, amount, due date). |
| Payments tab | A + C | Record-payment form (student, charge, amount, method [cash/mobile money/bank transfer], date, notes). |
| `/academy/finance/approvals` | Approval queue (§3) | **Self-approval is visually disabled, not hidden**: if the current user recorded the transaction, their own Approve button is disabled with the tooltip *"You can't approve a transaction you recorded"* (§11.7) — this is the one place a role sees a control they can't use, because omitting it would be confusing on their own submission. |
| Receipts | Document-style card, not a table row | Academy name/logo, student, amount, method, date, receipt number — printable/downloadable layout. |
| Income/Expenses tabs | A + C | Same approve/reject pattern as Payments; Expense "Submit for Approval." |
| Reversal/Adjustment | Confirmation modal (reason required) | Never a delete. Produces a new linked row shown as *"Reversal of #1234"*; the original stays visible, marked "Reversed," never removed (§11.7). |
| Finance Reports | Custom + export | Date/branch/status/method filters. **Never shows a subscription-payment row** — this view is exclusively student/academy-side money; platform SaaS billing has no presence here at all. |

### 9.7 Certificates and IDs

| Screen | Pattern | Notes |
|---|---|---|
| `/academy/certificates` | A + C | Issue form; Cancel action (reason required, confirmation). |
| Certificate Verification (internal lookup) | Custom | Read-only detail identical in content to the public page (§10) but reachable from inside the app for staff use. |
| `/academy/id-cards` | Custom (card preview) | Visual card layout matching real ID-card proportions (photo, name, ID, branding, issue/expiry); Generate/Print/Reprint actions; reprint-count/history note. |

### 9.8 Notifications

`/academy/notifications` — list pattern (A) with read/unread filter, mark-as-read (single/bulk), type icon per row (success/error/warning/info/**security**). Notification bell dropdown (desktop) / full-screen (mobile) mirrors the same list, condensed.

**Event catalog** (the complete set — nothing trimmed, per Decision #20): academy onboarding, activation, suspension, expiry reminder, renewal, result/finance approvals, receipts, results published, certificates issued/cancelled, and **security** (new-device sign-in). All templates are **fixed and code-defined** — there is no template editor anywhere in the product (Decision #17), so no screen in this spec offers one.

Notification preference toggles live in `/academy/settings` (§9.11): optional event types get a normal toggle; mandatory ones (e.g. suspension, security alerts) render as a **disabled, always-on toggle** labeled *"Required — cannot be turned off"* (§11.7) — never a togglable-looking control that silently does nothing.

### 9.9 Reports

`/academy/reports` — hub with Student/Academic/Finance sub-views, each: filter bar + table + a simple chart only where the data is genuinely aggregate/trend (pass/fail rate, enrollment trend, income vs. expense) — chart never replaces the table. Export button (§11.6 scope).

### 9.10 Audit Log

`/academy/audit-logs` (Owner/Admin only — Decision #18; absent entirely from every other role's nav, per §5). Identical audit-log-row component (§3) to the platform version, hard-scoped to this academy — never accepts or displays another academy's rows even via a guessed URL. Export button.

### 9.11 Settings

| Sub-section | Pattern | Notes |
|---|---|---|
| Academy Profile | C | Full field set (name, type, address, phone, email, website, logo, registration number, primary contact). **Saves directly — no approval step, no "pending change" state** (Decision #14). |
| Usage | Custom | Usage-vs-allowance bars (§3) for every capped resource, own-academy view. |
| Branch Settings | C | Per-branch address/phone/status. |
| User/Staff (personal) Settings | C | Name/contact for the logged-in user; Security sub-tab is `/account/security` (§7), not duplicated here. |
| Role/Permission (reference) | Custom | Same matrix as §9.3, read-only reference. |
| Grade-Band Settings | — | See §9.5 `/academy/grades` — same screen, not a duplicate. |
| Notification Settings | C (toggle list) | Per §9.8. |

---

## 10. Public Screens

`/verify/[certificateCode]` — unauthenticated, no app chrome, no navigation. Shows only: student name, program, issue date, valid/cancelled status. Rate-limited per IP.

**Works identically whether the issuing academy is open, suspended, or permanently closed** (Decisions #3, #4, #6) — closure never deletes or hides the underlying record, so this page carries **zero** academy-status messaging of any kind; a closed academy's certificate looks exactly like any other valid certificate's verification result. This is a deliberate, tested distinction: closure affects the academy's own console, never the public verification surface.

---

## 11. Cross-Cutting UX Rules & Copy Library

### 11.1 Subscription Lifecycle & Academy Access States

Displayed status is **always derived** from `academy_subscriptions.status` plus the separate `academies.closed_at` flag — there is no independent academy-level status anywhere in the UI or its underlying data (Decisions #1, #2). The derived label a user sees:

| Underlying state | Displayed badge | Access | UI copy example |
|---|---|---|---|
| `Draft` / `Trial` | Trial / Draft (gray/blue) | Full (trial) or none yet (draft) | — |
| `Active` | Active (green) | Full | — |
| `Past Due`, day 1–7 | Past Due — grace period (amber) | Full, with a persistent banner | *"Past Due — 5 days remaining in grace period."* |
| `Past Due`, day 8+ (lazily flips to Suspended) | Suspended (red) | Blocked | *"Access suspended because the grace period has ended."* |
| `Suspended` | Suspended (red) | Blocked | *"Your academy's subscription is currently suspended. Contact the platform owner to reactivate."* |
| `Cancelled` / `Expired` | Cancelled / Expired (red) | Blocked | — |
| `closed_at` set (any prior state) | **Closed** (muted slate, archive icon) | Permanently read-only; **overrides every other state** | *"This academy has been permanently closed. Historical data is retained as read-only."* |

The Closed state is visually and textually distinct from Suspended everywhere it can appear (§1 palette) — a viewer must never be able to mistake "temporarily blocked, can be fixed" for "permanently archived." **A closed academy offers no Reactivate control anywhere in the Platform Owner console** (Decision #5) — `/platform/academies/[id]` shows Close as one-way; there is no "Reopen" button because `PLAN.md` defines none.

### 11.2 Allowance-Limit States

A specific, reused variant of the blocked/error state (§3.1), never a generic error, shown on the relevant create form/button the instant an academy is at its plan limit for that resource (branches/students/staff/courses/storage — Decision #9, hard block, no warn-only mode):

> *"You've reached your plan's limit of 100 students."*

For Owner/Admin, this message includes a link to the Usage view (§9.11). The client-side "N remaining" display (usage bar) is informational only — the actual block is enforced server-side and the UI simply reflects the rejection.

**Downgrade-blocked** (Decision #10) is a distinct confirmation-dialog variant on `/platform/academies/[id]`, shown when a plan change would put current usage over the target plan's limits — never a plain yes/no confirm:

> *"Downgrade blocked: 124 students exceed the target plan's limit of 100."*

### 11.3 Onboarding Checklist

A widget on `/platform/academies/[id]` listing preconditions (profile complete, plan selected, approved, first payment recorded) with check/cross icons; the Activate button stays disabled with a tooltip until every item is satisfied — never silently clickable-but-failing.

### 11.4 Approval / Self-Approval Rule

Wherever an approval queue exists (results, grade configs, student payments, expenses), the submitter's own item shows their Approve control **disabled** with a tooltip, never hidden — because on their own submission, an absent button would look like a bug rather than a rule:

> *"You can't approve a transaction you recorded."*

### 11.5 Renewal UX

`Renew` is offered only where `PLAN.md`'s `renewSubscription` rule permits it: from `Active`, `Past Due`, `Suspended`, or `Expired`. It is **never offered from `Draft`/`Trial`** (those convert via Activate) or from `Cancelled` (final — a new subscription must be registered instead). The Renew action is disabled with a tooltip if no verified payment exists yet for that subscription:

> *"Renewal requires a verified payment. Record and verify a payment first."*

Renewing from `Past Due`, `Suspended`, or `Expired` reactivates the academy **in the same action** — the UI never presents a separate "now click Reactivate" step after a successful renewal; the subscription's status badge flips straight to Active and the academy's own `/academy/dashboard` becomes reachable immediately.

### 11.6 Export Scope

CSV export appears **only** on: Reports (platform + academy), the Student list, Finance screens, and Audit Logs (platform + academy) — Decision #10, this is the complete export surface for MVP. No other table in the product offers an export button. An export always returns exactly the rows the on-screen list/report shows for that user's role and branch scope — never more.

### 11.7 Consequential-Action Copy Library

| Action | Confirmation copy |
|---|---|
| Close Academy | *"This will permanently close [Academy]. All historical data is retained as read-only and can never be un-closed. This is different from suspending or cancelling — it cannot be reversed."* |
| Cancel Certificate | *"Cancelling this certificate will mark it invalid on public verification. This cannot be undone."* |
| Reverse Transaction | *"This creates a new reversal entry linked to the original — the original record is never deleted."* |
| Publish Results | *"Published results are locked and cannot be edited directly. Corrections after publishing require a separate approval."* |
| Self-approval block | *"You can't approve a transaction you recorded."* |
| Owner-only capability | *"Owner only — this permission cannot be granted to Platform Administrators."* |
| Reject (any queue) | Reason field required — no reject without a stated reason. |

### 11.8 Auth Copy

- Invalid login: *"Invalid email or password."* (identical whether the email exists or not)
- Password-reset request: *"If that email exists, a reset link has been sent."* (identical either way)
- Suspicious login notification (Decision #15 — new IP/user-agent combination only, no geolocation): *"New sign-in from a device we haven't seen before."*

---

## 12. Responsive Behavior Summary

Desktop/laptop (≥1280px) is the primary target for dense data entry (mark entry grids, finance tables, audit logs). The following must remain **fully usable on mobile** even though they're desktop-optimized in general:

- Login, MFA challenge, password reset
- Approval queues (a manager approving a result or payment from a phone)
- Student lookup and payment lookup (search + detail view)
- Result review (read the marks/grade-band breakdown, approve/reject)
- Notifications (bell + full list)
- Session management (`/account/security`)
- Any single quick action reachable in ≤2 taps from the mobile dashboard

Mark entry (spreadsheet-style grids), bulk financial review, and multi-column reports are desktop-oriented by design — mobile renders them but doesn't optimize layout beyond the standard stacked-table pattern (§2).

---

## 13. Out of Scope — No Screens Exist For

Attendance tracking/reports; a student self-service portal or login; an online/automated SaaS subscription checkout or payment-gateway webhook UI; a full accounting/general-ledger interface; payroll; inventory; library management; a full LMS/video-learning/course-player interface; native mobile app screens; an advanced CRM/sales-pipeline interface; bulk/CSV student import; a notification-template editor; any in-product support-ticketing or contact-form feature; refunds as a distinct concept (a refund is a reversal, per `PLANNING_GAPS_RESOLUTION.md` §6); financial-period closing; certificate reissuance as a distinct feature (no "Reissue" screen or action anywhere — a certificate is re-viewed/re-downloaded from its existing, immutable record); GDPR-style data erasure / right-to-be-forgotten; virus/malware scanning on uploads (deferred to the hosting decision). Matches `PLAN.md`'s "Explicitly Out of Scope" list exactly — nothing added, nothing removed.
