import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { getPlatformSettings, PLATFORM_SETTINGS_CAPABILITY } from "@/lib/platform/settings";
import { Badge, PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { NoteBlock } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";

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

  const rows = [
    {
      label: "SMS sending",
      hint: "When off, no SMS is sent for any academy, whatever its plan allows.",
      on: settings.smsGloballyEnabled,
    },
    { label: "Registrations open", hint: "Allows new academy registrations.", on: settings.newAcademyRegistrationsOpen },
    {
      label: "Maintenance mode",
      hint: "Shows a maintenance notice and blocks sign-in.",
      on: settings.maintenanceMode,
      warnWhenOn: true,
    },
  ];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Settings" description="Platform-wide switches." />

      <div role="note" className="mb-4 flex items-start gap-3 rounded-card border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3.5 text-sm text-[#92400E]">
        <Icon name="warning" width={20} height={20} className="mt-px shrink-0" />
        <div>
          <p className="font-semibold">Read-only</p>
          <p>These values come from environment configuration. Changing them from this page is not available yet.</p>
        </div>
      </div>

      <section className="mb-4 rounded-card border border-border bg-surface px-5 shadow-card">
        <ul role="list">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-b-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{row.label}</p>
                <p className="text-[13px] text-[#374151]">{row.hint}</p>
              </div>
              <span className="shrink-0">
                <Badge label={row.on ? "On" : "Off"} tone={row.on ? (row.warnWhenOn ? "amber" : "green") : "gray"} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <NoteBlock>This page is visible to the Platform Owner only.</NoteBlock>
    </div>
  );
}
