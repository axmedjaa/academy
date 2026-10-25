import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listNotificationsForUser } from "@/lib/notifications/list-notifications";
import { PageHeader } from "@/app/academy/_shell/ui";
import { ACCOUNT_WRAP, AccountTabs } from "@/app/account/account-tabs";
import { NotificationsList } from "./notifications-list";

/**
 * Notifications (design S03, one of the shared account pages, so it carries
 * the Account settings / Activity / Notifications tabs): the signed-in user's own inbox, filtered All
 * or Unread (`?filter=unread`), with mark-as-read for one, a selection or
 * everything unread. `listNotificationsForUser` only ever returns this
 * user's own notifications, so there is no role or academy branch here.
 */
export default async function AcademyNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const params = await searchParams;
  const filter = Array.isArray(params.filter) ? params.filter[0] : params.filter;
  const unreadOnly = filter === "unread";

  // One read: the unread count and the Unread view both come from it.
  const all = await listNotificationsForUser(context, {});
  const unreadCount = all.filter((n) => n.readAt === null).length;
  const shown = unreadOnly ? all.filter((n) => n.readAt === null) : all;

  return (
    <div className={ACCOUNT_WRAP}>
      <AccountTabs current="notifications" notificationsHref="/academy/notifications" />
      <PageHeader title="Notifications" description="Approvals, results, receipts, certificates, subscription and sign-in events for your account." />
      <NotificationsList notifications={shown} unreadOnly={unreadOnly} unreadCount={unreadCount} total={all.length} />
    </div>
  );
}
