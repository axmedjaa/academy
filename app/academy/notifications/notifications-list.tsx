"use client";

import { useState, useTransition } from "react";
import {
  markNotificationReadAction,
  markNotificationsReadAction,
} from "@/lib/notifications/list-notifications-actions";
import { getNotificationIconCategory, type NotificationIconCategory } from "@/lib/notifications/notification-icon";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { NotificationListItem } from "@/lib/notifications/list-notifications";
import { Button, ErrorMessage, Section } from "@/app/academy/_shell/ui";

interface Props {
  notifications: NotificationListItem[];
}

// DESIGN.md §9.8: "type icon per row (success/error/warning/info/security)".
// Plain-text/emoji glyphs — this codebase has no icon library dependency
// anywhere else, so this stays consistent with every other page's
// system-ui-and-inline-styles-only convention rather than introducing one.
const ICON_BY_CATEGORY: Record<NotificationIconCategory, string> = {
  success: "✅", // check mark
  error: "⛔", // no entry
  warning: "⚠️", // warning sign
  info: "ℹ️", // information
  security: "🔒", // lock
};

/**
 * PLAN.md Phase 5, Item 59 — `/academy/notifications`'s list UI (DESIGN.md
 * §9.8's list pattern A: read/unread filter [handled by the server-rendered
 * page via a GET query param, same convention as app/academy/audit-logs],
 * mark-as-read single/bulk, a type icon per row).
 */
export function NotificationsList({ notifications }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function markOne(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await markNotificationReadAction(id);
      if (!result.ok) {
        setError(result.error.message);
      }
    });
  }

  function markSelected() {
    if (selected.size === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await markNotificationsReadAction([...selected]);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSelected(new Set());
    });
  }

  const unreadIds = notifications.filter((n) => n.readAt === null).map((n) => n.id);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorMessage message={error} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={isPending || selected.size === 0} onClick={markSelected}>
          Mark selected as read ({selected.size})
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={isPending || unreadIds.length === 0}
          onClick={() => setSelected(new Set(unreadIds))}
        >
          Select all unread
        </Button>
      </div>

      {notifications.length === 0 ? (
        <Section>
          <p className="text-sm text-muted">No notifications match this filter.</p>
        </Section>
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((notification) => {
            const category = getNotificationIconCategory(notification.templateId);
            const isUnread = notification.readAt === null;
            return (
              <li
                key={notification.id}
                className={`flex items-center gap-3 rounded-card border border-border px-3 py-3 shadow-card ${
                  isUnread ? "bg-info-bg/40" : "bg-surface"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(notification.id)}
                  onChange={() => toggleSelected(notification.id)}
                  aria-label={`Select notification ${notification.eventType}`}
                  className="h-4 w-4 accent-brand"
                />
                <span aria-hidden="true" title={category} className="text-lg leading-none">
                  {ICON_BY_CATEGORY[category]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={isUnread ? "font-semibold text-ink" : "text-ink"}>
                    {humanizeNotificationLabel(notification.eventType)}
                  </div>
                  <div className="text-xs text-muted">
                    {notification.createdAt.toLocaleString()}
                    {" — "}
                    {notification.status}
                  </div>
                </div>
                {isUnread && (
                  <Button type="button" variant="secondary" className="shrink-0 px-2.5 py-1 text-xs" disabled={isPending} onClick={() => markOne(notification.id)}>
                    Mark as read
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
