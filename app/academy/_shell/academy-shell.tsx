"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import type { AcademyNavItem, AcademyNavSubItem } from "@/lib/academies/nav-items";
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

      {/* Mobile drawer scrim */}
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.4)",
            zIndex: 40,
          }}
          className="academy-shell-scrim"
        />
      )}

      <aside
        className="academy-shell-sidebar"
        style={{
          position: "fixed",
          top: 0,
          left: drawerOpen ? 0 : undefined,
          bottom: 0,
          width: shell.sidebarWidth,
          backgroundColor: color.card,
          borderRight: `1px solid ${color.border}`,
          display: "flex",
          flexDirection: "column",
          zIndex: 50,
          overflowY: "auto",
        }}
      >
        <div
          style={{
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
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="academy-shell-close-btn"
            style={{ background: "none", border: "none", cursor: "pointer", color: color.textMuted }}
          >
            <Icon name="close" />
          </button>
        </div>

        <nav style={{ padding: spacing.sm, display: "flex", flexDirection: "column", gap: "2px" }}>
          {navItems.map((item) => {
            const subItems = subItemsByParent[item.key] ?? [];
            const active = isActive(item.href);
            return (
              <div key={item.key}>
                {/* Active state: a tinted fill + brand-colored text/icon + a
                 * 3px left accent, replacing the previous flat solid-blue
                 * fill — a lighter-weight "you are here" cue that also
                 * reads correctly for a whole section (parent items stay
                 * highlighted while any of their sub-routes is open, via
                 * `isActive`'s prefix match). The transparent border on the
                 * inactive state reserves the same 3px so nothing shifts
                 * width when a link becomes active. */}
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setDrawerOpen(false)}
                  className={`flex items-center gap-3 rounded-control border-l-[3px] px-3 py-2 text-sm no-underline transition-colors duration-150 ${
                    active
                      ? "border-brand bg-brand-tint font-semibold text-brand"
                      : "border-transparent font-medium text-ink hover:bg-app"
                  }`}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
                {subItems.length > 0 && (
                  <div
                    className="ml-[1.6rem] flex flex-col gap-px border-l border-border pl-3"
                  >
                    {subItems.map((sub) => {
                      const subActive = pathname === sub.href;
                      return (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          onClick={() => setDrawerOpen(false)}
                          className={`rounded-control px-2.5 py-1.5 text-[0.82rem] no-underline transition-colors duration-150 ${
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
                )}
              </div>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto", padding: spacing.sm, borderTop: `1px solid ${color.border}` }}>
          <Link
            href="/account/security"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium text-muted no-underline transition-colors duration-150 hover:bg-app hover:text-ink"
          >
            <Icon name="settings" />
            <span>Account settings</span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-control border-none bg-transparent px-3 py-2 text-left text-sm font-medium text-muted transition-colors duration-150 hover:bg-app hover:text-ink"
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
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="academy-shell-menu-btn"
              style={{ background: "none", border: "none", cursor: "pointer", color: color.text, display: "none" }}
            >
              <Icon name="menu" />
            </button>
            <span className="truncate font-semibold tracking-tight text-ink">{academyName}</span>
            <span style={{ height: "1rem", width: 1, backgroundColor: color.border }} />
            {/* DESIGN.md §2.2 Academy/Branch Context Chip — static label, see lib/academies/shell.ts's module comment for why this isn't a functional filter yet. */}
            <span className="truncate text-[0.8rem] text-muted">{branchChipLabel}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: spacing.md, flexShrink: 0 }}>
            <Link
              href="/academy/notifications"
              aria-label={`Notifications${unreadNotificationsCount > 0 ? `, ${unreadNotificationsCount} unread` : ""}`}
              className="flex rounded-full p-1.5 text-muted transition-colors duration-150 hover:bg-app hover:text-ink"
              style={{ position: "relative" }}
            >
              <Icon name="notifications" />
              {unreadNotificationsCount > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
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
            </Link>
            <Link
              href="/account/security"
              title="Account settings — update your email or password"
              className="flex flex-col rounded-lg px-2 py-1 text-right leading-tight no-underline transition-colors duration-150 hover:bg-app"
            >
              <span className="text-[0.85rem] font-semibold text-ink">{ROLE_LABELS[membershipRole]}</span>
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
        @media (max-width: 1024px) {
          .academy-shell-sidebar {
            left: -${shell.sidebarWidth}px;
            transition: left 0.2s ease;
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
        }
        @media (min-width: 1025px) {
          .academy-shell-scrim {
            display: none;
          }
          .academy-shell-close-btn {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}
