/**
 * Neither PLAN.md nor DESIGN.md define human-readable copy for the fixed
 * notification catalog yet (lib/notifications/templates.ts's own comment:
 * "does NOT render real template content... actual copy/rendering is a
 * later item's job"). This is a small, dependency-free stand-in used only
 * by this item's own UI (the notifications list's event label and the
 * settings preference-toggle list) so those screens show something more
 * readable than the raw `"academy.suspension"`-style id, without inventing
 * the real subject-line/body copy that belongs to a later item.
 */
export function humanizeNotificationLabel(id: string): string {
  return id
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
