import Link from "next/link";

type AccountTab = "settings" | "activity" | "notifications";

/** Narrow column the shared account pages use (design S01 to S03). */
export const ACCOUNT_WRAP = "mx-auto w-full max-w-[880px] px-4 py-8 sm:px-6";

/**
 * Account settings / Activity / Notifications tabs (design S01 to S03),
 * underlined, at the top of each shared account page. `notificationsHref`
 * is the console's own inbox route (see `notificationsHrefFor`).
 */
export function AccountTabs({ current, notificationsHref }: { current: AccountTab; notificationsHref: string }) {
  const tabs: { key: AccountTab; label: string; href: string }[] = [
    { key: "settings", label: "Account settings", href: "/account/security" },
    { key: "activity", label: "Activity", href: "/account/activity" },
    { key: "notifications", label: "Notifications", href: notificationsHref },
  ];
  return (
    <nav aria-label="Account" className="mb-7 flex overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-3 text-[14px] sm:px-4 sm:text-[15px] no-underline hover:no-underline ${
              on ? "font-semibold !text-brand shadow-[inset_0_-2px_0_var(--color-brand)]" : "font-medium !text-[#374151] hover:!text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Notifications link for the account tabs: the Academy inbox inside the
 * Academy shell, the shared account inbox for everyone else. */
export function notificationsHrefFor(console: "academy" | "platform" | null): string {
  return console === "academy" ? "/academy/notifications" : "/account/notifications";
}
