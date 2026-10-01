/**
 * Shared visual tokens for the `/academy/*` shell and the screens built on
 * top of it (dashboard, certificates, id-cards — see each route's own
 * module comment). DESIGN.md §1 ("Visual System") is authoritative for the
 * actual color/spacing/radius values; the Stitch mockups
 * (stitch_resource_file_manager/.../dashboard_1/code.html) are the
 * structural/layout reference (260px sidebar, 64px header, card+shadow
 * stat tiles, Inter type, Material-style rounded controls) per this task's
 * "match Stitch as closely as practical, without conflicting with the
 * existing architecture" instruction.
 *
 * No CSS framework exists in this codebase (no Tailwind config, no
 * component library — confirmed by grep before this file was added) and
 * none is introduced here: every page in `/academy/*` and `/platform/*`
 * uses plain inline `style={{}}` objects today, so this file is a single
 * shared source of constants for those same inline styles rather than a
 * new styling system. Kept intentionally small — colors, spacing, radius,
 * shadow — not a full design-system abstraction.
 */
export const color = {
  // DESIGN.md §1 palette (authoritative — takes precedence over Stitch's
  // own drifted tokens, e.g. Stitch's primary #004ac6/#2563eb vs. this).
  primaryNavy: "#1B2A4A",
  primaryBlue: "#2F5FE0",
  primaryBlueHover: "#24499f",
  // Phase 1 addition — mirrors app/globals.css's `--color-brand-tint`. A
  // light brand-blue surface for "selected/active" and subtle highlight
  // backgrounds, kept in sync with the Tailwind side rather than each
  // system inventing its own value.
  primaryBlueTint: "#EEF2FF",
  bg: "#F7F8FA",
  card: "#FFFFFF",
  border: "#E2E5EA",
  borderStrong: "#CBD5E1",
  textMuted: "#6B7280",
  text: "#111827",

  // Status colors (§1: "one meaning each, used identically everywhere").
  statusGray: "#6B7280",
  statusGrayBg: "#F1F5F9",
  statusAmber: "#B45309",
  statusAmberBg: "#FFFBEB",
  statusGreen: "#047857",
  statusGreenBg: "#ECFDF5",
  statusRed: "#B91C1C",
  statusRedBg: "#FEF2F2",
  statusBlue: "#1D4ED8",
  statusBlueBg: "#EFF6FF",
  statusSlate: "#475569",
  statusSlateBg: "#F1F5F9",
} as const;

export const spacing = {
  xxs: "0.25rem",
  xs: "0.5rem",
  sm: "0.75rem",
  md: "1rem",
  lg: "1.25rem",
  xl: "1.5rem",
  xxl: "2rem",
} as const;

export const radius = {
  control: "8px",
  card: "12px",
} as const;

export const shadow = {
  card: "0 1px 3px 0 rgba(15, 23, 42, 0.06)",
  // Phase 1 addition — mirrors app/globals.css's `--shadow-card-hover`.
  // Subtle elevation increase for an interactive card on hover only, never
  // a static card's resting state.
  cardHover: "0 4px 16px 0 rgba(15, 23, 42, 0.1)",
} as const;

// Stitch's own fixed shell proportions (dashboard_1/code.html: `sidebar-width:
// 260px`, `header-height: 64px`) — kept as-is, they don't conflict with
// DESIGN.md (§2 "App Shell" specifies the same left-sidebar/top-header
// shape without pinning exact pixel widths).
export const shell = {
  sidebarWidth: 260,
  // Navigation-density pass: 64 -> 56. Used as a literal height for both
  // the sidebar's own brand masthead and the main content's sticky top bar
  // (grepped for every usage before changing — only those two places read
  // this token), so both shrink together for a denser professional feel.
  headerHeight: 56,
  // Phase 2 addition — was a bare inline "1400" literal in academy-shell.tsx;
  // pulled out here alongside its two siblings above rather than left as a
  // magic number, no value change.
  contentMaxWidth: 1400,
} as const;
