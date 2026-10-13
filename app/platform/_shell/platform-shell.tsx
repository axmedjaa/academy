"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark, Icon } from "@/app/academy/_shell/icons";
import { signOut } from "@/lib/auth/actions";
import { color, shell, spacing } from "@/lib/ui/theme";
import type { PlatformNavItem } from "@/lib/platform/nav-items";

// Same useSyncExternalStore approach as app/academy/_shell/academy-shell.tsx
// (see that file's own comment for why this is the correct fit over
// useEffect+setState) — a separate storage key/event name so the two
// consoles' collapse preferences don't leak into each other.
const COLLAPSE_STORAGE_KEY = "platform-shell-collapsed";
const COLLAPSE_CHANGE_EVENT = "platform-shell-collapsed-change";

function subscribeToCollapsePref(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(COLLAPSE_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(COLLAPSE_CHANGE_EVENT, onStoreChange);
  };
}
function getCollapsePrefSnapshot() {
  return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
}
function getCollapsePrefServerSnapshot() {
  return false;
}

function subscribeToDesktopQuery(onStoreChange: () => void) {
  const mql = window.matchMedia("(min-width: 1025px)");
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}
function getIsDesktopSnapshot() {
  return window.matchMedia("(min-width: 1025px)").matches;
}
function getIsDesktopServerSnapshot() {
  return false;
}

/**
 * Platform Owner console shell — same structural pattern as
 * app/academy/_shell/academy-shell.tsx (fixed sidebar + sticky header,
 * CSS-only mobile drawer, no JS breakpoint library), reusing the exact same
 * brand tokens (lib/ui/theme.ts) and icon set (app/academy/_shell/icons.tsx)
 * so this reads as the same product, not a different app.
 *
 * The one deliberate visual difference from AcademyShell: a dark
 * (`color.primaryNavy`) sidebar instead of a light one. `/platform/*` is a
 * different persona/context (the SaaS operator, not an academy's own staff)
 * — DESIGN.md's own role tables keep Platform Owner and Academy Owner
 * clearly separate, and this task's own audit flagged route-naming ambiguity
 * between the two as a real risk. A dark "control tower" rail is a small,
 * low-risk way to make that distinction visible at a glance, without
 * inventing a new color (still `color.primaryNavy`, already in the palette)
 * or touching the academy shell at all.
 */
export function PlatformShell({
  navItems,
  roleLabel,
  children,
}: {
  navItems: PlatformNavItem[];
  roleLabel: string;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Desktop-persistent collapse-to-rail — same feature and reasoning as
  // AcademyShell's own (see that file's comment); mobile's drawer is
  // unaffected (`effectiveCollapsed` is false whenever `isDesktop` is
  // false, regardless of the stored preference).
  const collapsed = useSyncExternalStore(
    subscribeToCollapsePref,
    getCollapsePrefSnapshot,
    getCollapsePrefServerSnapshot,
  );
  function toggleCollapsed() {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "0" : "1");
    window.dispatchEvent(new Event(COLLAPSE_CHANGE_EVENT));
  }
  const isDesktop = useSyncExternalStore(subscribeToDesktopQuery, getIsDesktopSnapshot, getIsDesktopServerSnapshot);
  const effectiveCollapsed = collapsed && isDesktop;

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const currentItem = navItems.find((item) => isActive(item.href));

  // Mobile drawer behavior, mirroring app/academy/_shell/academy-shell.tsx:
  // lock background scroll while open, close on Escape, move focus into the
  // drawer on open and back to the hamburger button on close (every close
  // path flips `drawerOpen` to false, so this one effect's cleanup covers
  // all of them uniformly).
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
    <div style={{ minHeight: "100vh", backgroundColor: color.bg }}>
      {/* Always mounted (not conditionally rendered) so its opacity can
       * transition smoothly instead of popping in/out instantly; mirrors
       * app/academy/_shell/academy-shell.tsx's own scrim. */}
      <div
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
        className="platform-shell-scrim"
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(15, 23, 42, 0.5)",
          zIndex: 40,
          opacity: drawerOpen ? 1 : 0,
          pointerEvents: drawerOpen ? "auto" : "none",
        }}
      />

      <aside
        id="platform-shell-sidebar"
        className="platform-shell-sidebar"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: effectiveCollapsed ? shell.sidebarCollapsedWidth : shell.sidebarWidth,
          transition: "width 200ms var(--ease-in-out)",
          // `transform` instead of the old `left` — see the matching
          // comment in app/academy/_shell/academy-shell.tsx for why.
          transform: drawerOpen ? "translateX(0)" : undefined,
          backgroundColor: color.primaryNavy,
          display: "flex",
          flexDirection: "column",
          zIndex: 50,
          // The brand header and account footer below are fixed chrome —
          // only the <nav> between them (flex: 1 1 auto + its own
          // overflowY) is the scroll container, matching the Academy
          // shell's own fixed-header/scrolling-nav/fixed-footer structure.
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            height: shell.headerHeight,
            display: "flex",
            alignItems: "center",
            justifyContent: effectiveCollapsed ? "center" : "space-between",
            padding: effectiveCollapsed ? 0 : `0 ${spacing.lg}`,
            borderBottom: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          {effectiveCollapsed ? (
            // Collapsed rail: the brand mark itself is the expand control —
            // same pattern as AcademyShell's own collapsed header.
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="platform-shell-collapse-toggle rounded-control p-1 transition-transform duration-150 ease-out motion-safe:active:scale-[0.95]"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              <BrandMark size={28} fill="#fff" />
            </button>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: spacing.xs, minWidth: 0 }}>
                <BrandMark size={28} fill="#fff" />
                <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
                  <span style={{ fontWeight: 700, color: "#fff" }}>Afoogy</span>
                  <span style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.55)" }}>Platform Console</span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  className="platform-shell-collapse-toggle platform-shell-icon-btn rounded-control p-2 motion-safe:active:scale-[0.95]"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)" }}
                >
                  <span style={{ display: "flex", transform: "rotate(90deg)" }}>
                    <Icon name="expand_more" />
                  </span>
                </button>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="platform-shell-close-btn platform-shell-icon-btn rounded-control p-3 motion-safe:active:scale-[0.98]"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)" }}
                >
                  <Icon name="close" />
                </button>
              </div>
            </>
          )}
        </div>

        <nav
          aria-label="Platform navigation"
          className="platform-shell-nav gap-1 min-[1025px]:gap-0.5"
          style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: spacing.sm, display: "flex", flexDirection: "column" }}
        >
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              // Row padding is taller at and below the drawer breakpoint
              // (py-3, ~44px touch target) and compact above it
              // (min-[1025px]:py-2) — matched exactly to this shell's own
              // `min-width: 1025px` desktop rule below, not Tailwind's
              // default `lg:` (1024px), which would otherwise disagree with
              // this shell's breakpoint by one pixel.
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={effectiveCollapsed ? item.label : undefined}
                title={effectiveCollapsed ? item.label : undefined}
                onClick={() => setDrawerOpen(false)}
                className={`relative flex items-center gap-3 rounded-[10px] py-3 px-3 no-underline motion-safe:active:scale-[0.98] min-[1025px]:py-2 ${
                  effectiveCollapsed ? "min-[1025px]:justify-center min-[1025px]:px-0" : ""
                } ${active ? "" : "platform-shell-navlink"}`}
                style={{
                  color: active ? "#fff" : "rgba(255,255,255,0.75)",
                  backgroundColor: active ? color.primaryBlue : "transparent",
                  fontSize: "0.9rem",
                  fontWeight: active ? 600 : 500,
                  transition: "background-color 0.15s ease, color 0.15s ease, transform 0.15s var(--ease-out)",
                }}
              >
                <Icon name={item.icon} />
                {!effectiveCollapsed && <span>{item.label}</span>}
                {effectiveCollapsed && <span className="platform-shell-tooltip">{item.label}</span>}
              </Link>
            );
          })}
          {navItems.length === 0 && (
            <p style={{ padding: "0.55rem 0.75rem", fontSize: "0.8rem", color: "rgba(255,255,255,0.5)" }}>
              No platform tools are available for your account yet.
            </p>
          )}
        </nav>

        <div style={{ flexShrink: 0, padding: spacing.sm, borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: "2px" }}>
          <Link
            href="/account/activity"
            onClick={() => setDrawerOpen(false)}
            aria-label={effectiveCollapsed ? "My activity" : undefined}
            title={effectiveCollapsed ? "My activity" : undefined}
            className={`platform-shell-navlink relative flex items-center gap-3 rounded-[10px] py-3 px-3 no-underline motion-safe:active:scale-[0.98] min-[1025px]:py-2 ${
              effectiveCollapsed ? "min-[1025px]:justify-center min-[1025px]:px-0" : ""
            }`}
            style={{
              color: "rgba(255,255,255,0.75)",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            <Icon name="history" />
            {!effectiveCollapsed && <span>My activity</span>}
            {effectiveCollapsed && <span className="platform-shell-tooltip">My activity</span>}
          </Link>
          <Link
            href="/account/security"
            onClick={() => setDrawerOpen(false)}
            aria-label={effectiveCollapsed ? "Account settings" : undefined}
            title={effectiveCollapsed ? "Account settings" : undefined}
            className={`platform-shell-navlink relative flex items-center gap-3 rounded-[10px] py-3 px-3 no-underline motion-safe:active:scale-[0.98] min-[1025px]:py-2 ${
              effectiveCollapsed ? "min-[1025px]:justify-center min-[1025px]:px-0" : ""
            }`}
            style={{
              color: "rgba(255,255,255,0.75)",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            <Icon name="settings" />
            {!effectiveCollapsed && <span>Account settings</span>}
            {effectiveCollapsed && <span className="platform-shell-tooltip">Account settings</span>}
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              aria-label={effectiveCollapsed ? "Sign out" : undefined}
              title={effectiveCollapsed ? "Sign out" : undefined}
              className={`platform-shell-navlink relative flex w-full items-center gap-3 rounded-[10px] py-3 px-3 text-left motion-safe:active:scale-[0.98] min-[1025px]:py-2 ${
                effectiveCollapsed ? "min-[1025px]:justify-center min-[1025px]:px-0" : ""
              }`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "rgba(255,255,255,0.75)",
                fontSize: "0.9rem",
                fontWeight: 500,
              }}
            >
              <Icon name="logout" />
              {!effectiveCollapsed && <span>Sign out</span>}
              {effectiveCollapsed && <span className="platform-shell-tooltip">Sign out</span>}
            </button>
          </form>
        </div>
      </aside>

      <div
        className="platform-shell-content"
        style={{
          marginLeft: effectiveCollapsed ? shell.sidebarCollapsedWidth : shell.sidebarWidth,
          transition: "margin-left 200ms var(--ease-in-out)",
        }}
      >
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
              aria-controls="platform-shell-sidebar"
              className="platform-shell-menu-btn rounded-control p-3 transition-[color,background-color,border-color,transform] duration-150 ease-out hover:bg-app motion-safe:active:scale-[0.98]"
              style={{ background: "none", border: "none", cursor: "pointer", color: color.text, display: "none" }}
            >
              <Icon name="menu" />
            </button>
            <span style={{ fontWeight: 600, color: color.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {currentItem?.label ?? "Platform Console"}
            </span>
          </div>

          <Link
            href="/account/security"
            title="Account settings — update your email or password"
            className="platform-shell-account-link"
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
            {roleLabel}
          </Link>
        </header>

        <main className="px-4 py-6 sm:px-6 sm:py-8" style={{ maxWidth: 1400, margin: "0 auto" }}>
          {children}
        </main>
      </div>

      <style>{`
        /* Collapse/expand toggle: desktop-only, mirrors
           .platform-shell-close-btn's inverse visibility below. display
           is declared ONLY here (never as an inline style or a Tailwind
           flex utility class on the button) — see academy-shell.tsx's
           matching comment for the inline-style-beats-media-query bug this
           fixes. */
        .platform-shell-collapse-toggle {
          display: none;
          align-items: center;
          justify-content: center;
        }
        @media (min-width: 1025px) {
          .platform-shell-collapse-toggle {
            display: flex;
          }
        }
        /* Collapsed-rail tooltip: same CSS-only approach (position:fixed to
           escape the sidebar's own overflow:hidden, shown on :hover and
           :focus-visible) as academy-shell.tsx's .academy-shell-tooltip. */
        .platform-shell-tooltip {
          position: fixed;
          left: ${shell.sidebarCollapsedWidth + 8}px;
          opacity: 0;
          pointer-events: none;
          transform: translateX(-4px);
          transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out);
          background-color: ${color.primaryNavy};
          color: #fff;
          font-size: 0.75rem;
          font-weight: 600;
          white-space: nowrap;
          padding: 0.35rem 0.6rem;
          border-radius: 6px;
          z-index: 60;
        }
        a:hover .platform-shell-tooltip,
        a:focus-visible .platform-shell-tooltip,
        button:hover .platform-shell-tooltip,
        button:focus-visible .platform-shell-tooltip {
          opacity: 1;
          transform: translateX(0);
        }
        /* Base transition for BOTH directions (hover-in and hover-out) and
           for the active:scale press feedback — previously only the
           :hover state below was declared, so hover color and the press
           scale both snapped instantly with no transition at all. */
        .platform-shell-navlink {
          transition: background-color 150ms ease, color 150ms ease, transform 150ms var(--ease-out);
        }
        .platform-shell-navlink:hover {
          background-color: rgba(255,255,255,0.08);
          color: #fff;
        }
        /* Nav scrollbar: invisible at rest, a thin 4px thumb appears only
           on hover/keyboard-focus of the nav region — the plain native
           scrollbar, proportional thumb length and all, using this
           shell's own white-alpha convention instead of a light-mode gray
           so it doesn't clash with the dark navy rail. An earlier pass
           tried to style the native thumb into a short, fixed-size pill
           (border-inset hack) and then replaced it with a custom
           scroll-linked overlay; both were removed as more trouble than
           they were worth — this is the simple, honest version. */
        .platform-shell-nav {
          scrollbar-width: none;
          scrollbar-color: transparent transparent;
        }
        .platform-shell-nav:hover,
        .platform-shell-nav:focus-within {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
        }
        .platform-shell-nav::-webkit-scrollbar {
          width: 4px;
        }
        .platform-shell-nav::-webkit-scrollbar-track {
          background: transparent;
        }
        .platform-shell-nav::-webkit-scrollbar-thumb {
          background-color: transparent;
          border-radius: 999px;
          transition: background-color 150ms var(--ease-out);
        }
        .platform-shell-nav:hover::-webkit-scrollbar-thumb,
        .platform-shell-nav:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.25);
        }
        .platform-shell-nav::-webkit-scrollbar-thumb:hover {
          background-color: rgba(255, 255, 255, 0.4);
        }
        .platform-shell-icon-btn {
          transition: background-color 150ms ease, transform 150ms var(--ease-out);
        }
        .platform-shell-icon-btn:hover {
          background-color: rgba(255,255,255,0.08);
        }
        .platform-shell-account-link:hover {
          background-color: #dbe6fd;
        }
        .platform-shell-scrim {
          transition: opacity 200ms var(--ease-out);
        }
        @media (prefers-reduced-motion: reduce) {
          .platform-shell-sidebar,
          .platform-shell-content,
          .platform-shell-scrim,
          .platform-shell-tooltip {
            transition: none !important;
          }
        }
        @media (prefers-reduced-motion: no-preference) {
          .platform-shell-account-link:active {
            transform: scale(0.98);
          }
        }
        @media (max-width: 1024px) {
          .platform-shell-sidebar {
            transform: translateX(-100%);
            /* A percentage transform (not a hardcoded -260px) slides by the
               sidebar's own width regardless of shell.sidebarWidth, and
               transform/opacity are the only properties a browser can
               animate purely on the compositor — the old "left" transition
               forced a layout pass on every frame. A custom ease-out curve
               (entering/exiting content) replaces the built-in "ease",
               which reads as noticeably weaker/less intentional at the
               same duration — mirrors the Academy shell's own drawer. */
            transition: transform 200ms var(--ease-out);
            box-shadow: 2px 0 12px rgba(15, 23, 42, 0.25);
          }
          .platform-shell-content {
            margin-left: 0 !important;
          }
          .platform-shell-menu-btn {
            display: flex !important;
          }
          .platform-shell-close-btn {
            display: inline-flex;
          }
        }
        @media (min-width: 1025px) {
          .platform-shell-scrim {
            display: none;
          }
          .platform-shell-close-btn {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}
