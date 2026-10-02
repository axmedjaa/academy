"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import { hasExpandableSubItems, type AcademyNavItem, type AcademyNavSubItem } from "@/lib/academies/nav-items";
import type { AcademyRole } from "@/lib/auth/roles";
import { signOut } from "@/lib/auth/actions";
import { color, shell, spacing } from "@/lib/ui/theme";

/**
 * PLAN.md/DESIGN.md §2 "App Shell" — the one shared sidebar/topbar frame
 * for every `/academy/*` page. Structural layout (fixed 260px sidebar,
 * fixed 64px header, grouped nav, card-style user/notification affordances)
 * follows stitch_resource_file_manager/.../dashboard_1/code.html; colors
 * come from DESIGN.md §1 (lib/ui/theme.ts), not Stitch's own drifted
 * tokens, per this task's "DESIGN.md is authoritative on conflict"
 * instruction.
 *
 * A single client component (not split further) because the mobile drawer
 * open/close state and the active-link highlight (`usePathname`) both need
 * client-side React — every piece of *data* it renders (nav items already
 * filtered by role, academy name, unread count) is resolved server-side in
 * app/academy/layout.tsx and passed down as plain props, so no client-side
 * data fetching or duplicate permission logic happens here.
 */
const ROLE_LABELS: Record<AcademyRole, string> = {
  academy_owner: "Academy Owner",
  academy_admin: "Academy Administrator",
  manager: "Manager",
  admissions_officer: "Admissions Officer",
  finance_officer: "Finance Officer",
  trainer: "Trainer",
};

interface Props {
  className?: string;
  navItems: AcademyNavItem[];
  subItemsByParent: Record<string, AcademyNavSubItem[]>;
  academyName: string;
  branchChipLabel: string;
  membershipRole: AcademyRole;
  unreadNotificationsCount: number;
  graceBanner: ReactNode;
  children: ReactNode;
}

export function AcademyShell({
  className,
  navItems,
  subItemsByParent,
  academyName,
  branchChipLabel,
  membershipRole,
  unreadNotificationsCount,
  graceBanner,
  children,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  // Navigation-density pass — mobile accordion. Only the group containing
  // the current route starts expanded; every other group with children
  // starts collapsed (section 1/5 of the request: "keep the current page's
  // group automatically visible... unrelated groups should preferably
  // remain collapsed"). `isActive(item.href)` alone misses a child whose
  // own href differs from the parent's (e.g. viewing "Courses" under
  // "Academics", whose own href is "/academy/programs") — the second half
  // of this check closes that gap so the right group expands no matter
  // which of its children the user is actually on.
  const activeGroupKey =
    navItems.find((item) => {
      const subItems = subItemsByParent[item.key] ?? [];
      if (!hasExpandableSubItems(item, subItems)) return false;
      return isActive(item.href) || subItems.some((sub) => isActive(sub.href));
    })?.key ?? null;

  // True single-open accordion (not a Set): expanding one group is meant to
  // collapse whatever else was open, never stack into "every section
  // expanded at once" (section 5's explicit "avoid creating a giant
  // expanded menu"). Re-syncs to the active group whenever the route
  // changes (so navigating elsewhere always re-reveals the right group),
  // but between navigations a manual expand/collapse click sticks.
  //
  // Adjusted during render rather than in a useEffect — the documented
  // React pattern for "reset this state when a derived value changes"
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // a conditional setState call during render is applied before the browser
  // paints, so it never causes an extra visible render or a cascading
  // effect the way the same reset inside useEffect would.
  const [expandedKey, setExpandedKey] = useState<string | null>(activeGroupKey);
  const [syncedGroupKey, setSyncedGroupKey] = useState<string | null>(activeGroupKey);
  if (activeGroupKey !== syncedGroupKey) {
    setSyncedGroupKey(activeGroupKey);
    setExpandedKey(activeGroupKey);
  }

  // Mobile drawer behavior (section 4): lock background scroll while open,
  // close on Escape, move focus into the drawer on open and back to the
  // hamburger button on close (every close path — Escape, scrim click, nav
  // link click, or the close button itself — flips `drawerOpen` to false,
  // so this one effect's cleanup covers all of them uniformly).
  const hamburgerButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    const hamburgerButton = hamburgerButtonRef.current;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      hamburgerButton?.focus();
    };
  }, [drawerOpen]);

  return (
    <div className={className} style={{ minHeight: "100vh", backgroundColor: color.bg }}>
      {/* Phase 5 addition: a standard "skip to main content" link — invisible
       * until keyboard-focused, then it jumps straight past the sidebar's
       * ~15 nav links to the page's own content. Every `/academy/*` page
       * was previously unreachable by keyboard without first tabbing through
       * the entire nav on every single page load. */}
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[200] -translate-y-16 rounded-control bg-ink px-4 py-2 text-sm font-semibold text-white transition-transform duration-150 focus-visible:translate-y-0"
      >
        Skip to main content
      </a>

      {/* Mobile drawer scrim — always mounted (not conditionally rendered)
       * so its opacity can transition smoothly instead of popping in/out
       * instantly; `pointer-events` follows the same boolean so it never
       * intercepts clicks on the page behind it while invisible. */}
      <div
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(15, 23, 42, 0.4)",
          zIndex: 40,
          opacity: drawerOpen ? 1 : 0,
          pointerEvents: drawerOpen ? "auto" : "none",
        }}
        className="academy-shell-scrim"
      />

      <aside
        id="academy-shell-sidebar"
        className="academy-shell-sidebar"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: shell.sidebarWidth,
          // `transform` instead of the old `left` — transform/opacity are
          // the two properties a browser can animate on the compositor
          // alone; `left` forces layout on every frame. Open forces the
          // on-screen position regardless of breakpoint (a no-op at
          // desktop, which never applies the off-screen transform below).
          transform: drawerOpen ? "translateX(0)" : undefined,
          backgroundColor: color.card,
          borderRight: `1px solid ${color.border}`,
          display: "flex",
          flexDirection: "column",
          zIndex: 50,
          // The brand header and account footer below are fixed chrome —
          // only the <nav> between them (flex: 1 1 auto + its own
          // overflowY) is the scroll container, so opening a drawer with
          // many items never scrolls the header or footer out of view
          // ("the navigation area should be the primary scroll container,
          // not the entire drawer").
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            height: shell.headerHeight,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `0 ${spacing.lg}`,
            borderBottom: `1px solid ${color.border}`,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontWeight: 700, color: color.primaryNavy }}>Afoogy</span>
            <span style={{ fontSize: "0.7rem", color: color.textMuted }}>Skill Academy</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="academy-shell-close-btn rounded-control p-3 transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98]"
            style={{ background: "none", border: "none", cursor: "pointer", color: color.textMuted }}
          >
            <Icon name="close" />
          </button>
        </div>

        <nav
          aria-label="Academy navigation"
          className="academy-shell-nav gap-1 min-[1025px]:gap-0.5"
          style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: spacing.sm, display: "flex", flexDirection: "column" }}
        >
          {navItems.map((item) => {
            const subItems = subItemsByParent[item.key] ?? [];
            const expandable = hasExpandableSubItems(item, subItems);
            const active = isActive(item.href);
            const expanded = expandedKey === item.key;
            const subNavId = `academy-subnav-${item.key}`;
            return (
              // A group with its own sub-items gets a little extra breathing
              // room below the cluster before the next top-level item
              // starts, so "this parent + its children" reads as one visual
              // unit rather than every row looking equally adjacent to every
              // other row — tighter at desktop, where every group already
              // stays expanded and the list is already longer.
              <div key={item.key} className={expandable ? "pb-2 min-[1025px]:pb-1" : ""}>
                <div className="flex items-center gap-1">
                  {/* Active state: a tinted fill + brand-colored text/icon +
                   * a 3px left accent — a lighter-weight "you are here" cue.
                   * The transparent border on the inactive state reserves
                   * the same 3px so nothing shifts width when a link
                   * becomes active. This row always navigates to the
                   * item's own page on click, on both breakpoints —
                   * expand/collapse (mobile only, when the group has real
                   * children) is a separate control beside it, so no
                   * existing destination is ever hidden behind a
                   * must-expand-first tap. Row padding is taller at and
                   * below the drawer breakpoint (py-3, ~44px touch target)
                   * and compact above it (min-[1025px]:py-1.5) — matched
                   * exactly to the shell's own `min-width: 1025px` desktop
                   * rule below, not Tailwind's default `lg:` (1024px),
                   * which would otherwise disagree with this shell's own
                   * breakpoint by one pixel (e.g. an exact 1024px-wide
                   * iPad-landscape viewport is still drawer mode here). */}
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex flex-1 items-center gap-3 rounded-control border-l-[3px] px-3 py-3 text-sm no-underline transition-colors duration-150 motion-safe:active:scale-[0.98] min-[1025px]:py-1.5 ${
                      active
                        ? "border-brand bg-brand-tint font-semibold text-brand"
                        : "border-transparent font-medium text-ink hover:bg-app"
                    }`}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                  {expandable && (
                    <button
                      type="button"
                      onClick={() => setExpandedKey((current) => (current === item.key ? null : item.key))}
                      aria-expanded={expanded}
                      aria-controls={subNavId}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${item.label}`}
                      className="flex shrink-0 items-center justify-center rounded-control p-3 text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] min-[1025px]:hidden"
                    >
                      <span
                        className={`flex motion-safe:transition-transform motion-safe:duration-150 ${expanded ? "rotate-180" : ""}`}
                      >
                        <Icon name="expand_more" />
                      </span>
                    </button>
                  )}
                </div>
                {expandable && (
                  // `data-mobile-collapsed` only matters below the 1024px
                  // breakpoint (see the scoped <style> block's
                  // .academy-subnav-collapse rules) — at desktop this group
                  // always renders expanded regardless of `expanded`,
                  // matching "groups can remain visible" there. The inner
                  // div is the grid row's one child — its own overflow:
                  // hidden is what makes the outer grid-template-rows
                  // animation actually clip the content while collapsing,
                  // rather than letting it stick out of a shrinking row.
                  <div id={subNavId} data-mobile-collapsed={expanded ? "false" : "true"} className="academy-subnav-collapse">
                    <div className="ml-6 flex flex-col gap-0.5 overflow-hidden border-l border-border pl-3">
                      {subItems.map((sub) => {
                        const subActive = isActive(sub.href);
                        return (
                          <Link
                            key={sub.href}
                            href={sub.href}
                            onClick={() => setDrawerOpen(false)}
                            className={`rounded-control px-2.5 py-2.5 text-[0.82rem] no-underline transition-colors duration-150 motion-safe:active:scale-[0.98] min-[1025px]:py-1 ${
                              subActive
                                ? "bg-brand-tint font-semibold text-brand"
                                : "font-normal text-muted hover:bg-app hover:text-ink"
                            }`}
                          >
                            {sub.label}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div style={{ flexShrink: 0, padding: spacing.sm, borderTop: `1px solid ${color.border}` }}>
          <Link
            href="/account/security"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center gap-3 rounded-control px-3 py-3 text-sm font-medium text-muted no-underline transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] min-[1025px]:py-2"
          >
            <Icon name="settings" />
            <span>Account settings</span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-control border-none bg-transparent px-3 py-3 text-left text-sm font-medium text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] min-[1025px]:py-2"
            >
              <Icon name="logout" />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </aside>

      <div className="academy-shell-content" style={{ marginLeft: shell.sidebarWidth }}>
        <header
          style={{
            position: "sticky",
            top: 0,
            height: shell.headerHeight,
            backgroundColor: color.card,
            borderBottom: `1px solid ${color.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `0 ${spacing.lg}`,
            zIndex: 30,
            gap: spacing.md,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, minWidth: 0 }}>
            <button
              ref={hamburgerButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="academy-shell-sidebar"
              className="academy-shell-menu-btn rounded-control p-3 transition-colors duration-150 hover:bg-app motion-safe:active:scale-[0.98]"
              style={{ background: "none", border: "none", cursor: "pointer", color: color.text, display: "none" }}
            >
              <Icon name="menu" />
            </button>
            {/* `min-w-0` is load-bearing here, not decorative: a flex
             * child's default min-width is its own content width, which
             * silently defeats `truncate`'s ellipsis (the box can never
             * shrink enough to show "…") — without it, a long academy
             * name just gets hard-clipped mid-character on a narrow
             * screen instead of cleanly truncating.
             *
             * `flex-1` alone is NOT enough to prioritize this span over
             * the branch chip below, and was previously documented
             * (wrongly) as if it did: Tailwind's `flex-1` is
             * `flex: 1 1 0%` — a 0% *basis* — while the chip's default
             * `flex: 0 1 auto` gives it its own full content width as
             * its basis. In the flex distribution algorithm the chip's
             * auto-basis is satisfied FIRST; this span only ever gets
             * whatever's left over via flex-grow. On a narrow phone
             * (e.g. a 390px screen with a longer role chip on the
             * right), that leftover could shrink to a handful of
             * pixels even for a short name like "Dardar" — the chip,
             * not this span, was winning the width tug-of-war. Fixed
             * below by hiding the purely decorative chip+divider under
             * `sm` (640px) so this span gets the entire row on phones;
             * tablet/desktop (where the chip still shows) are
             * unchanged. */}
            <span className="min-w-0 flex-1 truncate font-semibold tracking-tight text-ink">{academyName}</span>
            <span className="hidden shrink-0 sm:block" style={{ height: "1rem", width: 1, backgroundColor: color.border }} />
            {/* DESIGN.md §2.2 Academy/Branch Context Chip — static label, see lib/academies/shell.ts's module comment for why this isn't a functional filter yet. Hidden below `sm` (640px): decorative/non-functional, so on a phone it's the first thing to give up its space to the academy name above, not compete with it. */}
            <span className="hidden min-w-0 shrink truncate text-[0.8rem] text-muted sm:block">{branchChipLabel}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: spacing.md, flexShrink: 0 }}>
            <Link
              href="/academy/notifications"
              aria-label={`Notifications${unreadNotificationsCount > 0 ? `, ${unreadNotificationsCount} unread` : ""}`}
              className="flex rounded-control p-3 text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98]"
            >
              {/* Badge anchors to this inner, icon-sized box rather than the
               * outer (now more generously padded) button, so it always
               * sits at the bell's own corner regardless of the button's
               * touch-target padding. */}
              <span style={{ position: "relative", display: "flex" }}>
                <Icon name="notifications" />
                {unreadNotificationsCount > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 8,
                      backgroundColor: color.statusRed,
                      color: "#fff",
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 3px",
                    }}
                  >
                    {unreadNotificationsCount > 99 ? "99+" : unreadNotificationsCount}
                  </span>
                )}
              </span>
            </Link>
            {/* Account/role chip — matches the Platform shell's own role
             * pill exactly (same tokens, same hover) rather than the plain
             * text link this used to be, so the two consoles' header
             * "account/profile area" read as the same product. */}
            <Link
              href="/account/security"
              title="Account settings — update your email or password"
              className="academy-shell-account-chip"
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                color: color.primaryBlue,
                backgroundColor: color.statusBlueBg,
                padding: "0.25rem 0.6rem",
                borderRadius: 999,
                whiteSpace: "nowrap",
                textDecoration: "none",
                transition: "background-color 0.15s ease",
              }}
            >
              {ROLE_LABELS[membershipRole]}
            </Link>
          </div>
        </header>

        {graceBanner}

        <main
          id="main-content"
          tabIndex={-1}
          className="px-4 py-6 outline-none sm:px-6 sm:py-8"
          style={{ maxWidth: shell.contentMaxWidth, margin: "0 auto" }}
        >
          {children}
        </main>
      </div>

      {/* Responsive behavior (DESIGN.md §2/§12): sidebar becomes a slide-in
       * drawer under 1024px, hamburger button appears, content margin
       * collapses to 0. Plain CSS (no JS breakpoint logic) matching this
       * codebase's existing convention of a small number of hand-written
       * @media rules (app/globals.css) rather than a CSS-in-JS/breakpoint
       * library. */}
      <style>{`
        .academy-shell-account-chip:hover {
          background-color: #dbe6fd;
        }
        /* Nav scrollbar: invisible at rest, a thin 6px thumb appears only
           on hover/keyboard-focus of the nav region — a scroll affordance
           that doesn't visually compete with the active item, icons, or
           accordion chevrons when the sidebar is just sitting there. Track
           stays transparent and width never changes between states, so
           this never shifts nav content or layout width — purely a resting
           vs. interacting color swap, same scroll behavior either way.
           Firefox (scrollbar-width/scrollbar-color) and WebKit
           (::-webkit-scrollbar-*) need separate rules; both default to
           invisible and reveal on the same :hover/:focus-within pair. */
        .academy-shell-nav {
          scrollbar-width: none;
          scrollbar-color: transparent transparent;
        }
        .academy-shell-nav:hover,
        .academy-shell-nav:focus-within {
          scrollbar-width: thin;
          scrollbar-color: rgba(15, 23, 42, 0.18) transparent;
        }
        .academy-shell-nav::-webkit-scrollbar {
          width: 6px;
        }
        .academy-shell-nav::-webkit-scrollbar-track {
          background: transparent;
        }
        .academy-shell-nav::-webkit-scrollbar-thumb {
          background-color: transparent;
          border-radius: 999px;
          transition: background-color 0.2s ease;
          /* WebKit computes the thumb's own length proportionally from the
             scroll ratio and gives authors no height/max-height to override
             that — this is the one real lever: an invisible top/bottom
             border (left/right stay 0, so the 6px width is untouched) with
             background-clip: padding-box paints the thumb's color inset
             from both ends of that computed box, so the visible pill reads
             shorter without changing the native hit area, drag behavior,
             or scroll math. */
          border-top: 3px solid transparent;
          border-bottom: 3px solid transparent;
          background-clip: padding-box;
        }
        .academy-shell-nav:hover::-webkit-scrollbar-thumb,
        .academy-shell-nav:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(15, 23, 42, 0.18);
        }
        .academy-shell-scrim {
          transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        /* Accordion expand/collapse — animated instead of the old instant
           display:none/block snap. grid-template-rows: 0fr/1fr is the
           standard CSS-only technique for collapsing a block whose content
           height isn't known ahead of time (no JS measuring scrollHeight,
           no ResizeObserver, no forced reflow from script). visibility is
           paired with a transition-delay so a collapsed group's links drop
           out of the tab order and the accessibility tree only once the
           collapse finishes — and come back instantly the moment it starts
           expanding — matching what display:none used to guarantee. 1fr is
           the resting default (desktop's permanent "expanded" state);
           only the mobile media query below ever asks for 0fr. */
        .academy-shell-sidebar .academy-subnav-collapse {
          display: grid;
          grid-template-rows: 1fr;
          visibility: visible;
          transition: grid-template-rows 200ms cubic-bezier(0.77, 0, 0.175, 1);
        }
        .academy-shell-sidebar .academy-subnav-collapse > div {
          transition: opacity 200ms ease;
          opacity: 1;
        }
        @media (max-width: 1024px) {
          .academy-shell-sidebar {
            transform: translateX(-100%);
            /* A percentage transform (not a hardcoded -260px) slides by the
               sidebar's own width regardless of shell.sidebarWidth, and
               transform/opacity are the only properties a browser can
               animate purely on the compositor — the old "left" transition
               forced a layout pass on every frame. A custom ease-out curve
               (entering/exiting content) replaces the built-in "ease",
               which reads as noticeably weaker/less intentional at the
               same duration. */
            transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
            box-shadow: 2px 0 12px rgba(15, 23, 42, 0.15);
          }
          .academy-shell-content {
            margin-left: 0 !important;
          }
          .academy-shell-menu-btn {
            display: flex !important;
          }
          .academy-shell-close-btn {
            display: inline-flex;
          }
          /* A collapsed group's row collapses to 0fr and its content fades
             out — only below the drawer breakpoint; at desktop the base
             rule above (1fr, no media query) always wins, matching "groups
             can remain visible" there regardless of accordion state. */
          .academy-shell-sidebar .academy-subnav-collapse[data-mobile-collapsed="true"] {
            grid-template-rows: 0fr;
            visibility: hidden;
            transition: grid-template-rows 200ms cubic-bezier(0.77, 0, 0.175, 1), visibility 0s linear 200ms;
          }
          .academy-shell-sidebar .academy-subnav-collapse[data-mobile-collapsed="true"] > div {
            opacity: 0;
          }
        }
        @media (min-width: 1025px) {
          .academy-shell-scrim {
            display: none;
          }
          .academy-shell-close-btn {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .academy-shell-sidebar,
          .academy-shell-scrim,
          .academy-shell-sidebar .academy-subnav-collapse,
          .academy-shell-sidebar .academy-subnav-collapse > div {
            transition: none !important;
          }
        }
        @media (prefers-reduced-motion: no-preference) {
          .academy-shell-account-chip:active {
            transform: scale(0.98);
          }
        }
      `}</style>
    </div>
  );
}
