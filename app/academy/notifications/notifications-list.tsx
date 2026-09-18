"use client";

import { useState, useTransition } from "react";
import {
  markNotificationReadAction,
  markNotificationsReadAction,
} from "@/lib/notifications/list-notifications-actions";
import { getNotificationIconCategory, type NotificationIconCategory } from "@/lib/notifications/notification-icon";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { NotificationListItem } from "@/lib/notifications/list-notifications";

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
    <div>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", alignItems: "center" }}>
        <button type="button" disabled={isPending || selected.size === 0} onClick={markSelected}>
          Mark selected as read ({selected.size})
        </button>
        <button
          type="button"
          disabled={isPending || unreadIds.length === 0}
          onClick={() => setSelected(new Set(unreadIds))}
        >
          Select all unread
        </button>
      </div>

      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {notifications.map((notification) => {
          const category = getNotificationIconCategory(notification.templateId);
          const isUnread = notification.readAt === null;
          return (
            <li
              key={notification.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.6rem 0.75rem",
                border: "1px solid #ddd",
                borderRadius: 4,
                background: isUnread ? "#f2f8ff" : "white",
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(notification.id)}
                onChange={() => toggleSelected(notification.id)}
                aria-label={`Select notification ${notification.eventType}`}
              />
              <span aria-hidden="true" title={category}>
                {ICON_BY_CATEGORY[category]}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: isUnread ? 700 : 400 }}>
                  {humanizeNotificationLabel(notification.eventType)}
                </div>
                <div style={{ fontSize: "0.8rem", color: "#666" }}>
                  {notification.createdAt.toLocaleString()}
                  {" — "}
                  {notification.status}
                </div>
              </div>
              {isUnread && (
                <button type="button" disabled={isPending} onClick={() => markOne(notification.id)}>
                  Mark as read
                </button>
              )}
            </li>
          );
        })}
        {notifications.length === 0 && <li>No notifications match this filter.</li>}
      </ul>
    </div>
  );
}
