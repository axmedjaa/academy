import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { getPlatformSettings, PLATFORM_SETTINGS_CAPABILITY } from "@/lib/platform/settings";
import { Badge, PAGE_WRAP, PageHeader, PageMessage, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";

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
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const settings = getPlatformSettings();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Platform settings"
        description="Global, platform-wide feature switches — separate from any single academy's own plan or settings."
      />

      <div role="status" className="mb-4 rounded-control border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
        These switches are currently <strong>read-only</strong>. Persisting a change requires a small schema
        addition that hasn&apos;t landed yet — the values below reflect this server&apos;s current environment
        configuration, not a database row that can be edited from here.
      </div>

      <Section>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Switch</th>
              <th className={th}>Current value</th>
            </tr>
          </thead>
          <tbody>
            <tr className={trHover}>
              <td className={td}>
                SMS enabled platform-wide
                <div className="mt-0.5 text-xs text-muted">
                  Independent of any academy&apos;s own plan-level SMS allowance.
                </div>
              </td>
              <td className={td}>
                <SwitchBadge on={settings.smsGloballyEnabled} />
              </td>
            </tr>
            <tr className={trHover}>
              <td className={td}>
                New academy registrations open
                <div className="mt-0.5 text-xs text-muted">
                  Whether the platform is currently accepting new academy sign-ups.
                </div>
              </td>
              <td className={td}>
                <SwitchBadge on={settings.newAcademyRegistrationsOpen} />
              </td>
            </tr>
            <tr className={trHover}>
              <td className={td}>
                Maintenance mode
                <div className="mt-0.5 text-xs text-muted">Platform-wide maintenance banner/lockout.</div>
              </td>
              <td className={td}>
                <SwitchBadge on={settings.maintenanceMode} activeIsWarning />
              </td>
            </tr>
          </tbody>
        </TableWrap>
      </Section>
    </div>
  );
}

function SwitchBadge({ on, activeIsWarning }: { on: boolean; activeIsWarning?: boolean }) {
  const warning = activeIsWarning && on;
  return <Badge label={on ? "On" : "Off"} tone={warning ? "amber" : on ? "green" : "gray"} />;
}
