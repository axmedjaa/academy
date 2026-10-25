"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markNotificationReadAction, markNotificationsReadAction } from "@/lib/notifications/list-notifications-actions";
import { getNotificationIconCategory, type NotificationIconCategory } from "@/lib/notifications/notification-icon";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { NotificationListItem } from "@/lib/notifications/list-notifications";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast } from "@/lib/ui/toast";
import { Button, EmptyState } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";

const CATEGORY: Record<NotificationIconCategory, { icon: string; tile: string; kind: string }> = {
  success: { icon: "check_circle", tile: "bg-[#F0FDF4] text-[#166534]", kind: "Update" },
  error: { icon: "cancel", tile: "bg-[#FEF2F2] text-[#B91C1C]", kind: "Problem" },
  warning: { icon: "warning", tile: "bg-[rgba(245,182,56,0.22)] text-ink", kind: "Attention" },
  info: { icon: "info", tile: "bg-brand-tint text-brand", kind: "Info" },
  security: { icon: "lock", tile: "bg-[#EEF2F6] text-[#374151]", kind: "Security" },
};

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Notifications list (design S03): All / Unread filter, a row per
 * notification with its type tile, label and time, an unread dot, and
 * mark-as-read for one row, the selection, or everything unread — the
 * existing actions, which only ever touch the caller's own notifications.
 */
export function NotificationsList({
  notifications,
  unreadOnly,
  unreadCount,
  total,
}: {
  notifications: NotificationListItem[];
  unreadOnly: boolean;
  unreadCount: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const unreadIds = notifications.filter((n) => n.readAt === null).map((n) => n.id);

  function mark(ids: string[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      try {
        const result = ids.length === 1 ? await markNotificationReadAction(ids[0]) : await markNotificationsReadAction(ids);
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        setSelected(new Set());
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const segment = (on: boolean) =>
    `inline-flex min-h-10 items-center gap-1.5 px-3.5 text-[13px] font-semibold no-underline hover:no-underline ${
      on ? "bg-brand !text-white" : "bg-surface !text-ink hover:bg-app"
    }`;

  return (
    <>
      <section className="mb-3 overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-[#FAFBFC] px-4 py-3">
          <nav aria-label="Filter notifications" className="flex overflow-hidden rounded-lg border border-border-strong bg-surface">
            <Link href="/academy/notifications" aria-current={!unreadOnly ? "page" : undefined} className={segment(!unreadOnly)}>
              All
            </Link>
            <Link
              href="/academy/notifications?filter=unread"
              aria-current={unreadOnly ? "page" : undefined}
              className={`${segment(unreadOnly)} border-l border-border-strong`}
            >
              Unread
              <span className={`rounded-full px-1.5 text-xs tabular-nums ${unreadOnly ? "bg-white !text-brand" : "bg-brand !text-white"}`}>{unreadCount}</span>
            </Link>
          </nav>
          <div className="flex-1" />
          {selected.size > 0 && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => mark([...selected])}>
              Mark {selected.size} as read
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={pending || unreadIds.length === 0} onClick={() => mark(unreadIds)}>
            Mark all as read
          </Button>
        </div>

        {notifications.length === 0 ? (
          <div className="p-6">
            <EmptyState
              message={unreadOnly ? "You're all caught up. No unread notifications." : "No notifications yet."}
              icon={<Icon name="notifications" />}
            />
          </div>
        ) : (
          <ul role="list">
            {notifications.map((notification) => {
              const unread = notification.readAt === null;
              const category = CATEGORY[getNotificationIconCategory(notification.templateId)];
              const title = humanizeNotificationLabel(notification.eventType);
              return (
                <li
                  key={notification.id}
                  className={`flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 ${unread ? "bg-[#FBF5F6]" : ""}`}
                >
                  <label className="flex h-11 w-8 shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selected.has(notification.id)}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(notification.id)) next.delete(notification.id);
                          else next.add(notification.id);
                          return next;
                        })
                      }
                      aria-label={`Select: ${title}`}
                      className="h-[18px] w-[18px] accent-brand"
                    />
                  </label>
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${category.tile}`} aria-hidden="true">
                    <Icon name={category.icon} width={20} height={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={unread ? "font-semibold text-ink" : "text-ink"}>{title}</span>
                      <span className="rounded-md border border-border bg-app px-1.5 text-[11px] font-semibold leading-[18px] text-[#374151]">
                        {category.kind}
                      </span>
                    </span>
                    {notification.status === "failed" && <span className="block text-xs text-[#B91C1C]">Delivery failed.</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                      {unread && <span aria-label="Unread" className="h-2 w-2 rounded-full bg-brand" />}
                      {WHEN.format(notification.createdAt)}
                    </span>
                    {unread && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => mark([notification.id])}
                        className="min-h-8 text-xs font-semibold text-brand hover:underline disabled:opacity-50"
                      >
                        Mark as read
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-[13px] text-muted">
        Showing {notifications.length} of {total}.
      </p>
    </>
  );
}
