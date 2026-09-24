/**
 * Hand-rolled inline SVG icons for the academy shell's nav/topbar. The
 * Stitch mockups use Google's "Material Symbols Outlined" icon font loaded
 * from Google Fonts — not used here: this app currently makes zero external
 * network requests for styling/fonts (next/font/google self-hosts what it
 * loads), and pulling in an icon font would be the first CDN dependency in
 * the whole codebase. Same "no new dependency, inline SVG" precedent this
 * codebase already established for charts (app/academy/reports/page.tsx's
 * BarChart). Icon names below match the `icon` keys used in
 * lib/academies/nav-items.ts (Material Symbols' own naming, kept only as a
 * stable key — the actual glyphs are custom strokes, not that font).
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

const ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  dashboard: (props) => (
    <Base {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Base>
  ),
  group: (props) => (
    <Base {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.2c2.9.5 5 2.6 5 5.8" />
    </Base>
  ),
  badge: (props) => (
    <Base {...props}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <circle cx="12" cy="11" r="2.5" />
      <path d="M8 20c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5" />
      <path d="M9 5V3.5h6V5" />
    </Base>
  ),
  school: (props) => (
    <Base {...props}>
      <path d="M2 8l10-4 10 4-10 4-10-4z" />
      <path d="M6 10.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.5" />
      <path d="M22 8v6" />
    </Base>
  ),
  fact_check: (props) => (
    <Base {...props}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M7 9l1.5 1.5L11 8" />
      <path d="M13.5 9.5h5" />
      <path d="M7 15l1.5 1.5L11 14" />
      <path d="M13.5 15.5h5" />
    </Base>
  ),
  payments: (props) => (
    <Base {...props}>
      <rect x="2.5" y="6" width="19" height="13" rx="2" />
      <path d="M2.5 10.5h19" />
      <path d="M6 14.5h4" />
    </Base>
  ),
  workspace_premium: (props) => (
    <Base {...props}>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14 7 21l5-2.5L17 21l-1.5-7" />
    </Base>
  ),
  bar_chart: (props) => (
    <Base {...props}>
      <path d="M4 20V10" />
      <path d="M12 20V4" />
      <path d="M20 20v-7" />
      <path d="M2 20h20" />
    </Base>
  ),
  notifications: (props) => (
    <Base {...props}>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Base>
  ),
  receipt_long: (props) => (
    <Base {...props}>
      <path d="M6 2h12v19l-3-2-2 2-2-2-2 2-3-2V2z" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </Base>
  ),
  settings: (props) => (
    <Base {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </Base>
  ),
  menu: (props) => (
    <Base {...props}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </Base>
  ),
  close: (props) => (
    <Base {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Base>
  ),
  expand_more: (props) => (
    <Base {...props}>
      <path d="m6 9 6 6 6-6" />
    </Base>
  ),
  print: (props) => (
    <Base {...props}>
      <path d="M6 9V3h12v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M6 14h12v7H6z" />
    </Base>
  ),
  search: (props) => (
    <Base {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Base>
  ),
  // Added for the Platform Owner console shell (app/platform/_shell) — same
  // "hand-rolled inline SVG, no icon font" convention as every icon above.
  apartment: (props) => (
    <Base {...props}>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 7h1M8 11h1M8 15h1M15 7h1M15 11h1M15 15h1" />
      <path d="M10.5 21v-3h3v3" />
    </Base>
  ),
  inventory_2: (props) => (
    <Base {...props}>
      <rect x="3" y="7" width="18" height="13" rx="1.5" />
      <path d="M3 11h18" />
      <path d="M9 11v3h6v-3" />
      <path d="M8 3.5h8L18 7H6l2-3.5z" />
    </Base>
  ),
  autorenew: (props) => (
    <Base {...props}>
      <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
      <path d="M21 4v4h-4" />
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
      <path d="M3 20v-4h4" />
    </Base>
  ),
  speed: (props) => (
    <Base {...props}>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="M12 15l4-5" />
      <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </Base>
  ),
};

export function Icon({ name, ...props }: { name: string } & IconProps) {
  const Render = ICONS[name] ?? ICONS.dashboard;
  return <Render {...props} />;
}
