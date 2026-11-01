import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getWebsiteSettings } from "@/lib/marketing/website-settings";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { WebsiteTabs } from "../website-tabs";
import { WebsiteSettingsForm } from "./website-settings-form";

/**
 * Platform -> Website settings -> Contact information. Platform owner only:
 * `getWebsiteSettings` checks `platform.website.manage` (ungrantable), and
 * the save action checks it again on the server.
 */
export default async function WebsiteContactSettingsPage() {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const result = await getWebsiteSettings(context);
  if (!result.ok) {
    return <PageMessage title="Access denied" message={result.error.message} />;
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Website settings"
        description="Contact details shown on the public website's Contact section and footer. Empty fields are hidden."
        actions={
          <Link
            href="/#contact"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app"
          >
            View website
            <span className="sr-only">(opens in a new tab)</span>
          </Link>
        }
      />
      <WebsiteTabs current="contact" />
      <WebsiteSettingsForm
        initial={result.settings.values}
        updatedAt={result.settings.updatedAt?.toISOString() ?? null}
        updatedByEmail={result.settings.updatedByEmail}
      />
    </div>
  );
}
