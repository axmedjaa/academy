"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { signOut } from "@/lib/auth/actions";
import { color, shell, spacing } from "@/lib/ui/theme";
import type { PlatformNavItem } from "@/lib/platform/nav-items";

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
          width: shell.sidebarWidth,
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
            justifyContent: "space-between",
            padding: `0 ${spacing.lg}`,
            borderBottom: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontWeight: 700, color: "#fff" }}>Afoogy</span>
            <span style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.55)" }}>Platform Console</span>
          </div>
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
                onClick={() => setDrawerOpen(false)}
                className={`flex items-center gap-3 rounded-[10px] py-3 px-3 no-underline motion-safe:active:scale-[0.98] min-[1025px]:py-2 ${active ? "" : "platform-shell-navlink"}`}
                style={{
                  color: active ? "#fff" : "rgba(255,255,255,0.75)",
                  backgroundColor: active ? color.primaryBlue : "transparent",
                  fontSize: "0.9rem",
                  fontWeight: active ? 600 : 500,
                  transition: "background-color 0.15s ease, color 0.15s ease",
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
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
            href="/account/security"
            onClick={() => setDrawerOpen(false)}
            className="platform-shell-navlink flex items-center gap-3 rounded-[10px] py-3 px-3 no-underline motion-safe:active:scale-[0.98] min-[1025px]:py-2"
            style={{
              color: "rgba(255,255,255,0.75)",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            <Icon name="settings" />
            <span>Account settings</span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="platform-shell-navlink flex w-full items-center gap-3 rounded-[10px] py-3 px-3 text-left motion-safe:active:scale-[0.98] min-[1025px]:py-2"
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
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </aside>

      <div className="platform-shell-content" style={{ marginLeft: shell.sidebarWidth }}>
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
              className="platform-shell-menu-btn rounded-control p-3 transition-colors duration-150 hover:bg-app motion-safe:active:scale-[0.98]"
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
        .platform-shell-navlink:hover {
          background-color: rgba(255,255,255,0.08);
          color: #fff;
        }
        /* Nav scrollbar: invisible at rest, a thin 6px thumb appears only
           on hover/keyboard-focus of the nav region — mirrors the Academy
           shell's own treatment (app/academy/_shell/academy-shell.tsx),
           using this shell's own white-alpha convention instead of a
           light-mode gray so it doesn't clash with the dark navy rail.
           Track stays transparent and width never changes between states,
           so this never shifts nav content or layout width — purely a
           resting vs. interacting color swap, same scroll behavior either
           way. */
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
          width: 6px;
        }
        .platform-shell-nav::-webkit-scrollbar-track {
          background: transparent;
        }
        .platform-shell-nav::-webkit-scrollbar-thumb {
          background-color: transparent;
          border-radius: 999px;
          transition: background-color 0.2s ease;
          /* Same thumb-length inset as the Academy shell's own nav
             scrollbar (see that file's matching rule for the full
             rationale): an invisible top/bottom border, left/right at 0 so
             the 6px width is untouched, with background-clip: padding-box
             to paint the color shorter without touching the native hit
             area or scroll math. */
          border-top: 3px solid transparent;
          border-bottom: 3px solid transparent;
          background-clip: padding-box;
        }
        .platform-shell-nav:hover::-webkit-scrollbar-thumb,
        .platform-shell-nav:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.25);
        }
        .platform-shell-icon-btn:hover {
          background-color: rgba(255,255,255,0.08);
        }
        .platform-shell-account-link:hover {
          background-color: #dbe6fd;
        }
        .platform-shell-scrim {
          transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        @media (prefers-reduced-motion: reduce) {
          .platform-shell-sidebar,
          .platform-shell-scrim {
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
            transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
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
