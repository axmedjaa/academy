"use client";

import { useState } from "react";
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

  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg }}>
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
          className="platform-shell-scrim"
          style={{ position: "fixed", inset: 0, backgroundColor: "rgba(15, 23, 42, 0.5)", zIndex: 40 }}
        />
      )}

      <aside
        className="platform-shell-sidebar"
        style={{
          position: "fixed",
          top: 0,
          left: drawerOpen ? 0 : undefined,
          bottom: 0,
          width: shell.sidebarWidth,
          backgroundColor: color.primaryNavy,
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
            borderBottom: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontWeight: 700, color: "#fff" }}>Afoogy</span>
            <span style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.55)" }}>Platform Console</span>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="platform-shell-close-btn"
            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)" }}
          >
            <Icon name="close" />
          </button>
        </div>

        <nav style={{ padding: spacing.sm, display: "flex", flexDirection: "column", gap: "2px" }}>
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setDrawerOpen(false)}
                className={active ? "" : "platform-shell-navlink"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.sm,
                  padding: "0.55rem 0.75rem",
                  borderRadius: 10,
                  textDecoration: "none",
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

        <div style={{ marginTop: "auto", padding: spacing.sm, borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: "2px" }}>
          <Link
            href="/account/security"
            onClick={() => setDrawerOpen(false)}
            className="platform-shell-navlink"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.sm,
              padding: "0.55rem 0.75rem",
              borderRadius: 10,
              textDecoration: "none",
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
              className="platform-shell-navlink"
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
                color: "rgba(255,255,255,0.75)",
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
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="platform-shell-menu-btn"
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
        .platform-shell-account-link:hover {
          background-color: #dbe6fd;
        }
        @media (max-width: 1024px) {
          .platform-shell-sidebar {
            left: -${shell.sidebarWidth}px;
            transition: left 0.2s ease;
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
