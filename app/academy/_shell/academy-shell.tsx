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
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setDrawerOpen(false)}
                  className={active ? "" : "hover:bg-app"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.sm,
                    padding: "0.55rem 0.75rem",
                    borderRadius: 10,
                    textDecoration: "none",
                    color: active ? "#fff" : color.text,
                    backgroundColor: active ? color.primaryBlue : "transparent",
                    fontSize: "0.9rem",
                    fontWeight: active ? 600 : 500,
                    transition: "background-color 0.15s ease",
                  }}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
                {subItems.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", marginLeft: "2.2rem" }}>
                    {subItems.map((sub) => {
                      const subActive = pathname === sub.href;
                      return (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          onClick={() => setDrawerOpen(false)}
                          className="rounded-md hover:bg-app hover:text-ink"
                          style={{
                            padding: "0.35rem 0.5rem",
                            fontSize: "0.82rem",
                            textDecoration: "none",
                            color: subActive ? color.primaryBlue : color.textMuted,
                            fontWeight: subActive ? 600 : 400,
                            transition: "background-color 0.15s ease",
                          }}
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.sm,
              padding: "0.55rem 0.75rem",
              borderRadius: 10,
              textDecoration: "none",
              color: color.textMuted,
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
            className="rounded-md hover:bg-app hover:text-ink"
          >
            <Icon name="settings" />
            <span>Account settings</span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md hover:bg-app hover:text-ink"
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.sm,
                width: "100%",
                padding: "0.55rem 0.75rem",
                borderRadius: 10,
                background: "none",
                border: "none",
                cursor: "pointer",
                color: color.textMuted,
                fontSize: "0.9rem",
                fontWeight: 500,
                textAlign: "left",
              }}
            >
              <Icon name="close" />
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
            <span style={{ fontWeight: 600, color: color.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {academyName}
            </span>
            <span style={{ height: "1rem", width: 1, backgroundColor: color.border }} />
            {/* DESIGN.md §2.2 Academy/Branch Context Chip — static label, see lib/academies/shell.ts's module comment for why this isn't a functional filter yet. */}
            <span style={{ fontSize: "0.8rem", color: color.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {branchChipLabel}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: spacing.md, flexShrink: 0 }}>
            <Link
              href="/academy/notifications"
              aria-label={`Notifications${unreadNotificationsCount > 0 ? `, ${unreadNotificationsCount} unread` : ""}`}
              className="rounded-full p-1.5 hover:bg-app hover:text-ink"
              style={{ position: "relative", color: color.textMuted, display: "flex", transition: "background-color 0.15s ease" }}
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
              className="academy-shell-account-link"
              style={{
                display: "flex",
                flexDirection: "column",
                textAlign: "right",
                lineHeight: 1.1,
                borderRadius: 8,
                padding: "0.2rem 0.4rem",
                textDecoration: "none",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 600, color: color.text }}>
                {ROLE_LABELS[membershipRole]}
              </span>
            </Link>
          </div>
        </header>

        {graceBanner}

        <main className="px-4 py-6 sm:px-6 sm:py-8" style={{ maxWidth: 1400, margin: "0 auto" }}>
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
        .academy-shell-account-link:hover {
          background-color: ${color.bg};
        }
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
