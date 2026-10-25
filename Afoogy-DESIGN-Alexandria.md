# Afoogy

## Overview

Afoogy is a multi-tenant **academy/school management SaaS** — not a consumer or children's product. It serves two structurally separate audiences who never share a navigation tree: **Platform Owner/Administrator** users who manage academies, subscriptions, plans, and platform-wide billing, and **Academy** users (Owner, Admin, Manager, Admissions Officer, Finance Officer, Trainer) who run day-to-day academy operations — admissions, staff, academics, exams/results, finance, certificates, reports, audit logs. The authenticated session's membership determines which entire shell renders; it is never a client-side toggle (`DESIGN.md` §2.1).

The product is dense, operational, and built for desktop-first data work (dashboards, data tables, finance screens, mark-entry grids, audit logs) with select mobile-usable flows (login, approvals, lookups — `DESIGN.md` §12). The visual tone is **calm, professional, and trustworthy** — closer to a well-built operations console than a marketing site or a consumer app. Clarity and legibility take priority over personality: every status is readable at a glance, every destructive action is named explicitly before it happens, and nothing is ever decorative for its own sake.

**This document is implementation-ready and describes what is actually built**, verified against `app/globals.css`, `lib/ui/theme.ts`, `lib/ui/status.ts`, and `app/academy/_shell/ui.tsx` — not aspirational values. Where this document's guidance differs from the authoritative `DESIGN.md`, that is called out explicitly rather than silently overridden; `DESIGN.md` remains the source of truth for screens, navigation, permissions, and UX copy. This file exists to give an implementing agent the exact visual/token/component vocabulary `DESIGN.md` assumes but doesn't spell out in code terms.

## Colors

Sourced 1:1 from `DESIGN.md` §1 and implemented identically in `app/globals.css`'s `@theme` block and `lib/ui/theme.ts` — the two are kept in sync by convention; never introduce a third copy of these values.

**Dardar School System rebrand** (color tokens only): the brand is now a single primary hue (burgundy) rather than a separate navy/blue pair — `primaryNavy`/`--color-navy` and `primaryBlue`/`--color-brand` now hold the same value. A new gold accent token exists for sparing highlight use.

- **Brand / Navy** (`#850019`, burgundy): Primary brand color — surfaces/headers, navigation emphasis (e.g. dialog overlay tint `bg-navy/40`, Platform shell sidebar). The former "Navy" and "Brand/Interactive Blue" tokens are now the same burgundy value.
- **Brand / Interactive** (`#850019`, burgundy): Primary CTAs, links, active nav states, focus rings
- **Brand Hover** (`#6B0014`): Hover/pressed state for brand-filled buttons
- **Brand Tint** (`#F9E8EC`): Light burgundy surface for "selected/active" rows and informational highlight backgrounds — distinct from status tokens below; reserved for brand emphasis, never status semantics
- **Accent Gold** (`#F5B638`): Sparing accent/highlight use only (e.g. the ID card's thin accent border, the brand mark's accent dot). Never a background behind white/light text, never small text color on a light surface — pair with dark ink text or the dark burgundy surface
- **App Background** (`#F7F8FA`): Page background behind the sidebar/header/cards
- **Surface** (`#FFFFFF`): Card, sidebar, header, input, modal background
- **Border** (`#E2E5EA`): Default hairline borders (cards, table dividers)
- **Border Strong** (`#CBD5E1`): Input borders, higher-contrast separators
- **Muted** (`#6B7280`): Secondary/metadata text, labels, captions
- **Ink** (`#111827`): Primary body/heading text

**Status colors** — one meaning each, used identically everywhere via the shared `Badge`/`StatusBadge` component and `getStatusTone()` (`lib/ui/status.ts`). **Six tones are currently implemented**: gray, amber, green, red, blue, slate.

| Tone | Foreground | Background | Meaning |
|---|---|---|---|
| Gray | `#6B7280` | `#F1F5F9` | Draft, neutral, inactive, archived, withdrawn |
| Amber | `#B45309` | `#FFFBEB` | Pending, awaiting approval, suspended, unpaid, low stock |
| Green | `#047857` | `#ECFDF5` | Approved, active, verified, paid, completed, issued, in stock |
| Red | `#B91C1C` | `#FEF2F2` | Rejected, cancelled, overdue, out of stock, error |
| Blue | `#1D4ED8` | `#EFF6FF` | Informational |
| Slate | `#475569` | `#F1F5F9` | Reversed / closed-adjacent (deliberately duller, reads as permanently inert) |

> **Known gap, not yet implemented**: `DESIGN.md` §1 additionally specifies a **deep teal/violet** tone for "published/final/locked" states (e.g. a published exam result), visually distinct from both green (active) and slate (closed), so "locked because finalized" is never confused with "locked because archived." No such token exists yet in `lib/ui/theme.ts` or `lib/ui/status.ts` — published/locked states currently fall back to whatever tone the calling page chooses (commonly blue or slate). **Do not silently invent this token's exact hex when implementing it** — treat it as an open design decision to resolve explicitly, not a value to guess.

## Typography

- **Primary Font**: **Alexandria** — the defining typeface for Afoogy, used throughout the product UI for headings, navigation, forms, tables, dashboards, finance screens, and body copy.
- **Fallback**: `system-ui, sans-serif`
- **Mono**: **JetBrains Mono** — fixed-width values only: IDs, reference/certificate codes, audit-log technical fields. Money amounts use tabular numerals within the primary sans font (see below), not mono.

> **Implementation status**: the codebase currently ships **Geist Sans / Geist Mono** (`next/font/google`, wired in `app/layout.tsx` as `--font-geist-sans`/`--font-geist-mono`, consumed by `app/globals.css`'s `--font-sans`), not Alexandria or JetBrains Mono. The Alexandria/JetBrains Mono decision is **preserved here as the intended typography** per prior direction, but swapping the actual font files/`next/font` config is unimplemented work — do not assume Alexandria is already rendering anywhere in the app today.

Do not use Hubot Sans, Atkinson Hyperlegible, or Lexend Deca — Alexandria is the product font.

Font weights (match `DESIGN.md` §1's "clear size hierarchy" requirement):
- 400 — regular body text
- 500 — labels, secondary emphasis, table headers (`uppercase tracking-wide`)
- 600 — buttons, badges, navigation emphasis, KPI card values aside from Hero/H1
- 700 — page titles, section headers, large KPI numbers

Type scale — hierarchy required by `DESIGN.md` §1 ("page title > section header > table header > body > caption"), sized against what's actually implemented (`PageHeader`, `StatCard`, table headers in `app/academy/_shell/ui.tsx`):

| Role | Size / Line-height | Weight | Notes |
|---|---|---|---|
| Page Title (H1) | 20px / 28px, scaling to 24px / 32px at `sm:` and above | 700 | `PageHeader`'s `<h1>` |
| Section Header (H2) | 18px / 28px | 600 | Card/section headings |
| KPI Number | 28px / 1 (tight) | 700 | `StatCard` value, tabular numerals, `-0.01em` tracking |
| Body | 14px / 20px | 400 | Default table/form/body text |
| Body Large | 16px / 24px | 400 | Reading-dense content, longer form descriptions |
| Small / Label | 13px / 18px (`0.8rem`) | 500 | `StatCard` label, field labels |
| Caption | 12px / 18px (`0.75rem`) | 400–600 | Table header labels (uppercase), badges, hints, timestamps |

Money and IDs: tabular numerals (`fontVariantNumeric: tabular-nums` / Tailwind `tabular-nums`), currency `$`-prefixed, two-decimal, right-aligned in table cells (`DESIGN.md` §3 Form spec).

## Elevation

- **Radius**: `8px` on controls (buttons, inputs, small chips) via `--radius-control`; `12px` on cards and modals via `--radius-card`; `999px` (full pill) on status badges and avatar circles. Matches `DESIGN.md` §1 ("6–8px controls/badges, 12px cards/modals") with badges specifically using a full pill rather than the control radius.
- **Shadow at rest**: cards and sections (`Card`, `Section`, `TableWrap`) carry both a 1px `border` **and** a subtle resting shadow — `shadow-card: 0 1px 3px rgba(15, 23, 42, 0.06)`. This is slightly softer than `DESIGN.md` §1's literal "flat + 1px border at rest; soft shadow only on floating elements" wording — in practice every static surface gets a faint ambient shadow, not zero shadow. Treat the implemented `shadow-card` as the real baseline; reserve the stronger `shadow-card-hover` (`0 4px 16px rgba(15, 23, 42, 0.1)`) strictly for hover/interactive elevation (clickable `StatCard`, `interactive` `Section`), never a static resting card.
- **Modals/dropdowns**: use the same `rounded-card`/`border-border`/`bg-surface`/`shadow-card` combination as static cards (not a separate, heavier shadow tier) — see `AlertDialogContent`. Overlay is `bg-navy/40`.
- **Focus**: every interactive element gets a `2px solid` brand-colored outline with `2px` offset (`:focus-visible` in `app/globals.css`) as the universal floor; Tailwind-based components additionally layer a richer `focus-visible:ring-2 ring-brand/40`. Never removed, never color-alone — an outline is a shape.

## Components

One component per concept, reused everywhere (`DESIGN.md` §3's core rule: never a bespoke badge/table/modal per module). Names below match the actual exports in `app/academy/_shell/ui.tsx` and `components/ui/`.

- **Button** (`Button`, `LinkButton`): six variants — `primary` (brand fill), `secondary` (bordered, surface fill), `outline` (bordered, transparent), `ghost` (no border/background at rest), `danger` (outlined, for reversible destructive actions like Archive/Remove access), `dangerSolid` (solid red fill, reserved for **permanent** deletion only — deliberately louder so it's never confused with `danger`). All share `rounded-control`, `px-4 py-2`, `text-sm font-semibold`, a `150ms ease-out` color/transform transition, and `active:scale-[0.98]` press feedback (motion-safe only).
- **Badge / StatusBadge**: pill-shaped (`rounded-full`), `text-xs font-semibold`, tone from the six-color status system above — icon or text label always paired with color per the accessibility floor; never color alone. One component reused for subscription status, result status, payment status, certificate status, notification type, stock status — never a bespoke badge per module (`DESIGN.md` §3).
- **Usage/Allowance Bar** (`UsageBar`): label + "used / limit" (tabular numerals) + a thin (`1.5` height) rounded progress track. Green under 80%, amber 80–99%, red at/over 100%. Always names the specific resource — never a generic "usage" bar.
- **Data Table** (`TableWrap` + `th`/`td`/`trHover`): horizontally-scrolling wrapper on a `rounded-card`/`border`/`shadow-card` surface; sticky uppercase-caption header (`th`); `150ms` hover background transition per row (`trHover`); filter bar above (`Toolbar`) with search + dropdown filters + removable active-filter chips; row actions as 1–2 inline icons or a "⋯" overflow menu at 3+; pagination (page numbers + prev/next + page size + "Showing X–Y of Z"); Export button only on the four surfaces `DESIGN.md` §11.6 names (Reports, Student list, Finance, Audit Logs) — no other table gets one.
- **Form** (`Field` + `inputClass`): label always visible above the control (`text-xs font-medium text-muted`); `inputClass` gives every native input/select/textarea a consistent `rounded-control`, `border-border-strong`, `px-3 py-2`, `text-sm`, brand focus ring, and disabled styling; inline field-level error renders below the control in `text-danger` on blur/submit, never only on submit.
- **Card / Section**: `Card` (inline-style, legacy call sites) and `Section` (Tailwind, current call sites) are the same visual primitive — `rounded-card`, `border-border`, `bg-surface`, `shadow-card`, `p-5`/`p-[spacing.lg]` padding. Pass `interactive` on `Section` only when the whole block is itself a click target (adds hover elevation); never apply a hover shadow to a non-clickable static section.
- **StatCard**: dashboard KPI tile — label + icon row, large tabular-numeral value, optional hint line. Staggers in with `animate-fade-in-up` (60ms delay per index) on first render; optionally a `Link` wrapper with `active:scale-[0.98]` press feedback when it links to its own module.
- **Modal / Confirmation Dialog** (`AlertDialog*` / `FormDialog`): centered, `max-w-md` (or wider via `FormDialog`'s `className` override for multi-field forms), capped at `85vh` with internal scroll, `16px` minimum viewport gutter on narrow screens. Plain confirmations for reversible actions; **strong-worded** confirmations (naming the specific record and specific consequence, never a bare "Are you sure?") for one-way actions, per `DESIGN.md` §11.7's copy library. Entrance `scale-in`/`fade-in` at 180ms, exit `scale-out`/`fade-out` at 120ms (deliberately faster — closing should feel instant).
- **Toast** (`sonner`): bottom-corner, auto-dismissing, for successful async actions (save/publish/approve) that don't need a full page state change.
- **Alert / Banner**: full-width, persistent (not auto-dismissing) — subscription-suspended, academy-closed, permission-denied, onboarding-incomplete states. Distinct visually from a toast; never used for routine success.
- **Tabs**: entity detail pages with distinct sub-views (Academy Detail, Student Profile, etc. — see `DESIGN.md` §3/§7–§9 for the exact tab sets per screen).
- **Stepper**: multi-step forms (e.g. Academy Registration) and workflow-state visualization (Exam Result: Draft → Marks Entered → Submitted → Under Review → Approved/Rejected → Published).
- **Approval Queue**: filtered list of submitted-but-undecided items with an Approve/Reject pair per row; Reject always opens a modal requiring a stated reason — no reject without one. The actor's own submission shows Approve **disabled with a tooltip** ("You can't approve a transaction you recorded") rather than hidden — the one deliberate exception to "absent, not disabled" below.
- **Permission-locked control**: a toggle/button rendered visibly present but disabled with an explanatory tooltip — reserved narrowly for self-approval and permanently-owner-only capabilities (e.g. "Owner only — this permission cannot be granted"), where the *absence* of a familiar control would itself read as a bug. Everywhere else, an inaccessible action is simply **omitted**, never shown disabled (`DESIGN.md` §5's "Rule for building any screen").
- **File Upload / Drop-zone**: drag-or-browse control, thumbnail/filename preview once attached, remove/replace action, inline type/size validation, and — for academy-owned files only — a live storage-allowance check using the standard limit-reached message.
- **MFA Code Input**: 6-digit input, distinct "Use a recovery code instead" link swapping to a single-field recovery-code input, same loading/error/lockout treatment as the login form.
- **Audit-log Row**: expandable — actor name + role, action, target entity, branch (if applicable), result badge, timestamp; expands to show before/after values. Identical component on both the platform and academy audit log screens.
- **Read-only / Locked Banner**: persistent, non-dismissible strip at the top of a record indicating it can't be edited — Published results (teal/violet once implemented, lock icon) and Closed academies (slate, archive icon) must remain visually distinct from each other so the two meanings are never confused.
- **EmptyState**: centered icon (optional) + one-line explanation + primary action if relevant (e.g. "No students yet — Add your first student").
- **ErrorMessage**: inline, `role="alert"`, `text-danger`/`bg-danger-bg`/`border-danger` card — specific and actionable, never a generic failure string.
- **Loading / Skeleton** (`SkeletonBlock`, `Pulse`, `ListPageSkeleton`): shape-matched skeleton rows/cards (`animate-pulse`, `motion-reduce:animate-none`) — never a full-page spinner except initial app load or the auth screens.
- **Breadcrumbs** / **BackLink**: `BackLink` ("← Back to X") is the default for 1–2 level-deep detail pages; `Breadcrumbs` is reserved for genuinely 3+-level-deep routes.
- **PageHeader**: title + optional one-line description + right-aligned actions, stacking to full-width on narrow screens instead of squeezing the action button.

### Standard Screen States

Applied to every list/detail/form screen unless explicitly overridden (`DESIGN.md` §3.1): Loading (skeleton), Empty, Error (retry for transient failures), Success (toast or inline badge), Validation (inline, on blur/submit), Confirmation (required before any consequential action), Permission-denied (calm full-section message, never a raw error page), No-access/subscription-or-closure (full-page, non-dismissible), Search-no-results (distinct from Empty, includes a clear-filters action).

## Spacing

- **Base unit**: 4px, following `DESIGN.md` §1's 4/8/12/16/24/32/48 scale.
- **Implemented scale** (`lib/ui/theme.ts` `spacing`, in rem): `xxs` 4px, `xs` 8px, `sm` 12px, `md` 16px, `lg` 20px, `xl` 24px, `xxl` 32px. Note `lg` (20px) sits between the spec's 16 and 24 — it's the default `Card`/`Section` padding and the one value outside the clean 4-point scale; treat it as an established exception, not an error to "fix."
- **Card padding**: 24px desktop (`xl`/`p-5`–`p-6` range), 16px mobile (`md`), matching `DESIGN.md` §1.
- **Container**: `max-w-6xl` (`PAGE_WRAP`) for content pages; the academy/platform shell's own content area caps at `1400px` (`shell.contentMaxWidth`).
- **App shell**: sidebar `260px` wide on desktop; header `56px` tall (a deliberate navigation-density reduction from an earlier `64px`).
- **Responsive breakpoint for the shell**: the sidebar collapses straight to a slide-in drawer (hamburger trigger) at **1024px**, a single breakpoint — not the three-tier desktop/tablet/mobile system `DESIGN.md` §2 and §12 describe (≥1280 desktop, 768–1024 icon-rail/drawer tablet, ≤428 mobile). There is currently no separate "icon rail" tablet state; treat 1024px as the real, implemented cutover point when reasoning about shell behavior, while still following `DESIGN.md` §12's per-screen mobile-usability requirements (login, approvals, lookups, notifications, session management must work fully below that line).

## Motion

Grounded in `app/globals.css`'s registered `--ease-out`/`--ease-in-out`/`--animate-*` tokens — reuse these rather than inventing new curves or durations.

- **Standard easing**: `cubic-bezier(0.23, 1, 0.32, 1)` (`--ease-out`) for entrances/hover transitions; `cubic-bezier(0.77, 0, 0.175, 1)` (`--ease-in-out`) where a symmetrical curve is needed.
- **Interactive feedback**: buttons and `StatCard` links scale to `0.98` on press (`active:scale-[0.98]`), `150ms`, motion-safe only.
- **Hover transitions**: `150ms` color/background/transform on buttons, table rows, links.
- **Content entrance**: `fade-in-up`, `400ms`, staggered `60ms` per item — used for KPI cards/stat grids appearing on first render, never a looping or decorative animation.
- **Dialog/dropdown**: entrance `fade-in`/`scale-in` at `180ms`; exit `fade-out`/`scale-out` at `120ms` — closing is deliberately faster than opening since the user's attention has already moved on.
- **Progress / usage bars**: width transitions over `300ms`.
- **Charts**: line charts draw in once, left-to-right, over `1.1s` with `cubic-bezier(0.16, 1, 0.3, 1)`; bar charts rise from baseline over `0.6s` with the same curve family, staggered per bar — kept in the same curve family so a page with both chart types reads as one consistent motion language.
- **Reduced motion**: every animation is gated `motion-safe:`; skeletons additionally use `motion-reduce:animate-none` to stay a static placeholder. There is no confetti, particle, or celebratory motion anywhere in this product — motion here signals state change (loading, success, emphasis), never decoration or reward.

## Iconography

Hand-rolled inline SVG, not an icon font or illustrated/hand-drawn set — deliberately zero external network dependency (`app/academy/_shell/icons.tsx`). `24px` viewBox rendered at `20px` in navigation, `1.8px` stroke width, rounded line caps and joins, `stroke="currentColor"` so icons inherit their context's text color rather than carrying a hardcoded palette per icon. Icon-only controls always carry an accessible label (`aria-label` or equivalent) — never icon-alone with no text alternative for assistive tech.

## Accessibility

- **Contrast floor**: WCAG **AA** everywhere (`DESIGN.md` §1) — not AAA; don't over-engineer contrast ratios beyond what the palette above already delivers.
- **Color is never the sole signal**: every status/state pairs color with an icon and a text label, every correct/incorrect or pass/fail state likewise.
- **Focus**: visible focus rings on every interactive element, including legacy inline-style components with no Tailwind classes to opt into a ring utility — the global `:focus-visible` outline is the guaranteed floor.
- **Keyboard navigation**: all tables and menus must be fully keyboard-navigable.
- **Icon-only controls**: always carry an accessible label.
- **No dark mode**: the product intentionally pins `color-scheme: light` and ships one fixed light palette — a prior naive `prefers-color-scheme: dark` flip caused low-contrast "light-on-light" bugs because shared components hardcode light surface/text colors. Do not reintroduce a dark-mode toggle or media-query flip without a deliberate, full component-level re-design; this is a known, intentional constraint, not an oversight to "fix."
- **Tap targets**: no children's-app-style 56px minimum applies here — this is a desktop-first admin tool. Standard clickable control sizing (the implemented `Button`'s `px-4 py-2` footprint, ~40px tall) is the baseline; keep mobile-usable screens (`DESIGN.md` §12) comfortably tappable without inflating every control app-wide.

## Voice and Tone

B2B operational tone — clear, calm, specific, and never alarmist, even for destructive/blocking states. Pulled directly from `DESIGN.md` §11.7–§11.8's copy library; extend it in the same register rather than inventing a different voice elsewhere.

- Be specific about the record and the consequence, never a bare confirmation: *"This will permanently close [Academy]. All historical data is retained as read-only and can never be un-closed."* — not "Are you sure?"
- State limits and blocks plainly, with a next step where one exists: *"You've reached your plan's limit of 100 students."*
- Explain *why* a control is unavailable rather than hiding the reason: *"You can't approve a transaction you recorded."*
- Keep security/auth copy neutral and non-revealing: *"Invalid email or password."* / *"If that email exists, a reset link has been sent."* — identical wording whether or not the account exists, by design.
- Empty states are a short, matter-of-fact invitation to act: *"No students yet — Add your first student."*
- Reject actions always require a stated reason — never a reason-less reject.
- Never use alarmist or cutesy language. No exclamation-heavy copy, no "Oops!", no gamified praise — this is an operations tool used by academy staff making consequential decisions about students, money, and records.

## Do's and Don'ts

- Do use Alexandria consistently across the product UI once it's wired in; don't assume it's already live — the app currently renders Geist.
- Do reuse the one Badge/StatusBadge, Button, Data Table, Modal, and Form primitive everywhere — never invent a bespoke version per module.
- Do pair every status/correct/incorrect signal with an icon and label, never color alone.
- Do use tabular numerals for all money and ID values; `$`-prefix and two-decimal, right-align currency in tables.
- Do reserve Export buttons for exactly the four surfaces `DESIGN.md` §11.6 names (Reports, Student list, Finance, Audit Logs) — no other table gets one.
- Do omit an inaccessible nav item or action entirely for a role that can't use it — don't render it disabled. Reserve disabled-with-tooltip strictly for self-approval and permanently-owner-only capabilities.
- Do use skeleton loading states shaped to the real content — don't show a full-page spinner except on initial app load or the auth screens.
- Do keep Published/locked and Closed/archived states visually distinct — they must never be mistakable for each other, even before the teal/violet "published" token is implemented.
- Do gate every animation behind `motion-safe:` and keep skeletons `motion-reduce:animate-none` for `prefers-reduced-motion` users.
- Don't introduce confetti, mascots, badges-as-rewards, streaks, or any gamified/celebratory UI — this product has none, and none should be added without a deliberate, separate design decision.
- Don't apply children's-app sizing conventions (64px "big friendly buttons," 56px kid-sized tap targets, oversized rounded pill buttons) — this is a dense, desktop-first admin tool.
- Don't add a dark-mode toggle without a full component-level pass — the current light-only pin is intentional, not an oversight.
- Don't invent a hex value for the "published/locked" teal/violet status tone — flag it as an open decision if a screen needs it before the token exists.
- Don't use a shadow tier heavier than `shadow-card`/`shadow-card-hover` for any surface — modals, dropdowns, and cards all share the same two-tier elevation system; there is no third "modal shadow."
