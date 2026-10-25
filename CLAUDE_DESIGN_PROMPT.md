# Dardar School System — Design-to-Implementation Handoff

This document has two parts for two different readers.

**Part A** (the fenced block below) is a self-contained Claude Design prompt — paste it as-is into Claude Design if you want fresh visual mockups. It does not reference any external file, mockup, screenshot, or prior conversation.

**Part B** (after the fence) is the **implementation handoff** — written for whoever builds or modifies screens directly in this existing Next.js/TypeScript/Tailwind codebase at `C:\acad\academy`. It is not meant to be pasted into an image-generation tool; it names real files, server actions, and database rules. Read Part B before changing any Platform Console screen — it consolidates everything verified about the real, already-built application (previously spread across the now-removed `design-briefs/PLATFORM_DESIGN_SPEC.md`) alongside the authoritative `PRODUCT.md`/`PLAN.md`/`DESIGN.md`.

**Important correction to how this handoff came about**: no new screen mockups were actually produced by Claude Design in this project. The `/design-sync` run that created the "Dardar School System" Claude Design project (`https://claude.ai/design/p/efb1902e-7e4e-4821-b36e-94a49c331df9`) synced only the existing **component library** (59 real React components + design tokens) so that any *future* Claude Design session builds with real parts — it did not generate page designs. The "approved designs" an implementation agent should build toward are therefore the **real, already-shipped application screens** described in `DESIGN.md` §6–§10 and, for the Platform Console specifically, the verified page-by-page detail in Part B §11 below — not a set of Claude Design screen mockups, which do not exist. If actual Claude Design screen mockups are produced in the future, they should be reviewed against Part B's verified business rules before being treated as implementable, per Part A's own "never invent" instructions.

---

```
Design a complete, premium, production-ready visual system for Dardar School System (compact form: Dardar), a multi-tenant Academy Management SaaS built with Next.js, TypeScript, React, Tailwind CSS, and PostgreSQL. This is a redesign of an existing, fully-built product with roughly 60 screens already in production use — not a concept pitch for a new product. Design the ENTIRE application, not only the dashboard or a handful of representative screens. Everything you need is in this prompt; do not assume access to any other file, image, or conversation.

═══════════════════════════════════════
PRODUCT SCOPE
═══════════════════════════════════════
Design the complete experience for:
1. Public marketing and certificate verification pages.
2. Login, password reset, email-address-change verification (not an initial signup-verification flow — this product has none), MFA setup, MFA challenge, and recovery codes.
3. Account security, active sessions, and personal activity history.
4. Academy dashboard and the complete academy-management console.
5. Students, admissions, staff, branches, programs, courses, batches, timetables, and books.
6. Examinations, marks entry, grade bands, approval workflows, published results, and corrections.
7. Finance, charges, payments, income, expenses, receipts, reversals, fee periods, and financial reports.
8. Certificates, printable PDFs, student ID cards, notifications, and audit logs.
9. Academy profile, usage, notification preferences, and settings.
10. Platform administration, including academy registration and management, subscriptions, plans, payments, usage, platform staff, reports, audit logs, and global settings.
11. Responsive layouts and interaction states for desktop, tablet, and mobile.

Dardar School System serves two structurally separate audiences that never share a navigation tree or a login flow: Platform Owner/Administrator users (manage academies, subscriptions, plans, platform-wide billing) and Academy users — Owner, Admin, Manager, Admissions Officer, Finance Officer, Trainer (run day-to-day academy operations). Which console renders is determined entirely by account type, never a user-facing toggle.

Tone: calm, modern, premium, clean, trustworthy, professional — a serious operations console for a real academy-management business, not a marketing site, consumer app, or prototype toy. Prioritize clear hierarchy, readable data tables, useful dashboards, and efficient workflows. Avoid unnecessary decoration, oversized empty areas, childish illustrations, gamification, confetti, mascots, and dark mode.

Do not invent or add: attendance tracking, a student self-service portal or student login, online/automated payment checkout, bulk/CSV data import, a notification-template editor, or any other functionality not explicitly described in this prompt. Use realistic fictional sample data (names, amounts, dates) throughout every mockup. Never imply the design prototype is connected to live customer data or a real database.

═══════════════════════════════════════
VISUAL DESIGN SYSTEM — DEFINE COMPLETELY BEFORE DESIGNING ANY SCREEN
═══════════════════════════════════════

Color tokens (use exactly these values — Dardar School System brand):
- Primary burgundy: #850019 — primary buttons, links, active navigation states, focus rings, navigation-emphasis surfaces (e.g. a dark sidebar). This is the single primary brand hue; there is no separate navy.
- Primary hover/pressed: #6B0014 — darker burgundy for hover/pressed states and gradient endpoints.
- Brand tint: #F9E8EC — light burgundy wash for selected/active backgrounds and subtle highlight surfaces.
- Accent gold: #F5B638 — sparing use only (highlights, accents, a thin decorative line). Never use as a background behind white/light text, and never as small text color on a light surface. Always pair with dark ink text (#111827) when gold is a background, or use gold text/icons only on the dark burgundy surface.
- Application background: #F7F8FA
- Surface (cards, panels, modals): #FFFFFF
- Border: #E2E5EA
- Strong border (dividers, table header underline, input focus outline base): #CBD5E1
- Muted text (captions, secondary labels, placeholder text): #6B7280
- Primary text: #111827

Status colors — six tones, one meaning each, always paired with an icon and a text label, never color alone:
- Gray — draft, neutral, archived, withdrawn.
- Amber — pending, awaiting approval, suspended, unpaid, low stock.
- Green — approved, active, paid, verified, in stock.
- Red — rejected, cancelled, overdue, error, out of stock.
- Blue — informational.
- Slate — reversed, closed. Deliberately duller than gray; must read as permanently inert (e.g. a closed academy or a reversed transaction).
- Teal/violet (a seventh tone, define its own hex values consistent with the palette above) — reserved strictly for "published / finalized / locked" states, such as a published exam result. It must be visually distinct from both green and slate, so "locked because finalized" is never confused with "locked because archived or reversed."

Typography:
- Alexandria for all UI text (labels, body copy, headings, table content, buttons).
- JetBrains Mono strictly for fixed-width technical identifiers (record IDs, certificate/reference codes, audit-log technical fields). Never use it for money, names, or prose.
- Money values use tabular (fixed-width) numerals in Alexandria, right-aligned in table columns, $-prefixed, two decimal places — never in the mono font.
- Type scale, largest to smallest: page title, section header, table header / form label, body text, caption / helper text. KPI numbers on dashboards get their own distinct large, tight, tabular-numeral treatment, visually heavier than any other type level.

Spacing scale: 4px base unit — use 4, 8, 12, 16, 24, 32, 48, and 64px increments for all padding, margins, and gaps. Do not use arbitrary off-scale values.

Radius:
- 8px — all form controls, inputs, buttons, small chips.
- 12px — cards, panels, and modals.
- Full pill radius — status badges and avatar/initial chips.

Elevation and shadows (three tiers only):
1. Rest — a flat 1px border plus a faint ambient shadow on cards and panels.
2. Hover / interactive — a slightly stronger shadow than rest, used on hoverable cards, rows, and buttons.
3. Overlay — the strongest shadow tier, reserved for modals, dropdowns, and popovers only.
Do not introduce a fourth, heavier shadow tier anywhere.

Component dimensions (apply consistently everywhere a component repeats):
- Standard button / input height: 40px. Compact variant (dense toolbars only): 32px.
- Icon-only buttons: minimum 40×40px hit target on desktop, minimum 44×44px on touch/mobile.
- Status badges / pills: 24px height, 8–12px horizontal padding, pill radius.
- Avatar / initials chips: 32px diameter in lists, 40px on detail-page headers.
- Table row height: 48px standard; 56px when a row contains an avatar or two lines of content.
- Modal widths: 480px for confirmation dialogs, 640px for standard forms, 960px for multi-section or stepper flows.
- Sidebar: 240px expanded, 64px collapsed icon-rail.

Interaction and motion behavior:
- Hover: cards and rows elevate to the hover shadow tier; buttons darken the primary burgundy to the #6B0014 hover token.
- Focus: every interactive element shows a visible 2px solid burgundy focus ring with a small offset — no exceptions, this is a hard accessibility floor.
- Disabled: 40% opacity, "not-allowed" cursor; when disabled specifically because of a role/permission rule (see Business Rules below), always pair with an explanatory tooltip on hover/focus.
- Links underline on hover only, not at rest.
- KPI numbers count up to their real value once on first render only (not on every re-render).
- Cards and sections stagger in with a brief fade-up on first page load only, roughly 40–60ms stagger per item — never repeating on routine interaction.
- Modals/dialogs scale and fade in at roughly 180ms, and close faster, at roughly 120ms, so closing feels instant.
- Charts draw in once on first render only.
- Every animation must have a reduced-motion-safe equivalent: skeletons become static, transitions are removed outright rather than merely shortened, for users with reduced-motion preferences enabled.

Brand mark: the real Dardar "D" mark — a burgundy speed-line flourish into a bold "D," with two gold accent speed-lines — supplied as two fixed-color transparent PNG source assets (`public/dardar-mark.png`, compact, ~1.93:1 aspect ratio; `public/dardar-logo.png`, full lockup with "DARDAR SCHOOL SYSTEM" wordmark beneath, ~1.36:1 aspect ratio) and already integrated into the live app. This is the approved, final logo — do not redesign, re-draw, recolor, or substitute a different mark concept. A fresh Claude Design pass may only define new *compositions* using these exact source images (sizing, placement, surrounding space, backdrop treatment), never new artwork.

═══════════════════════════════════════
COMPONENT SYSTEM — DEFINE ONCE, REUSE EVERYWHERE
═══════════════════════════════════════
Before designing any individual screen, fully define the following shared components, each used identically everywhere it appears across both consoles:

- Status badge — pill shape, icon + label + one of the seven status colors above.
- Usage/allowance bar — green under 80%, amber 80–99%, red at or above 100%; always names the resource it measures (e.g. "Students: 340 / 500").
- Data table — sticky header row, a filter bar with removable filter chips, 1–2 inline row-action icons (an overflow menu once there are 3 or more), pagination reading "Showing X–Y of Z," and an Export action reserved exclusively for Reports (platform + academy), the Student list, Finance screens, and Audit Logs (platform + academy) — this is the complete, closed export surface; no other table anywhere in the product gets an Export button.
- Form — labels always visible above their field (never placeholder-as-label), inline validation triggered on blur, currency fields $-prefixed with two decimals and right-aligned tabular numerals.
- Modal / confirmation dialog — a plain, simple dialog for reversible actions; for one-way/destructive actions, strong and specific wording that names the exact record and the exact consequence — never a bare "Are you sure?"
- Toast — bottom-corner, auto-dismissing, used for success confirmations only.
- Persistent page-level banner/alert — non-dismissing, used for page-level states such as a suspended or closed academy, a permission-denied view, or an incomplete-onboarding state.
- Tabs — for multi-section detail pages.
- Stepper — for multi-step forms and the exam-result lifecycle (Draft → Marks Entered → Submitted → Under Review → Approved/Rejected → Published).
- Approval queue row — an Approve/Reject action pair; Reject always requires a typed reason; a user's own submission shows Approve in the disabled-with-tooltip state rather than hidden, per the self-approval rule below.
- Permission-locked control — a visibly present but disabled control with an explanatory tooltip, reserved narrowly for the self-approval case and for permanently owner-only capabilities; everywhere else, an action a role cannot perform is simply absent, not shown disabled.
- File upload / drop zone — thumbnail or filename preview, remove/replace actions, inline type/size validation, and a storage-allowance check where relevant.
- MFA code input — six individual digit boxes with auto-advance, plus a distinct "use a recovery code instead" link.
- Audit-log row — expandable, showing actor, role, action, target, branch, a result status badge, and a timestamp; expands to show a before/after comparison. Identical component on both consoles.
- Locked/read-only banner — two visually distinct variants: a teal/violet "Published" banner with a lock icon, and a slate "Closed/Archived" banner with an archive icon. These must never be visually confusable with each other.
- KPI stat card — icon, a large tabular-numeral value, an optional real period-over-period delta, and the count-up entrance behavior defined above.
- Empty state — an icon, one line of explanatory text, and a primary action when one applies.
- Inline error message — specific and actionable, never a generic "Something went wrong."
- Skeleton loading state — shaped to match the real content it is replacing; reserve a full-page spinner only for initial app load and authentication screens.
- Breadcrumbs — reserved for genuinely three-or-more-level-deep routes only; use a simple back-link for one- or two-level detail pages instead.
- Line/area trend chart and a grouped comparison bar chart, each with a legend.

═══════════════════════════════════════
SCREEN INVENTORY — ORGANIZE AND DESIGN IN EXACTLY THESE EIGHT PHASES, IN ORDER
═══════════════════════════════════════
Work through the phases in order. Maintain a running checklist of every screen listed below, and mark each one, by the end, as designed, intentionally shared with another screen (and state which), or deferred with a stated reason. Do not silently omit or merge distinct screens into generic mockups.

PHASE 1 — Brand system, design tokens, shared components, and application shells
- The full token and style guide defined above (color, typography, spacing, radius, elevation, motion) presented as a reference sheet.
- The complete component library defined above, presented as specs with all states shown (default, hover, focus, disabled, error, loading, empty), not just a single static mockup per component.
- Academy application shell: a collapsible icon-rail sidebar with both expanded and collapsed states (including hover/focus tooltips on the collapsed rail), a mobile slide-in drawer, and a header containing the academy name, a branch/context control (functional selector for academy-wide roles, a locked read-only label for branch-limited roles), a notification bell with an unread-count badge, an account/role chip, and a working search affordance.
- Platform administration shell: the same underlying component system as the Academy shell, but with a subtle distinguishing accent treatment so the internal operator console is never visually confused with an academy's own console.
- Design the pre-authentication screens (Phase 7) on this exact same token and component system — there must be no second, visually different design language anywhere in the product.

PHASE 2 — Academy and platform dashboards
- Academy dashboard: a KPI row (Total Students, Staff, Upcoming Exams, Pending Approvals, Outstanding Charges, Payments Collected), followed by a two-column layout — left column: a Recent Payments table with avatar-initial chips; right column: a "Requires Attention" panel of colored-left-accent alert cards (icon + label + one line + an inline action button) covering outstanding fees, pending approvals, and upcoming items — followed by an enrollment trend chart and a compact usage-vs-allowance panel.
- Platform dashboard: a KPI row (Total Academies, Pending Approvals, Expiring Subscriptions, Total Collected/Expected), an active-academies trend chart, a pending-approvals table, an expiring-subscriptions table with days-remaining badges, and a recent-payments table, using the same two-column discipline wherever it improves scannability.

PHASE 3 — Students, admissions, staff, branches, academics, timetables, and books
- Student list (search/filter, status badges, Export).
- Student registration (full-page multi-field form).
- Student profile (tabs: Overview, Enrollment, Documents, Payments/Charges, Results, ID Card).
- Admissions pipeline (a board/stage view: Applied → Documents Pending → Enrolled).
- Staff list, staff registration, staff detail (tabs: Profile, Role & Permissions, Branch Assignments, Course Assignments, Documents), and a read-only role/permission reference matrix.
- Branches list plus create/edit.
- Programs → Courses → Batches hierarchy, each with a list plus create/edit screen; batch detail (tabs: Overview, Enrolled Students, Trainer Assignment, Timetable entries, Exams).
- A weekly timetable grid plus its print view — purely informational scheduling, with no attendance/check-in affordance anywhere.
- Books catalogue (list plus create/edit, including a cover-image field), stock levels, and book sales (list plus a record-sale flow with its own payment and receipt screens).

PHASE 4 — Exams, mark entry, grading, approvals, publishing, and corrections
- Exams list plus a create-exam form.
- Mark entry: a spreadsheet-style grid, one row per student, a live pass/fail preview computed from the active grade bands, and a clear distinction between "Save Draft" and "Submit for Review."
- A review/approval queue (Approve/Reject, with a required reason on reject).
- Publish — a separate, distinct confirmation step from Approve. Publishing locks the result and displays the teal/violet locked banner defined above.
- Result correction — a modal showing the original value versus the proposed value plus a required reason; this is the only path to changing a value after it has been published.
- Grade bands editor, with inline overlap/gap validation as the user types, and Draft → Pending → Active states.
- A results list, viewable per batch, per exam, and per student.

PHASE 5 — Finance, payments, receipts, reversals, and reports
- A finance dashboard tab (summary cards plus a simple chart).
- A charges tab with a create-charge form.
- A payments tab with a record-payment form that posts directly with no approval step.
- Receipts rendered as a document-style printable card (academy name/logo, student, amount, method, date, receipt number) rather than a table row.
- An income tab with a create-income-record form, also with no approval step.
- An expenses tab with a create-expense form that requires "Submit for Approval"; the approval queue is retained here, and self-approval is allowed for the roles defined in the Business Rules section below.
- A reversal/adjustment flow — a confirmation modal with a required reason, producing a new, clearly linked "Reversal of #X" record while the original stays visible and marked "Reversed."
- Finance reports with filters and export; these must never display subscription-level payment rows.
- A fee periods screen.

PHASE 6 — Certificates, ID cards, notifications, audit logs, and settings
- Certificates list with an issue form and a cancel action requiring both a reason and a confirmation step.
- A certificate print/PDF view.
- A public, unauthenticated certificate-verification page with zero application chrome, showing only the student's name, program, issue date, and valid/cancelled status. This page must carry zero academy-status messaging — a certificate from a suspended or closed academy must look identical to any other valid certificate on this page.
- ID cards: a visual, card-proportioned preview (photo, name, ID number, branding, issue/expiry dates), with Generate/Print/Reprint actions and a reprint-history note.
- A notifications list (read/unread filter, bulk mark-as-read, a distinct icon per notification type including a dedicated "security" type) plus a compact bell dropdown with a "View all" link.
- Audit logs for both the Academy and Platform consoles, using the identical expandable-row component, filterable by actor, role, action, entity, and date, with Export.
- Settings: Academy Profile (including a logo-upload drop zone), Usage (allowance bars per resource), Branch settings, a pointer to personal account settings, and Notification preference toggles — optional preferences are togglable, mandatory ones are shown as an always-on, disabled toggle labeled "Required — cannot be turned off."

PHASE 7 — Authentication, MFA, account security, and all platform administration screens
- Login: email and password fields, a generic "Invalid email or password" error (never revealing which field was wrong), a rate-limited lockout state, and routing of Platform Owner accounts to an MFA challenge instead of a direct session.
- Forgot password (a single email field with a neutral "if that email exists" confirmation message) and reset password (new password plus confirmation, an "at least 8 characters" hint, and an expired-token state).
- MFA setup, forced on a Platform Owner's first login: a QR code plus a manual fallback code, a six-digit confirmation step, followed by a one-time recovery-codes reveal with an explicit "these won't be shown again" warning and a checkbox confirming the codes were saved.
- MFA challenge, shown on every subsequent Platform Owner login: a six-digit code input plus a "use a recovery code instead" link, with the same lockout/error treatment as login.
- Recovery-codes regeneration, requiring re-confirmation before showing the same one-time reveal pattern.
- Account security page: an active-sessions list (device, browser, IP, last-active time, a per-row Revoke action, and a "sign out everywhere else" action), plus an MFA sub-section for Platform Owner accounts.
- A personal account-activity log page.
- An email-address-change verification screen (not a signup-verification screen — none exists in this product).
- Platform academies list; academy registration as a multi-step flow (profile → owner account → default branch → plan and allowances → subscription dates → review); academy detail (tabs: Overview including an onboarding-checklist widget, Branches, Subscription & Plan, Usage vs. Allowances, Payment History, Audit Log), with Approve/Activate/Suspend/Reactivate/Cancel/Close actions visible only to Platform Owner accounts.
- Subscriptions list with derived status badges including a grace-period countdown and a Renew action.
- Plans (list plus create/edit, with a "Retire" action rather than delete).
- Platform payments (a record-payment form plus Verify/Reject/Reverse row actions, using the same reason-required and confirmation patterns defined above — never a native browser prompt for reason capture).
- Usage (per-academy allowance bars).
- Platform staff (an account list plus a permission-grant screen with individual toggles and convenience preset buttons; permanently owner-only rows are shown in the locked, disabled-with-tooltip state).
- Platform reports (revenue by a chosen group-by dimension, with a Collected-vs-Expected split).
- Platform settings (global feature-switch toggles).

PHASE 8 — Responsive variants, loading states, empty states, errors, confirmation dialogs, accessibility, motion, and final consistency review
- Produce explicit mobile and tablet variants for: Login, MFA challenge, password reset, approval queues (reviewing and approving from a phone), student/payment lookup, result review, notifications, account security, and any single quick action reachable within two taps from the mobile dashboard. Treat desktop widths of 1280px and above as the primary target for every other screen. The sidebar collapses into the mobile drawer below 1024px — design specifically for that single breakpoint rather than a three-tier system. Tables degrade to a stacked card-per-row layout on mobile rather than horizontal scrolling.
- Show meaningful loading states (the skeleton pattern defined above) for every data-bearing screen, not just a spinner.
- Show the empty-state pattern defined above anywhere a list, table, or panel can legitimately have zero items.
- Show realistic inline error states for every form and action that can fail.
- Confirm every status or state shown anywhere in the product pairs a color with both an icon and a text label — never color alone.
- Confirm the teal/violet "Published" banner and the slate "Closed/Archived" banner remain unmistakably distinct from one another, including in any screen where both could plausibly appear.
- Run a final consistency review across every phase above: confirm one token set, one component language, and one motion language were used throughout, including the former pre-authentication screens, and explicitly call out and correct any screen that drifted from the system.
- Produce a final, complete screen-inventory checklist confirming the status (designed / intentionally shared / deferred-with-reason) of every single screen named across Phases 2 through 7.

═══════════════════════════════════════
BUSINESS LOGIC AND SECURITY RULES — PRESERVE IN EVERY SCREEN
═══════════════════════════════════════
- The Academy console and the Platform console always have separate navigation structures; never design a blended or switchable navigation tree between them.
- An action a user's role cannot perform is simply absent from the screen, not shown disabled — with exactly two exceptions: self-approval of one's own submission, and capabilities that are permanently restricted to the Platform Owner role. In both of those cases, show the control in a visible, disabled state with an explanatory tooltip.
- Branch-limited roles (such as Admissions Officer and Trainer) never receive an unrestricted "all branches" selector; they see their single branch as a locked, read-only label, and every branch-scoped list carries a persistent caption such as "Showing X in: {branch name}."
- Student payments and income records post directly with no approval step. Expenses retain a required approval step; self-approval of one's own expense submission is allowed only for the roles who hold that permission, and is shown using the permission-locked control pattern defined above rather than being hidden.
- Financial corrections are always handled through a reversal that creates a new, clearly linked record — never through deleting or silently editing the original financial record, which remains visible and marked "Reversed."
- Publishing an exam result is a distinct action from approving it, and must clearly communicate the resulting locked state using the teal/violet locked-banner pattern.
- Every destructive or one-way action (closing an academy, cancelling a certificate, reversing a transaction, publishing a result) requires a specific confirmation dialog that names the exact record and the exact consequence of proceeding — never a generic "Are you sure?"
- The public certificate-verification page must never expose an academy's suspension or closure status; a certificate from a closed or suspended academy must look identical there to any other valid certificate.
- Do not design or imply: attendance tracking, student self-service login, an online/automated payment checkout flow, bulk CSV data import, a notification-template editor, dark mode, or any gamified or celebratory UI element anywhere in the product.
- Use realistic fictional sample data throughout every screen. Never imply that the design prototype is connected to live customer data.

═══════════════════════════════════════
EXECUTION INSTRUCTIONS FOR CLAUDE DESIGN
═══════════════════════════════════════
1. Design the complete application as specified above, not only a few representative screens.
2. Work through all eight phases in the exact order given.
3. Maintain a running checklist of every screen required by this prompt, and mark each one as designed, intentionally shared with another screen (stating which), or deferred with a stated reason — never silently skipped.
4. Fully establish the shared design system and component library (Phase 1) before designing any individual page.
5. Produce realistic desktop layouts for every screen, plus the specific mobile and tablet variants required in Phase 8.
6. Show meaningful interaction states (hover, focus, disabled, error, loading, empty, success) for every component and screen, not only static single-state screenshots.
7. Keep every design decision implementable in a production stack of Next.js, React, TypeScript, and Tailwind CSS — nothing that would require a different rendering engine, animation library, or design-token pipeline than that stack already supports.
8. Finish with the complete screen-inventory checklist described in Phase 8, plus the final cross-phase consistency review.

═══════════════════════════════════════
DELIVERABLES AND ACCEPTANCE CRITERIA
═══════════════════════════════════════
Produce, in this order: (1) the full token and style guide plus the complete component library as specs; (2) both application shells in their expanded, collapsed, and mobile states; (3) every screen listed in Phases 2 through 7, desktop-first, with the specific mobile/tablet variants required by Phase 8; (4) the final screen-inventory checklist with an explicit note on anything intentionally merged or deferred, and why.

A design is acceptable only if: it uses exactly one token set and one component language across all eight phases, with no second visual language anywhere, including the former pre-authentication screens; every status or state pairs a color with an icon and a text label; every role-gated action is either absent or shown disabled-with-tooltip per the rules above, never a plain grayed-out control with no explanation; every destructive action's confirmation names the specific record and the specific consequence; and the entire system is expressible using Tailwind CSS classes, standard CSS transitions and keyframes, and React component props.
```

---

# Part B — Implementation Handoff (for building in the existing application)

**Audience**: an implementation agent working directly in `C:\acad\academy`. **Ground rule, non-negotiable**: work in the existing application. Reuse `app/academy/_shell/ui.tsx`, `app/academy/_shell/icons.tsx`, `components/ui/*`, and `lib/ui/theme.ts`/`app/globals.css` exactly as they exist today. Preserve all business logic, database schemas, server actions, permission checks, and tests. Do not rewrite a working screen from scratch to match Part A's aesthetic — apply the Dardar visual tokens (already live in the codebase as of this session's color rebrand — see §2 below) and close the verified gaps listed in §10/§11; do not invent new architecture to do it.

Every fact below is sourced from one of: `PRODUCT.md`, `PLAN.md` (sole authority on data model/server actions/business rules — wins over `DESIGN.md` on conflict), `DESIGN.md` (authoritative on UI/UX), or direct code reads performed during this session (cited by file). Where a source is silent, incomplete, or self-contradictory, that is stated explicitly — nothing below is invented to fill a gap.

## B1. Product purpose and target users

Dardar School System is a multi-tenant academy-management platform for skills-training academies in Somalia, replacing spreadsheets/paper/WhatsApp coordination with one system covering admissions, timetabling, exams/results, certificates, and finance (`PRODUCT.md`). Two audiences, structurally separate, never sharing a nav tree or login flow (`DESIGN.md` §2.1):
- **Academy users** (six roles: Owner, Administrator, Manager, Admissions Officer, Finance Officer, Trainer) run one academy's day-to-day operations.
- **Platform users** (Platform Owner, Platform Admin) operate Dardar School System itself — approving/activating/suspending academies, managing plans, verifying subscription payments across every tenant.

Positioning: built around cash/mobile-money payment (no card/online-gateway checkout anywhere), English/USD, Somalia market conditions — not a generic Western SaaS template (`PRODUCT.md`). No pilot academies, testimonials, or benchmarks exist yet — never fabricate these in any screen or copy.

## B2. Brand tokens, typography, spacing, accessibility (status: already implemented)

Part A's Dardar burgundy/gold token set is not merely "approved" — it is **already live in the codebase** as of this session: `app/globals.css`'s `@theme` block and `lib/ui/theme.ts`'s `color` object both carry the real values (`#850019` primary, `#6B0014` hover, `#F9E8EC` tint, `#F5B638` accent gold), and every shared component that reads those tokens picks them up automatically. Do not re-derive or re-apply these tokens — they are the current state, not a target.

**Flag, do not silently resolve**: `PRODUCT.md` §"Brand Commitments" still states *"No logo, color palette, or typography has been confirmed as binding yet."* This is now stale relative to the Dardar tokens landing in `DESIGN.md` §1 and the codebase itself this session — `PRODUCT.md` was intentionally left unedited (out of scope for a color-only task), so this contradiction is real and should be resolved by `PRODUCT.md`'s own owner, not silently patched here.

**Flag, do not silently resolve (second instance)**: `PRODUCT.md`'s "Accessibility & Inclusion" section still states *"No specific accessibility standard has been confirmed as a requirement yet."* This is the same shape of staleness as the Brand Commitments flag above — `DESIGN.md` §1 already states an explicit WCAG AA contrast floor and a "color + icon + text, never color alone" rule, both implemented in the live component system (§B3 below, §B9). `PRODUCT.md` was not edited to resolve this, consistent with not silently changing an authoritative source document — this contradiction should be resolved by `PRODUCT.md`'s own owner, the same way as the Brand Commitments item above.

**Verified, real accessibility/typography facts** (supersede Part A's generic aspirational phrasing where more specific):
- Alexandria (`--font-sans`) / JetBrains Mono (`--font-mono`) are wired via `next/font/google` in the root layout — real tokens, not aspirational.
- The documented "seventh" teal/violet status tone for Published/Locked (`DESIGN.md` §1) **does not exist in code** — only six tones are implemented (gray/amber/green/red/blue/slate) in `app/academy/_shell/ui.tsx`'s `BADGE_TONES`/`BADGE_TONE_CLASS`. Do not design or implement a seventh tone without a product decision; the Published-result workflow (§B9 below) currently has no distinct locked-state color in code.

**Brand mark (status: already implemented).** The real Dardar "D" mark is live, not aspirational — supplied as two source PNGs, `public/dardar-mark.png` (compact) and `public/dardar-logo.png` (full lockup), both verified with genuine alpha transparency. `app/academy/_shell/icons.tsx`'s `BrandMark` renders the compact mark via `<img>`, with an `onDark` prop that adds a small white rounded-square backdrop plate — used only on the Platform shell's burgundy sidebar (`color.primaryNavy`), where the unmodified burgundy mark was verified too low-contrast to read on its own; the Academy shell's light sidebar uses the mark with no plate. `lib/ui/auth-components.tsx`'s `AuthLogo` renders the full lockup at 200×147px on every `AuthCard` authentication screen. `app/icon.png`, `app/apple-icon.png`, and `app/favicon.ico` were regenerated from the compact mark. **Known asset limitations, not implementation bugs**: the source PNGs have a white-matted edge (a faint light halo visible on dark backgrounds, confirmed by direct pixel inspection); the mark's speed-line/gold-accent detail is largely lost at 16×16 (legible from 32×32 up). Do not design a new logo to work around either limitation — both are flagged for a possible future cleaner-edged source asset, a product-owner decision, not something to silently fix in a design pass.

## B3. Shared components — real inventory, not aspirational

Three real mechanisms coexist (not one unified design system yet):
1. `lib/ui/theme.ts` — plain inline `style={{}}` JS constants, used for bespoke shell/chrome layout (sidebar/header in `platform-shell.tsx`/`academy-shell.tsx`).
2. `app/academy/_shell/ui.tsx` — shared, Tailwind-class-based primitives used by **both** consoles for page content: `Card`, `StatCard`, `StatusBadge`/`Badge` (six tones, one fixed icon per tone, never color alone), `EmptyState`, `ErrorMessage`, `PrimaryButton`/`SecondaryButton`/`Button`/`LinkButton`, `SkeletonBlock`/`Pulse`/`ListPageSkeleton`, `PAGE_WRAP`, `Breadcrumbs`, `PageHeader`, `BackLink`, `PageMessage` (access-denied/error full-page), `Section`, `Toolbar`, `Field`/`inputClass`, `TableWrap`/`th`/`td`/`trHover`, `UsageBar`, `FormDialog`. Icons: `app/academy/_shell/icons.tsx`'s name-keyed `Icon` component, plus `BrandMark`. Charts: `app/academy/_shell/charts.tsx` (`TrendAreaChart`, `BarChart`).
3. A real shadcn/Radix component layer at `components/ui/*` — `AlertDialog` (underlying the shared `ConfirmButton`), `DropdownMenu`, `FormDialog`'s modal wrapper, `Pagination`, `Toaster` (sonner). This layer was synced into the Claude Design component library this session (§ intro above) — 59 components total, 17 with authored preview compositions, the rest on an honest "floor card."

**This file's own header comment says it is "deliberately not a general design system"** — the fuller catalogue Part A's Phase 1 describes (full data-table filter/sort/pagination chrome, stepper, approval-queue row, audit-log expandable row, locked/read-only banner) is **not yet built as reusable components**. Each page hand-builds what it needs today. Do not assume a shared "data table" or "approval queue" component exists beyond what a specific page's own markup renders — building one is legitimate future work, but treat it as new work, not a reuse of something that already exists.

## B4. Platform and Academy shells (verified exact values)

Shared proportions (`lib/ui/theme.ts`'s `shell` export, used by both consoles): `sidebarWidth` 260px expanded / `sidebarCollapsedWidth` 72px icon rail, `headerHeight` 56px, `contentMaxWidth` 1400px.

**Discrepancy, preserved not resolved**: both the Platform shell (`platform-shell.tsx`) and the Academy shell (`academy-shell.tsx`) are written at exactly **1025px** — identical `min-width`/`max-width` media queries in both files, each with its own code comment explaining the one-pixel offset from Tailwind's default `lg:` (1024px) is deliberate, so the two shells never disagree with each other at an exact 1024px-wide viewport. Treat 1025px as the real, shared desktop breakpoint for **both** shells, not a Platform-specific quirk — it still disagrees with `DESIGN.md` §2's and Part A's generic "below 1024px" language app-wide, which remains the actual, preserved discrepancy here.

Academy and Platform shells share every token, icon set, and interaction pattern (collapse-to-rail, CSS-only tooltips on the collapsed rail via `position: fixed` to escape `overflow: hidden`, mobile slide-in drawer with scrim/Escape-to-close/focus-trap, `prefers-reduced-motion` handling throughout). **The one deliberate visual difference**: the Platform sidebar background is `color.primaryNavy` (now the same burgundy as everything else, post-rebrand) instead of the Academy shell's light sidebar — a code comment frames this as the one low-risk way to signal "a different persona/context" without a second color system.

Platform nav gating (`lib/platform/nav-items.ts`, `PLATFORM_NAV_ITEMS` — absence from nav ≠ absence of a server-side check; every page re-verifies independently):

| Nav item | Required capability | Grantable to `platform_admin`? |
|---|---|---|
| Dashboard | none (always visible) | n/a |
| Academies | `approveAcademy` | **No — ungrantable** |
| Subscriptions | `renewSubscription` | **No — ungrantable** |
| Payments | `recordSubscriptionPayment` | Yes |
| Plans | `plans.manage` | **No — ungrantable** |
| Usage | `getPlatformReports` | Yes |
| Reports | `getPlatformReports` (revenue sub-view needs the separate, ungrantable `platform.revenue.view`) | Yes, partially |
| Audit Log | `queryAuditLogs` | Yes |
| Platform Staff | `platform.staff.manage` | **No — ungrantable** |
| Settings | `platform.settings.manage` | **No — ungrantable** (role split is an unconfirmed judgment call — see §10 item 2) |

Zero-nav-items state (a `platform_admin` with no grants beyond Dashboard): a plain text line, "No platform tools are available for your account yet." — not an illustration, not a dead end.

## B5. Screen inventory and navigation

**Academy console** (`DESIGN.md` §9, real route groups, not redesigned this session): Dashboard; Students & Admissions (`/academy/students`, `/new`, `/admissions`, Student Profile tabs: Overview/Enrollment/Documents/Payments/Results/ID Card); Staff (`/academy/staff`, `/new`, detail tabs: Profile/Role & Permissions/Branch Assignments/Course Assignments/Documents); Branches; Academics (Programs → Courses → Batches hierarchy, Batch detail tabs: Overview/Enrolled Students/Trainer Assignment/Timetable/Exams); Timetable (weekly grid, no attendance affordance anywhere); Exams & Results (`/academy/exams`, Mark Entry, Review/Approval, Publish, Result Correction, `/academy/grades`, `/academy/results`); Finance (`/academy/finance` dashboard tab, Charges, Payments, Receipts, Income, Expenses, Reversal/Adjustment, Finance Reports, Fee Periods — the last is real but undocumented in `DESIGN.md`/`PLAN.md`, see §B10 item 19); Books & Book Sales (`/academy/books`, `/academy/books/stock`, `/academy/books/sales` — also real but undocumented in `DESIGN.md`/`PLAN.md`, see §B10 item 19); Certificates & IDs (`/academy/certificates`, `/academy/id-cards`); Notifications; Reports; Audit Log (Owner/Admin only); Settings (Profile/Usage/Branch/Personal/Role reference/Grade-bands pointer/Notifications).

Three further real account-level screens exist outside both console trees — `/account/verify-email`, `/account/activity`, and `/mfa/recovery-codes` — absent from, or placed differently than, `DESIGN.md` §7's auth/account screen table and `PLAN.md`'s Phase 0 action list; see §B10 items 20–21 (now independently verified against the route code, not just confirmed-to-exist).

**Platform console** — 13 routes, all confirmed to exist via `Glob app/platform/**/*.tsx`, no more, no fewer:

| Route | Implementation status | Required roles | Design priority |
|---|---|---|---|
| `/platform` | Complete (redirect to dashboard) | Any platform role | N/A — not a designable page |
| `/platform/dashboard` | Complete | Any platform role (per-section capability gating) | Low — small, correct, polish only |
| `/platform/academies` | Complete | `platform_owner` only | Medium |
| `/platform/academies/new` | Complete (6-step wizard) | `platform_owner` only | **High** — complex, high-stakes |
| `/platform/academies/[id]` | Complete | `platform_owner` only | **High** — most business-rule-dense page in the console |
| `/platform/subscriptions` | Complete | `platform_owner` only | Medium |
| `/platform/plans` | Complete | `platform_owner` only | Medium |
| `/platform/payments` | Complete | `platform_owner` full; `platform_admin` record-only if granted | **High** — financial, 3-tier permission surface |
| `/platform/usage` | Complete | `platform_owner` or `platform_admin` granted `getPlatformReports` | Medium |
| `/platform/staff` | Complete | `platform_owner` only | Medium |
| `/platform/reports` | Complete | `platform_owner` full; `platform_admin` partial (no revenue) | Medium — known chart/table inconsistency vs. Dashboard |
| `/platform/audit-logs` | Complete, but missing Export (§10 item 5) and the before/after expand row (§10 item 6) | `platform_owner` full; `platform_admin` if granted `queryAuditLogs` | Medium — design should close these real gaps |
| `/platform/settings` | **Deliberate read-only stub**, not the toggle form `DESIGN.md` describes | `platform_owner` only (unconfirmed judgment call) | Low — design the honest current read-only state only |

Full per-page detail (fields, interactions, states, business rules, acceptance criteria, evidence) for every Platform route is in §11.

## B6. Responsive and mobile requirements

Desktop ≥1280px is the primary target for dense data entry (mark-entry grids, finance tables, audit logs). Must remain fully usable on mobile regardless (`DESIGN.md` §12, cross-checked against Part A's Phase 8 — the two agree): Login, MFA challenge, password reset, approval queues, student/payment lookup, result review, notifications, `/account/security`, any single quick action reachable in ≤2 taps from the mobile dashboard. Sidebar collapses to the mobile drawer at the shell's own breakpoint (1024px generically per `DESIGN.md` §2, verified 1025px on both shells — §B4). Tables degrade to horizontal scroll today, **not** the stacked-card-per-row pattern `DESIGN.md` §2 describes as the mobile table pattern — this is a real, platform-wide, unimplemented gap (no Platform page and no page reviewed this session implements a mobile card-per-row transform; `TableWrap`'s real behavior is horizontal scroll only).

## B7. States — loading, empty, error, validation, disabled, permission-denied

Real, verified conventions (not aspirational): `PageMessage title="Access denied" message="..."` for a failed page-level capability check, with the exact wording varying by page (quoted in each page's §11 entry — never substitute a generic "403"); `redirect("/login")` pre-render for unauthenticated; `EmptyState` with an `Icon` and a specific message (never "No data"); `ListPageSkeleton columns={N}` shape-matched to real column counts for most list pages, though at least two loading skeletons are verified stale relative to their real page content (`/platform/academies/loading.tsx` now confirmed correct at `columns={8}`; `/platform/staff/loading.tsx` and `/platform/settings/loading.tsx` are verified **mismatched** — see §10); inline `ErrorMessage` for form/action failures, scoped as close to the failing row/section as the page allows (Plans and Usage insert a per-row/per-card error rather than a page banner); toasts (`showSuccessToast`/`showErrorToast`) for most mutations, but verified **inconsistent** — Subscriptions' Renew and Usage's Recalculate fire no toast at all, unlike Plans/Payments/Staff, which do (§10).

## B8. Role permissions, tenant isolation, branch scope

**Tenant isolation is non-negotiable and enforced at the application layer, not database RLS alone** (`PRODUCT.md` Principle 1) — no academy's data is ever visible to another tenant, and this is never left to UI-level hiding.

**Branch scope** (`DESIGN.md` §2.2, §5): Admissions Officer and Trainer are branch-limited; Academy Owner, Academy Administrator, Manager, and Finance Officer are academy-wide. A branch-limited role's branch selector is a **locked read-only label** (or a locked dropdown among only their own branches if assigned to more than one) — never "All branches." Every branch-scoped list shows a persistent caption, e.g. "Showing students in: {branch name}." This is IDOR-protected server-side, not just hidden in the UI — a branch-limited role cannot view another branch's data even via a guessed URL.

**Role-to-UI visibility matrix** (`DESIGN.md` §5, matches `PLAN.md`'s permission tables exactly — `Full` = view/create/edit, `Manage` = create/edit within own scope, `View` = read-only, `Approve` = decision-making on submitted items, `—` = not visible at all, nav/action omitted not disabled):

| Area | Platform Owner | Platform Admin | Academy Owner | Academy Admin | Manager | Admissions | Finance | Trainer |
|---|---|---|---|---|---|---|---|---|
| Academies (register/approve/activate/suspend/close) | Full | **— never grantable** | View own | — | — | — | — | — |
| Subscriptions (renew) | Full | **— never grantable** | View own | — | — | — | — | — |
| Payments (record) | Full | Per grant | — | — | — | — | — | — |
| Payments (verify/reject/reverse) | Full | **— never grantable** | — | — | — | — | — | — |
| Plans (pricing) | Full | **— never grantable** | — | — | — | — | — | — |
| Platform Revenue Reports | Full | **— never grantable** | — | — | — | — | — | — |
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
| Export (Reports/Students/Finance/Audit) | — | — | Per own view rights (all roles) | | | | | |

**Rule for building any screen**: a `—` cell means the nav item and every action tied to it are **absent**, never disabled. Disabled-with-tooltip is reserved narrowly for self-approval and permanently-owner-only capabilities (`DESIGN.md` §3, §5).

**Platform-specific capability facts, verified in code** (`lib/auth/permissions.ts`, `lib/platform-staff/capabilities.ts`): exactly **3 capabilities are grantable** to a `platform_admin` — `recordSubscriptionPayment`, `queryAuditLogs`, `getPlatformReports`. Everything else platform-side (including `approveAcademy`, `renewSubscription`, `plans.manage`, `platform.staff.manage`, `platform.settings.manage`, `platform.revenue.view`, and all 5 academy-lifecycle actions, plus `deleteAcademy` — see §10 item 3) is permanently `platform_owner`-only via `UNGRANTABLE_CAPABILITIES`, re-checked independently inside every server action, not inherited from a page or nav gate alone.

## B9. Financial, subscription, certificate, exam-result, and audit requirements

**Money**: always integer cents internally; every user input is dollars, converted at the UI boundary (`PRODUCT.md`). No floating-point money math anywhere verified in this session's code reads.

**No hard deletes on financial/academic-result records** (`PRODUCT.md` Principle 2) — corrections are new, linked rows; the original stays visible, marked "Reversed." **Platform-side exception, verified and important**: `reverseSubscriptionPayment` does **not** follow this pattern — it flips the *same row's* status to `"reversed"` in place, with no linked "Reversal of #X" record, a deliberate architectural difference from the academy-side Finance reversal pattern. Do not design a linked-reversal UI for `/platform/payments`'s Reverse action.

**Self-approval** (`DESIGN.md` §11.4, decided per-entity, not universally blocked): Student Payments have no approval queue at all (direct post). **Expenses allow self-approval** — Owner/Administrator/Manager/Finance Officer may approve their own submitted expense immediately; this is the one Academy-side case where "You can't approve a transaction you recorded" does **not** apply, despite that copy string still existing in the library for any entity that does still block it.

**Results and Grade Configurations**, flagged by `DESIGN.md` §11.4's own footnote as "potentially stale until confirmed": confirmed directly in code this session (`lib/academies/results.ts`, `lib/academies/grade-configurations.ts`) that self-approval **is** allowed for Owner, Academy Administrator, and Manager on both entities, under the same "never block an already-authorized actor waiting for a different approver" architecture decision that governs Expenses above. Trainer never reaches approve-level on either entity (the self-decision check is gated behind `canApproveLevel`, which is already `false` for Trainer before that line is reached), so nothing changes for Trainer. Treat `DESIGN.md` §9.3's and §9.5's approval-queue descriptions as **confirmed current** on this specific point, not stale — the footnote's uncertainty is resolved.

**Subscription lifecycle** (`DESIGN.md` §11.1, derived state, no independent "academy status" field anywhere):

| Stored state | Displayed | Access |
|---|---|---|
| Draft / Trial | Trial / Draft (gray/blue) | Full (trial) or none yet (draft) |
| Active | Active (green) | Full |
| Past Due, day 1–7 | Past Due — grace period (amber) | Full, persistent banner |
| Past Due, day 8+ (lazy flip) | Suspended (red) | Blocked |

Grace period is exactly 7 days (`PLAN.md`-specified constant). `renewSubscription`'s 7-step locking algorithm is verified in code to match `PLAN.md` almost exactly, with one deliberate, justified deviation (locks the subscription row before the payment row — see §10 item 12 for the stated reasons). `ends_at` anchors to `max(current ends_at, now) + billing period` using real calendar arithmetic, never a fixed-days approximation.

**Exam-result workflow** (`DESIGN.md` §9.5) — the Stepper component drives `Draft → Marks Entered → Submitted → Under Review → Approved/Rejected → Published`. Publish is a distinct, separate confirmation from Approve. Published results are locked; the only path to changing a value afterward is Result Correction (modal: original vs. proposed + required reason), which routes back through the same Approve/Reject queue. **Flag**: the "Published" locked state is specified as a teal/violet banner in `DESIGN.md` §1/§3, but that tone does not exist in the shared token system (§B2) — any screen implementing this state today has no verified real color to use for it; this needs a product/engineering decision, not an invented hex value.

**Certificate verification** (`DESIGN.md` §10): `/verify/[certificateCode]` is unauthenticated, zero app chrome, shows only name/program/issue-date/valid-or-cancelled status, rate-limited per IP. Works identically regardless of the issuing academy's open/suspended/closed state — **zero academy-status messaging ever appears on this page**, by deliberate design (closure never deletes or hides the record).

**Audit logs**: Academy-side (`/academy/audit-logs`) is Owner/Admin only, hard-scoped to that academy, uses the shared audit-log-row component per `DESIGN.md` §3. Platform-side (`/platform/audit-logs`) is genuinely platform-wide — **verified to lack both the Export button `PLAN.md` requires and the expandable before/after row `DESIGN.md` claims is shared with the academy version** (§10 items 5–6) — do not assume feature parity between the two audit-log screens without closing these gaps first.

## B10. Approved visual decisions and known limitations (Discrepancy Ledger — preserve, do not silently resolve)

**Permission-model conflicts:**
1. **Academies area (`/platform/academies`, `/new`, `/[id]`) is entirely `platform_owner`-only in the real app, including just viewing** — not merely mutating. `DESIGN.md` §8's prose ("an admin with view access sees the same tabs read-only") is stale and contradicted by both the code and `DESIGN.md` §5's own matrix (a `—`, never-grantable cell); the detail page also has no tabs at all (a flat `Section` stack), making §8's "same tabs" premise doubly stale. Resolution used throughout this document: §5's matrix and the shipped code win.
2. **`/platform/settings`'s owner-only restriction is an unconfirmed engineering judgment call**, not a documented rule — neither `PLAN.md` nor `DESIGN.md` states a role for this page (unlike Staff/Plans/Revenue, which explicitly say owner-only).

**Actions in code but not in the documents:**
3. A real, implemented **`deleteAcademy`** action/capability exists (`lib/academies/delete-academy.ts`, in `UNGRANTABLE_CAPABILITIES`) with no mention in `PLAN.md` or `DESIGN.md` — narrower than Close, permitted only when an academy has zero rows across 9 financial/certificate/result-history categories, re-verified server-side at delete time.

**Features the documents require that the code doesn't build:**
4. `/platform/settings` is a read-only stub (3 env-var-backed switches, zero interactive controls), not `DESIGN.md`'s "simple toggle form" — deliberate, since no persistence layer exists yet. **Design the honest current state, not the toggle form**, until a schema change lands.
5. `/platform/audit-logs` is missing the CSV Export `PLAN.md` §11.6/Decision #10 explicitly requires for it — the mechanism exists and works for `/academy/audit-logs` but was never wired to the platform page.
6. `/platform/audit-logs` has no expandable row/before-after display, contradicting `DESIGN.md` §3's claim the two audit-log screens share "an identical component."
7. `/platform/payments`'s evidence-upload field is a bare optional text reference — no real file-storage backend exists yet, unlike `DESIGN.md` §8's drop-zone+preview description.

**Documents disagreeing with themselves:**
8. `PLAN.md`'s own password-length requirement contradicts itself (Decisions section: 8 characters; Phase 0 acceptance criteria: "under 12 characters is rejected"). Code (`passwordSchema`) and `DESIGN.md` both agree on 8 — treat `PLAN.md`'s "12" as the stale figure.

**Real implementation gaps worth a product decision (no document addresses these specifically):**
9. `setPlanActive` (Retire a plan) performs no check/warning for whether any academy is currently on that plan — likely benign (retiring only blocks new/renewed selection), but `DESIGN.md`'s "Retire ... if any academy is on it" phrasing could imply a visible count/warning that doesn't exist.
10. `/platform/payments`'s payment-method field is unconstrained free text, unlike the academy side's constrained cash/mobile-money/bank-transfer enum — worth confirming intentional given this product's explicit no-card/no-gateway positioning.
11. `/platform/reports` renders the active-academy trend as a plain table while `/platform/dashboard` renders the identical series as a chart — same data, two visual treatments.
12. The "Expected/Pending" revenue formula (Reports) and the active-academy-trend derivation (both Reports and Dashboard) are each the engineer's own judgment call, explicitly flagged in-code, with no literal `PLAN.md`/`DESIGN.md` formula to check against. `renewSubscription`'s subscription-row-before-payment-row lock order is a similar, separately-justified deviation (closes an extra lost-update race; fixes lock order to avoid deadlock) — the schema-level `UNIQUE(subscription_payment_id)` backstop `PLAN.md` specifies is still fully in place regardless.

**System-wide notes:**
13. The documented seventh "published/locked" teal-violet status tone does not exist in the real token/badge system (§B2, §B9).
14. A real shadcn/Radix component layer (`AlertDialog`-backed `ConfirmButton`, `DropdownMenu`, `FormDialog`) coexists with Tailwind utility classes and `lib/ui/theme.ts`'s inline-style constants (§B3) — do not design as if only one mechanism exists.
15. `REQUIREMENTS_GAP_ANALYSIS.md` and `PLANNING_GAPS_RESOLUTION.md` are cited repeatedly by `PLAN.md`/`DESIGN.md` as the historical record of *why* decisions were made, but **neither file exists anywhere in this repository** — every such citation is unverifiable from the repo alone; this document treats `PLAN.md`/`DESIGN.md`'s own restatements as authoritative instead.
16. Loading-skeleton mismatches, verified directly: `/platform/staff/loading.tsx` renders a generic 4-column skeleton, not shaped to that page's real 3-section layout (create form/table/grant editor); `/platform/settings/loading.tsx` renders 4 toggle-shaped pill rows, but the real page renders a 3-row table with badges (the skeleton was written for the toggle-form version `DESIGN.md` describes and never updated to match the read-only stub that shipped).
17. Toast-feedback inconsistency, verified directly: Subscriptions' Renew and Usage's Recalculate fire no success toast at all, unlike Plans ("Plan created."/"Plan updated."/"Plan retired."/"Plan restored.") and Payments ("Payment recorded."/"verified."/"rejected."/"reversed."), which do.
18. Accessibility gaps, each independently verified and narrow enough to fix directly: the disabled Renew button's reason is exposed only via a `title` attribute (not reliably reachable by screen readers); Usage's progress bars have no `role="progressbar"`/`aria-valuenow` semantics; `/platform/academies/[id]`'s disabled lifecycle-action buttons have no `aria-describedby` linking them to their reason text.
19. **Two entire feature areas are real, shipped, and permissioned but have zero presence in `PLAN.md` or `DESIGN.md`**: Academy Books & Book Sales (`/academy/books`, `/academy/books/stock`, `/academy/books/sales`, gated by the `academy.books` capability) and Student Fee Periods (`/academy/finance/fee-periods`, gated by `academy.fee_periods`). `lib/auth/academy-permissions.ts` labels both, in its own code comments, as "new feature... not in PLAN.md/DESIGN.md's original matrix." Both are named only in passing in `PRODUCT.md`'s Operating Context paragraph ("fee periods," "books & book sales") with no screen pattern, lifecycle, or schema anywhere else. Verified facts, directly from code, recorded here rather than invented:
    - **Books** (`academy.books`, `lib/academies/books.ts`, `lib/auth/academy-permissions.ts`): Owner — view; Academy Administrator — view; Manager — manage; Finance Officer — manage; Admissions Officer/Trainer — no access. No approval workflow — book-sale income posts directly, the same no-approval shape as `academy.income`. Book covers accept JPEG/PNG/WebP/AVIF up to 10MB — wider than `PLAN.md`'s general image-upload rule (JPEG/PNG/WebP only, 5MB cap). **UNRESOLVED**: whether this wider cover-upload policy is an intentional book-specific exception or an undocumented drift from the general file-storage rule — no source document says either way.
    - **Book-sale refunds** are tracked in their own `book_sale_refunds` table (`lib/academies/book-sales.ts`), deliberately not reusing the academy-wide income/expense reversal mechanism — the file's own comment states the existing reversal mechanism "is built for 'this whole record was wrong, fully reversed'" and refunds need partial, stock-restoring, reason-required corrections instead. **UNRESOLVED**: whether this distinct refund model is a deliberate, approved product decision or an undocumented one-off — no source document addresses book-sale refunds at all, so no lifecycle or permission rule beyond the bare code fact above should be assumed.
    - **Fee Periods** (`academy.fee_periods`, `lib/academies/fee-periods.ts`, `lib/auth/academy-permissions.ts`): Owner — view; Academy Administrator — manage; Manager — full; Finance Officer — manage; Trainer — view; Admissions Officer — no access. Fee-period payments post through the **same `student_payments` table** as ordinary student payments, not a separate payments concept. A fee schedule is a bounded number of equal monthly installments (`enrollment_fee_schedules.intervalMonths`, 1–12); each installment generates its own `fee_periods` row.
    - **UNRESOLVED, both features**: no source document states whether Owner's/Academy Administrator's view-only-vs-manage split here is a final, intentional decision or merely not yet revisited; no source document states a retention/no-hard-delete rule for `books`, `book_sale_refunds`, or `fee_periods` rows specifically (`PRODUCT.md` Principle 2's general "no hard deletes on financial records" rule plausibly extends here, since these are financial tables, but this is an inference, not a confirmed rule, and should not be treated as settled without product-owner confirmation).
20. **`/account/verify-email` and `/account/activity`, independently verified against code this session** (route files, their backing `lib/` actions, and the shared mechanisms they build on) — neither is in `DESIGN.md` §7's Authentication & Account Screens table (which lists only `/login`, `/mfa/setup`, `/mfa/challenge`, `/forgot-password`, `/reset-password`, `/account/security`), and `PLAN.md`'s Phase 0 server-action list has no email-verification action at all:
    - **`/account/verify-email`** (`app/account/verify-email/page.tsx`, `lib/auth/email-change.ts`) completes an **email-address-change** confirmation — not an initial-signup email verification (no such flow exists anywhere in this app). It is a single-click "magic link" landing page with no form of its own — the only input is the `?token=` query param, validated server-side on render. Token: single-use, SHA-256-hashed at rest, 60-minute TTL (`EMAIL_CHANGE_TOKEN_TTL_MINUTES`, env-configurable); requesting a new one invalidates any still-pending token for that user, so at most one valid link is ever outstanding. States: no token → "invalid or already used"; expired → "Link expired" + a link to request another; invalid/used/already-claimed email → "Verification failed" with a generic message; success → "Email verified" + the new address + a continue link. No separate `loading.tsx` exists for this route (confirmed — none found), since it's a single server-rendered pass. **Not gated behind authentication**, by deliberate design — the verifying browser is often a different device/session than the one that requested the change — the same reasoning as `/reset-password`. Re-checks new-email uniqueness again at verify time (not just at request time) to close a race against a second account claiming the same address in between. Every issuance and every successful change is audit-logged (`email_change_verification_requested`, `email_address_changed`, with before/after on the latter). Reuses the shared `AuthCard`/`AuthShell` centered-card primitive (max-width 400px) — identical responsive behavior to `/login`/`/reset-password`/`/mfa/challenge`. The request side (current-password-gated, from the account-settings update flow) and the "resend"/"pending verification" UI both live on `/account/security`, not on this page. **UNRESOLVED**: Part A's generic "An email-verification screen" line doesn't distinguish signup-verification from change-verification, and only the latter exists in this app — worth a product-owner note so a future design pass doesn't design a signup-verification screen this app has no use for.
    - **`/account/activity`** ("My Activity," `app/account/activity/page.tsx`, `lib/my-activity.ts`) is a personal audit-trail view onto the exact same `audit_logs` table `/academy/audit-logs` and `/platform/audit-logs` already read — reused as-is, no new table, no new write path — but hard-scoped server-side, at the type level (`actorUserId` is omitted from the caller-facing filter type and always set from the resolved `AuthContext` after the caller's own filters are spread, never overridable), to the signed-in user's own rows only. No permission gate beyond being signed in; any role, either console; unauthenticated → `redirect("/login")`. Fields: a GET-query-param filter form — free-text Action, a Result select (Any/Success/Failure), From/To date range, a Filter submit, and a conditional "Clear filters" link; deliberately no Actor filter/column (every row is already known to be the viewer's own). No field validation beyond safe parsing (bad dates/page numbers fall back silently rather than erroring). States: a `role="alert"` error message on a failed query; two distinct empty-state messages — "No activity matches these filters" (filtered) vs. "No activity recorded on your account yet" (unfiltered), a real Empty-vs-Search-no-results distinction matching `DESIGN.md` §3.1's own pattern; success renders a 4-column table (When/Action/Entity/Result) with a two-tone success/failure badge (failure reason in a `title` tooltip) and pagination at the standard default page size of 15 (`AUDIT_LOG_DEFAULT_PAGE_SIZE`, matching `PLAN.md`'s general pagination default exactly). A dedicated `loading.tsx` renders a shape-matched skeleton (title block + 6 placeholder rows). Table wrapped in a horizontal-scroll container — the same scroll-not-stacked-card pattern already disclosed as a platform-wide gap (§B6). Reached from a link in each console's own "Account settings," outside both `app/academy/*`/`app/platform/*` route trees — the same placement convention as `/account/security`. **UNRESOLVED**: whether this page's lack of an Export button is a deliberate match to `PLAN.md`/`DESIGN.md`'s closed four-screen Export surface (Reports/Student list/Finance/Audit Logs, which doesn't name "My Activity") or simply never considered — the closed-list reading suggests no Export is correct here, but no source document says so explicitly for this specific page. **UNRESOLVED/minor**: the loading skeleton's `animate-pulse` has no `prefers-reduced-motion` guard, unlike the academy shell's own skeleton convention elsewhere — a candidate addition to the accessibility-gap list (item 18) if a future pass addresses it.
21. **`/mfa/recovery-codes` is a real, standalone route not named anywhere in `DESIGN.md` or `PLAN.md`**, surfaced by this session's full route-inventory sweep (`find app -iname page.tsx`, cross-checked against every screen this document and `DESIGN.md` already name — no other undocumented route was found beyond items 19–21). `DESIGN.md` §7 describes "Regenerate recovery codes" as an **MFA sub-section embedded within `/account/security`** ("For Platform Owner accounts only: an MFA sub-section showing enrollment status + 'Regenerate recovery codes'..."); the real app instead keeps it as a separate page at `/mfa/recovery-codes`, and `/account/security` (`app/account/security/page.tsx`, confirmed by direct read) links out to it rather than embedding it inline. The route's own code comment explains why: it was built as "a deliberate stand-in" before `/account/security` existed, following the `/mfa/setup`/`/mfa/challenge` naming convention, with an explicit note that the underlying gating and regenerate/reveal flow are otherwise unchanged from what `DESIGN.md` specifies — only *where* the control lives differs from the documented design. **UNRESOLVED**: whether this link-out structure is an accepted final shape or a migration still owed now that `/account/security` exists — no source document has been updated to reflect the real route structure either way.
22. **The Platform sidebar's white backdrop-plate behind the compact mark is an unconfirmed visual judgment call**, not an approved design decision — added to fix a verified contrast failure (the real mark's burgundy fill reads as nearly invisible directly on the burgundy sidebar background), not specified by any source document. A future design pass may propose an alternative (e.g. a dedicated light/reversed-color mark variant) instead of keeping the plate — treat the plate as the current shipped state, not as a locked-in requirement.

## B11. Platform Console — page-by-page implementation sequence and acceptance criteria

Build in this order (High → Medium → Low, matching the Design Priority column in §B5's route table): `/platform/academies/new` → `/platform/academies/[id]` → `/platform/payments` → `/platform/academies` → `/platform/subscriptions` → `/platform/plans` → `/platform/usage` → `/platform/staff` → `/platform/reports` → `/platform/audit-logs` → `/platform/dashboard` → `/platform/settings`. **Academy-side screens were not re-audited to this depth this session** — follow `DESIGN.md` §9's existing section order for those instead; do not assume Academy screens carry the same page-by-page verification rigor as the Platform capsules below.

Each capsule: identity, key fields, key interactions (with permission + destructive flag), key states, key business rules, acceptance criteria, and open evidence/uncertainty flags. Full original detail (every file path, every test name, every line-numbered citation) lived in the now-removed `design-briefs/PLATFORM_DESIGN_SPEC.md` §4–§5c; nothing substantive below was dropped in the compression — only repeated narrative framing was cut.

### `/platform/dashboard`
Landing page, KPI row (Total Academies/Pending Approvals/Expiring Subscriptions/Total Collected) each independently shown-or-permission-denied per section, then a `TrendAreaChart` of cumulative active academies, then Pending Approvals / Expiring Subscriptions / Recent Payments tables (each capped at 10 rows + "View all" link). All reads already-gated, no new queries. "Total Collected" deliberately shows **no currency symbol** — `subscription_payments` stores free-text per-row currency with no cross-row reconciliation; this is a documented limitation, not a bug to fix. **Acceptance**: a `platform_admin` with no grants still sees a useful dashboard with 4 distinct section-specific permission-denied messages, never one page-level error or a blank page. **Evidence gap**: `loading.tsx`'s exact skeleton shape wasn't independently verified.

### `/platform/academies` (list)
`platform_owner`-only, full stop (§10 item 1). Table: Name/Slug/Approval badge/Plan/Subscription badge/Branches/Created/Actions — two independent derived badges (approval vs. subscription) that can combine freely (e.g. "Pending approval" + "Active"). **Deliberately no Student-count column** — flagged by its own code comment as unavailable, but §10's Usage findings show `students`/`staff_profiles`/`courses` tables are now real; this specific omission may no longer be necessary and is worth reconciling. No search/filter/sort/export anywhere on this page (real, verified absence). Page size 15. **Acceptance**: pagination shows exactly 15/page; a `platform_admin` never sees the nav link or the page under any grant.

### `/platform/academies/new` (register)
`platform_owner`-only. 6-step wizard (Profile → Owner account → Default branch → Plan & allowances → Subscription dates → Review), client-side step validation, one real mutation on Review (atomic transaction: academy + branch + owner + subscription, audited). Trial defaults to checked, 14 days — an explicit, PLAN.md-silent judgment call for sales-friendliness. Password minimum 8 characters (§10 item 8). **No logo-upload UI** — the "Logo" field is a raw text reference, not a file picker. **No secondary confirmation dialog on the final irreversible submit** — a real gap worth a product decision, analogous to the Certificate-issuance confirmation gap found in the earlier `afoogy-design` review. **Acceptance**: zero active plans blocks progression at the Plan step with a specific message, not a generic empty state; a successful submit redirects to the new academy's detail page with no on-page success state of its own.

### `/platform/academies/[id]` (detail)
`platform_owner`-only, same reasoning as the list page. **Flat `Section` stack, no tabs** — a real, verified deviation from `PLAN.md`'s generic "Pattern B uses tabs" description (§10 item 1, doubly). Sections in order: Profile, Onboarding metadata, Approval, Onboarding checklist (4 items: profile-complete/plan-selected/approved/**payment-verified**, deliberately stricter than `DESIGN.md` §11.3's literal "payment recorded" wording so the checklist never shows green when Activate would still fail), Lifecycle actions (Activate + 4 reason-gated: Suspend/Reactivate/Cancel/Close), Subscription & plan (read-only — **no Renew button here**, it lives on `/platform/subscriptions`), Usage vs. allowances, Payment history, Danger zone (the type-the-name-to-confirm **Delete Academy** — see §10 item 3). Every one of the 7 mutating actions independently re-checks `platform_owner`-only server-side. Close is the only action requiring both a reason **and** an explicit confirmation checkbox, and is unconditionally available (no subscription-status precondition) except when already closed. **Acceptance**: Delete is available if and only if zero rows exist across all 9 disposable-history categories, re-verified at delete time on a row-locked read, never trusted from the UI-time preview alone; a closed academy shows zero actionable lifecycle controls.

### `/platform/subscriptions`
`platform_owner`-only, no partial grant exists for this page at all (unlike Payments/Usage/Reports/Audit, which each have some grantable path). Single table, Renew the only action, offered only when `canRenew` (one of three exact disabled-reason strings shown via `title` tooltip otherwise — a real accessibility gap, §10 item 18). **Most faithfully-implemented business logic found in this review**: the 7-step renew algorithm matches `PLAN.md` almost verbatim, with one documented, justified lock-order deviation (§10 item 12). **Fires no success toast** — inconsistent with this cluster's otherwise-universal toast convention (§10 item 17). **Acceptance**: two concurrent Renew attempts against the same payment yield exactly one success and one specific rejection, never a double-renewal.

### `/platform/plans`
`platform_owner`-only. Create form always inline (not a dialog) — the one page in this cluster where that's true. Edit opens a `FormDialog`; Retire/Restore is a `DropdownMenu` item, **never a delete** — no `deletePlan` action exists anywhere. Retire performs no subscriber-count check or warning (§10 item 9, stale code comment corrected). **Acceptance**: price is always stored/computed in integer cents, dollars only at the input boundary; editing a plan never touches `isActive` and Retire/Restore never touches any other field.

### `/platform/payments`
`platform_owner` full; a granted `platform_admin` can record only — the Actions column (Verify/Reject/Reverse) is **structurally absent from the DOM** for them, not disabled. Record form always inline. Verify/Reject apply only to `pending` rows, Reverse only to `verified` rows, each a separate reason-required `FormDialog`, each independently re-checked server-side with row-locked status transitions. **Reverse flips the same row's status in place — no linked "Reversal of #X" record** (§B9, §10 — do not copy the academy-side linked-reversal pattern here). Payment method is free text, not an enum (§10 item 10). Evidence upload has no real storage yet (§10 item 7). **Acceptance**: two concurrent actions on the same payment row yield exactly one success and one specific "already processed" rejection; every reason-required action rejects an empty reason both client- and server-side.

### `/platform/usage`
`platform_owner` or a `platform_admin` granted `getPlatformReports` — the most permissive partial-access path in this cluster. **Not a table** — a card-per-academy stack, five `UsageBar` rows each (Branches/Students/Staff/Courses/Storage), a whole-card red ring when any resource is at/over limit. **All five counters are real** (correcting a stale comment elsewhere in the codebase that called student-count a stub — §10 item 16's correction applies here too) — branches/students/staff/courses are live `COUNT(*)` queries, storage is a real R2 byte-sum that fails-safe to 0 rather than hard-failing. **Display and enforcement are deliberately decoupled**: this page shows the last-Recalculated snapshot; real allowance enforcement (`checkAllowance`) always recomputes live at creation time, never reading this cached snapshot — stated plainly in the page's own header copy. Recalculate fires no success toast (§10 item 17). Usage bars have no ARIA progressbar semantics (§10 item 18). **Acceptance**: this page's displayed data never gates or blocks any create action elsewhere in the product — enforcement is architecturally separate, not merely "usually in sync."

### `/platform/staff`
`platform_owner`-only, closes a specific privilege-escalation path (a `platform_admin` can never grant themselves or a peer staff-management capability). Exactly 3 capabilities are grantable today (`recordSubscriptionPayment`, `queryAuditLogs`, `getPlatformReports`); 16 render as permanently disabled checkboxes with always-visible inline text "Owner only — this permission cannot be granted" (not a hover tooltip, despite `DESIGN.md` §3's generic "Permission-locked control" pattern describing one — functionally fine, arguably more accessible). 4 one-click preset buttons (Support/Finance/Onboarding/Technical) are a UI-only convenience, no DB model. Revoke has zero confirmation step, unlike every other "remove access" pattern in the product — worth flagging, not silently fixing. **Acceptance**: a new `platform_admin` account starts with zero granted capabilities; the grantable list is expected to grow in later phases, so design should not assume exactly 3 forever.

### `/platform/reports`
`platform_owner` full; a granted `platform_admin` sees the trend/expiring sections but the entire Revenue section (heading, group-by, Export) is **absent from the DOM**, not disabled — the ungrantable `platform.revenue.view` gate is enforced inside the data function itself (`revenue` comes back `null`), a stronger pattern than client-side hiding, worth preserving in any redesign. No chart anywhere on this page — the identical active-academy-trend series renders as a chart on Dashboard and a plain table here (§10 item 11). Expiring Subscriptions caps at 50 rows with no pagination/"view all" escape hatch — a real completeness gap at scale. Export is a client-side CSV blob download, no new server route. **Acceptance**: changing the revenue group-by never affects the other two sections; the CSV always matches the current group-by and the viewer's own permission scope.

### `/platform/audit-logs`
`platform_owner` full; a granted `platform_admin` gets **full, unrestricted** access — no internal two-tier split like Reports. Plain `<form method="get">` filter bar (6 free-text/date inputs, not removable chips, not pickers), real SQL-level pagination. **No row expand, no before/after display, no Export button** — a flat 5-column table (When/Actor/Action/Entity/Result), despite `before`/`after` JSON existing on every row in the schema and despite `DESIGN.md` describing a shared expandable component with the academy version (§10 items 5–6, the most significant documented-vs-implemented gaps in this entire cluster). A past bug (showing only role, not actor identity) is already fixed — every row now resolves to a real actor email or "System." **Acceptance**: any redesign that assumes Export or an expand interaction already exists here is designing ahead of the current implementation — build those features explicitly, don't assume them present.

### `/platform/settings`
`platform_owner`-only (unconfirmed judgment call, §10 item 2) — the single most under-built page in the console: a read-only stub showing 3 env-var-backed switches (SMS kill switch, registrations-open, maintenance mode) via badges, **zero interactive controls**, explicitly not `DESIGN.md`'s toggle-form description, because no persistence layer exists and a fake toggle would mislead. No `platform_settings`/config table exists anywhere in the schema. **Acceptance**: do not design a toggle form for this page until a schema change lands — design the honest, current, read-only state, including its always-visible explanatory warning banner.

## B12. Validation requirements

Run after any implementation change, and report results honestly — **never claim a check passed without having run it this session**:
- **Type check**: `npx tsc --noEmit` — must be clean.
- **Lint**: `npm run lint` — must show 0 errors (pre-existing warnings in `.github/skills/` vendored scripts are not this project's concern).
- **Tests**: `npm test` (vitest). **Known, pre-existing issue from this session**: the suite has shown intermittent Neon DB connection drops/timeouts (`Connection terminated unexpectedly`, 15s test timeouts on DB-backed subscription tests) unrelated to UI changes — re-run before concluding a failure is a real regression, and never report "tests passed" if any failed, even ones attributable to this flakiness.
- **Responsive check**: manually verify the Platform shell's real 1025px breakpoint (not just Tailwind's 1024px default) and the Academy shell's drawer behavior at mobile widths, in a running dev server — type checking and lint do not verify visual/responsive correctness.
- **Design-system check**: if `.claude/skills/impeccable/scripts/impeccable detect --json app components lib/ui` is available, re-run it after any shared-component change and compare against the established baseline (2 known false-positive findings as of this session) — a new finding is a real regression to investigate, not an automatic pass.

