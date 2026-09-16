---
name: Executive Minimalist SaaS
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#434655'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0053db'
  primary: '#004ac6'
  on-primary: '#ffffff'
  primary-container: '#2563eb'
  on-primary-container: '#eeefff'
  inverse-primary: '#b4c5ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#006242'
  on-tertiary: '#ffffff'
  tertiary-container: '#007d55'
  on-tertiary-container: '#bdffdb'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
  primary-hover: '#1D4ED8'
  primary-subtle: '#EFF6FF'
  surface-page: '#F8FAFC'
  surface-card: '#FFFFFF'
  surface-subtle: '#F1F5F9'
  border-subtle: '#E2E8F0'
  border-strong: '#CBD5E1'
  status-paid-bg: '#ECFDF5'
  status-paid-text: '#047857'
  status-pending-bg: '#FFFBEB'
  status-pending-text: '#B45309'
  status-overdue-bg: '#FEF2F2'
  status-overdue-text: '#B91C1C'
  status-active-bg: '#EFF6FF'
  status-active-text: '#1D4ED8'
  status-completed-bg: '#F1F5F9'
  status-completed-text: '#475569'
typography:
  display:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 26px
    letterSpacing: -0.01em
  title:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  body-base:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-medium:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.01em
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  space-xxs: 0.25rem
  space-xs: 0.5rem
  space-sm: 0.75rem
  space-md: 1rem
  space-lg: 1.25rem
  space-xl: 1.5rem
  space-2xl: 2rem
  space-3xl: 2.5rem
  sidebar-width: 260px
  header-height: 64px
  content-max-width: 1400px
---

## Brand & Style

This design system targets academy directors, training managers, and operational staff who need to balance student records, manual accounting, and certificate workflows swiftly. The brand tone is trustworthy, grounded, executive, and relentlessly clear.

### Aesthetic Approach
The interface uses a Modern Minimalist SaaS framework inspired by high-utility productivity suites. It prioritizes:
- **Low cognitive overhead:** Interfaces favor clean information hierarchy, progressive disclosure, and single-purpose operational views over dashboard clutter.
- **Utilitarian clarity:** Subtle borders, precise geometry, and calm slate typography ensure data density without feeling claustrophobic.
- **Restraint:** No decorative gradients, glassmorphism, or illustrative distractions. All visual weight is reserved for critical status communication, pending actions, and active batch states.

## Colors

The palette is engineered around clean functional contrast. Pure white (`#FFFFFF`) cards float effortlessly above a soft slate canvas (`#F8FAFC`), structured cleanly by faint hairline borders (`#E2E8F0`).

### Color Roles & Guidelines
- **Primary (`#2563EB`):** Reserved strictly for interactive calls to action, selected active sidebar destinations, and primary table actions.
- **Secondary / Headings (`#0F172A`):** Anchors table headings, typography headers, and primary data figures.
- **Muted Neutral (`#64748B`):** Handles supportive metadata, secondary timestamps, field labels, and disabled states.
- **Status Accents:** Statuses strictly follow a two-tier badge formula using low-saturation backgrounds paired with high-contrast text to ensure WCAG AAA accessibility on tabular views.

## Typography

Inter serves as the single typographic workhorse, delivering tabular numerals, clean vertical metrics, and crisp legibility across dense administrative tables.

### Rules & Formatting
- **Data Tables:** Numerical figures (e.g., balance dues, amounts, IDs) use tabular figures (`font-variant-numeric: tabular-nums`) to align vertically.
- **Hierarchy:** Maintain strict structural separation—page titles never exceed 24px in core workflows to preserve vertical scanning space for operational cards and filters.
- **Labels:** Field descriptors and table column headers sit at 12px or 13px medium/semibold to balance visual weight against data entry text.

## Layout & Spacing

The layout philosophy is desktop-first, structured around a fixed persistent left sidebar (260px), a persistent utilities header (64px), and a responsive canvas with a 1400px outer boundary.

### Grid & Responsiveness
- **Desktop (1280px and up):** Fixed 260px navigation pane; main content features 32px padding (`space-2xl`) and fluid 12-column card layouts.
- **Tablet / Laptop (1024px to 1279px):** Sidebar remains visible; container margins compress to 24px (`space-xl`); multi-column stats collapse to 3-column rows.
- **Mobile / Narrow Tablet (< 1024px):** Sidebar converts into an off-canvas drawer controlled by a persistent header hamburger button. Forms and split payment panes reflow to a single stack.
- **Spacing Rhythm:** Standard spacing increments adhere to an 8pt system (4px, 8px, 12px, 16px, 24px, 32px) to align form fields, input heights, and table row heights cleanly.

## Elevation & Depth

This system avoids heavy drop shadows and exaggerated blurs. Visual structure relies on surface contrast and low-contrast perimeter outlines.

### Elevation Hierarchy
- **Canvas (`#F8FAFC`):** Lowest layer containing all views.
- **Surface Cards / Panels (`#FFFFFF`):** Sits on the canvas wrapped in a crisp border (`1px solid #E2E8F0`) accompanied by an ambient micro-shadow: `0 1px 3px 0 rgba(15, 23, 42, 0.04), 0 1px 2px -1px rgba(15, 23, 42, 0.02)`.
- **Dropdowns & Popovers:** `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)`, bounded by `1px solid #E2E8F0`.
- **Modals & Drawers:** `0 20px 25px -5px rgba(15, 23, 42, 0.12), 0 8px 10px -6px rgba(15, 23, 42, 0.06)`, framed over a dimmed backdrop (`rgba(15, 23, 42, 0.4)`).

## Shapes

The design maintains an understated, professional posture. Elements use soft, tailored corners that convey modern precision without appearing playful or juvenile.

### Radius Matrix
- **Buttons, Inputs, Badges, Dropdowns:** `6px` to `8px` (`rounded-md` / `rounded-lg`).
- **Cards, Panels, Modals:** `8px` to `10px`.
- **Pills / Status Dots:** Circular or full pill shapes strictly for numerical counter chips and status indicators.

## Components

### Buttons
- **Primary Button:** Background `#2563EB`, text `#FFFFFF`, font weight 500, height 40px, padding 0 16px, border-radius 8px. Hover: `#1D4ED8`. Active: `#1E40AF`.
- **Secondary Button:** Background `#FFFFFF`, border `1px solid #E2E8F0`, text `#0F172A`. Hover: `#F8FAFC` with border `#CBD5E1`.
- **Destructive Button:** Background `#FEF2F2`, border `1px solid #FEE2E2`, text `#B91C1C`. Hover: `#FEE2E2`.

### Input Fields & Controls
- **Inputs & Selects:** Height 40px, border `1px solid #E2E8F0`, background `#FFFFFF`, text `#0F172A`, placeholder `#94A3B8`, border-radius 6px, padding 0 12px. Focus: border `#2563EB`, subtle focus ring `0 0 0 3px rgba(37, 99, 235, 0.12)`.
- **Search Bar:** Incorporates a leading search icon in `#94A3B8`, standard input styling, with integrated clear shortcut or dismiss button.
- **Checkboxes & Radios:** 18px dimensions, border `1px solid #CBD5E1`, selected background `#2563EB`, checked tick in `#FFFFFF`.

### Status Badges
- Displayed as inline-flex items: height 24px, padding 0 8px, border-radius 6px, typography 12px semibold.
- **Paid / Completed:** `#ECFDF5` background, `#047857` text.
- **Pending / In Progress:** `#FFFBEB` background, `#B45309` text.
- **Overdue / Alert:** `#FEF2F2` background, `#B91C1C` text.
- **Active / Verified:** `#EFF6FF` background, `#1D4ED8` text.

### Data Tables
- Encased in white panels with a subtle outer border.
- **Table Header:** Height 44px, background `#F8FAFC`, text `#64748B`, 12px uppercase or semibold title, border-bottom `1px solid #E2E8F0`.
- **Table Row:** Height 56px, background `#FFFFFF`, border-bottom `1px solid #F1F5F9`, hover background `#F8FAFC`.
- **Cell Content:** Text `#0F172A`, body-base (14px). Numerical data right-aligned where applicable.

### Metric Cards
- Background `#FFFFFF`, padding 20px, border `1px solid #E2E8F0`, border-radius 8px.
- Structure: Small muted label (13px, `#64748B`), large primary metric (24px bold, `#0F172A`), supportive delta or contextual note at bottom.

### Operational Components
- **Attendance Toggles:** Triple segmented button (Present, Late, Absent) per student row. Present defaults to soft green when active, Late to amber, Absent to soft red.
- **Certificate Preview Sheet:** Centered A4 ratio card, pure white, subtle double-border layout, formal stamp placeholder, and prominent unique verification code anchor.