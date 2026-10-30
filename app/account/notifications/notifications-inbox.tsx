import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listNotificationsForUser, MAX_BULK_MARK_READ_IDS } from "@/lib/notifications/list-notifications";
import { LIST_PAGE_SIZE_MAX, parsePageParam } from "@/lib/ui/pagination";
import { PaginationNav } from "@/components/pagination-nav";
import { PageHeader } from "@/app/academy/_shell/ui";
import { ACCOUNT_WRAP, AccountTabs } from "../account-tabs";
import { NotificationsList } from "./notifications-list";

const NOTIFICATIONS_DESCRIPTION =
  "Approvals, results, receipts, certificates, subscription and sign-in events for your account.";

/**
 * Notifications (design S03, one of the shared account pages, so it carries
 * the Account settings / Activity / Notifications tabs): the signed-in
 * user's own inbox, filtered All or Unread (`?filter=unread`), 10 per page,
 * with mark-as-read for one, a selection or everything unread.
 * `listNotificationsForUser` only ever returns this user's own
 * notifications, so there is no role or academy branch here. Rendered by
 * `/academy/notifications` (inside the Academy shell) and
 * `/account/notifications` (Platform staff, or anyone without an academy).
 */
export async function NotificationsInbox({
  basePath,
  params,
}: {
  basePath: string;
  params: Record<string, string | string[] | undefined>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const filter = Array.isArray(params.filter) ? params.filter[0] : params.filter;
  const unreadOnly = filter === "unread";

  // One read: the unread count, the Unread view and "Mark all as read" all come from it.
  const all = await listNotificationsForUser(context, {});
  const unread = all.filter((n) => n.readAt === null);
  const matching = unreadOnly ? unread : all;
  const lastPage = Math.max(1, Math.ceil(matching.length / LIST_PAGE_SIZE_MAX));
  const page = Math.min(parsePageParam(params), lastPage);
  const shown = matching.slice((page - 1) * LIST_PAGE_SIZE_MAX, page * LIST_PAGE_SIZE_MAX);

  return (
    <div className={ACCOUNT_WRAP}>
      <AccountTabs current="notifications" notificationsHref={basePath} />
      <PageHeader title="Notifications" description={NOTIFICATIONS_DESCRIPTION} />
      <NotificationsList
        basePath={basePath}
        notifications={shown}
        unreadOnly={unreadOnly}
        unreadCount={unread.length}
        allUnreadIds={unread.slice(0, MAX_BULK_MARK_READ_IDS).map((n) => n.id)}
        firstIndex={(page - 1) * LIST_PAGE_SIZE_MAX}
        total={matching.length}
      />
      <PaginationNav page={page} pageSize={LIST_PAGE_SIZE_MAX} totalCount={matching.length} searchParams={params} />
    </div>
  );
}
