import { NotificationsInbox } from "./notifications-inbox";

/** Shared Notifications page (design S03) for consoles without their own
 * inbox route — the Platform console, and signed-in users with no academy. */
export default async function AccountNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <NotificationsInbox basePath="/account/notifications" params={await searchParams} />;
}
