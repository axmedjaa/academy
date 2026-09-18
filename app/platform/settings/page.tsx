import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { getPlatformSettings, PLATFORM_SETTINGS_CAPABILITY } from "@/lib/platform/settings";

/**
 * PLAN.md Phase 5, Item 61b — `/platform/settings` (DESIGN.md: "Global
 * feature switches, simple toggle form"). Gated the same way as
 * app/platform/staff/page.tsx and app/platform/audit-logs/page.tsx: resolve
 * AuthContext, redirect to /login if unauthenticated, hasPermission() check,
 * calm access-denied message otherwise.
 *
 * `PLATFORM_SETTINGS_CAPABILITY` ("platform.settings.manage") is in
 * lib/auth/permissions.ts's `UNGRANTABLE_CAPABILITIES` — see that file's
 * comment on this specific entry for the judgment call (PLAN.md/DESIGN.md
 * never say whether this page is owner-only; treated as owner-only here,
 * consistent with this codebase's other platform-wide, no-scope levers like
 * plan pricing and staff/grant management, and flagged as a spec gap rather
 * than a confirmed rule).
 *
 * This renders a READ-ONLY display, not the "simple toggle form" DESIGN.md
 * describes — see lib/platform/settings.ts's module comment for the full
 * reasoning: no `platform_settings`-shaped table exists in lib/db/schema.ts
 * today, this item is barred from adding one, and a toggle form with no
 * real persistence would be actively misleading. A later wave that adds the
 * schema can turn this into the real toggle form.
 */
export default async function PlatformSettingsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, PLATFORM_SETTINGS_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const settings = getPlatformSettings();

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Platform settings</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Global, platform-wide feature switches — separate from any single
        academy&apos;s own plan or settings.
      </p>

      <div
        role="status"
        style={{
          border: "1px solid #f0c36d",
          background: "#fff8e6",
          borderRadius: 8,
          padding: "0.85rem 1rem",
          margin: "1rem 0",
          fontSize: "0.9rem",
        }}
      >
        These switches are currently <strong>read-only</strong>. Persisting a
        change requires a small schema addition that hasn&apos;t landed yet —
        the values below reflect this server&apos;s current environment
        configuration, not a database row that can be edited from here.
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "0.5rem 0" }}>Switch</th>
            <th style={{ textAlign: "left", padding: "0.5rem 0" }}>Current value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: "0.5rem 0" }}>
              SMS enabled platform-wide
              <div style={{ color: "#777", fontSize: "0.8rem" }}>
                Independent of any academy&apos;s own plan-level SMS allowance.
              </div>
            </td>
            <td style={{ padding: "0.5rem 0" }}>
              <StatusBadge on={settings.smsGloballyEnabled} />
            </td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem 0" }}>
              New academy registrations open
              <div style={{ color: "#777", fontSize: "0.8rem" }}>
                Whether the platform is currently accepting new academy sign-ups.
              </div>
            </td>
            <td style={{ padding: "0.5rem 0" }}>
              <StatusBadge on={settings.newAcademyRegistrationsOpen} />
            </td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem 0" }}>
              Maintenance mode
              <div style={{ color: "#777", fontSize: "0.8rem" }}>
                Platform-wide maintenance banner/lockout.
              </div>
            </td>
            <td style={{ padding: "0.5rem 0" }}>
              <StatusBadge on={settings.maintenanceMode} activeIsWarning />
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}

function StatusBadge({ on, activeIsWarning }: { on: boolean; activeIsWarning?: boolean }) {
  const warning = activeIsWarning && on;
  const color = warning ? "#b06a00" : on ? "#1a7f37" : "#666";
  const background = warning ? "#fff3d6" : on ? "#e6f6ea" : "#f0f0f0";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.6rem",
        borderRadius: 999,
        fontSize: "0.8rem",
        color,
        background,
      }}
    >
      {on ? "On" : "Off"}
    </span>
  );
}
