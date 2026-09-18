import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listNotificationsForUser } from "@/lib/notifications/list-notifications";
import { NotificationsList } from "./notifications-list";

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

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Notifications</h1>

      <nav style={{ marginBottom: "1.5rem", display: "flex", gap: "1rem" }}>
        <a href="/academy/notifications" style={{ fontWeight: unreadOnly ? 400 : 700 }}>
          All
        </a>
        <a href="/academy/notifications?filter=unread" style={{ fontWeight: unreadOnly ? 700 : 400 }}>
          Unread
        </a>
      </nav>

      <NotificationsList notifications={notifications} />
    </main>
  );
}
