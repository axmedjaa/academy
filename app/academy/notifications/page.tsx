import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listNotificationsForUser } from "@/lib/notifications/list-notifications";
import { NotificationsList } from "./notifications-list";
import { PAGE_WRAP, PageHeader } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Phase 5, Item 59 — `/academy/notifications`. DESIGN.md §9.8: "list
 * pattern (A) with read/unread filter, mark-as-read (single/bulk), a type
 * icon per row." Follows app/academy/audit-logs/page.tsx's own convention
 * for a simple `/academy/*` page: `app/academy/layout.tsx` already gates the
 * whole subtree for base subscription access, so this page's own job is
 * only to redirect on a missing session (defensive) and render whatever the
 * read returns.
 *
 * Unlike audit-logs (an academy-scoped read gated by role), this page's
 * data is the signed-in user's own inbox — `listNotificationsForUser` never
 * fails/branches on academy access (see that function's own module comment)
 * — so there is no "blocked"/"forbidden" branch to render here.
 *
 * The read/unread filter is a plain GET query param (`?filter=unread`),
 * same server-rendered re-navigate convention as audit-logs's filter form,
 * rather than client-side state — keeps the filter shareable/bookmarkable
 * and avoids fetching the full unfiltered list just to filter it in the
 * browser.
 */
export default async function AcademyNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const rawFilter = params.filter;
  const filter = Array.isArray(rawFilter) ? rawFilter[0] : rawFilter;
  const unreadOnly = filter === "unread";

  const notifications = await listNotificationsForUser(context, { unreadOnly });

  const tabBase = "rounded-control px-3 py-1.5 text-sm font-medium transition-colors";

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Notifications" />

      <div className="mb-5 inline-flex gap-1 rounded-control border border-border bg-surface p-1">
        <a
          href="/academy/notifications"
          className={`${tabBase} ${!unreadOnly ? "bg-brand text-white" : "text-muted hover:bg-app"}`}
        >
          All
        </a>
        <a
          href="/academy/notifications?filter=unread"
          className={`${tabBase} ${unreadOnly ? "bg-brand text-white" : "text-muted hover:bg-app"}`}
        >
          Unread
        </a>
      </div>

      <NotificationsList notifications={notifications} />
    </div>
  );
}
