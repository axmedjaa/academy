import { NotificationsInbox } from "@/app/account/notifications/notifications-inbox";

/** Notifications (design S03) inside the Academy shell — see NotificationsInbox. */
export default async function AcademyNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <NotificationsInbox basePath="/academy/notifications" params={await searchParams} />;
}
