/**
 * PLAN.md Phase 5, Item 58a — "notification templates fixed/code-maintained,
 * no admin UI" (Decision #17: "Notification templates: fixed, code-defined
 * per event (no admin-editable template table)."). DESIGN.md §9.8 gives the
 * full event catalog: "academy onboarding, activation, suspension, expiry
 * reminder, renewal, result/finance approvals, receipts, results published,
 * certificates issued/cancelled, and security (new-device sign-in)."
 *
 * ---------------------------------------------------------------------
 * Scope boundary for this item (58a — infrastructure only)
 * ---------------------------------------------------------------------
 * This wave builds the notification *infrastructure* (schema, BullMQ,
 * `enqueueNotification`, the worker) — it does NOT wire `enqueueNotification`
 * into any Phase 0-4/Wave-1 trigger point (that's Item 58b) and does NOT
 * render real template content (subject lines, HTML/SMS bodies) since there
 * is no email/SMS provider integration yet either. What's needed *now* is a
 * fixed, typed registry of `template_id` values so `enqueueNotification`'s
 * `templateId` parameter is a closed, checked set rather than a free
 * string — actual copy/rendering is a later item's job once a real
 * email/SMS provider exists.
 *
 * One template id per catalog event. Naming: `<domain>.<event>`, mirroring
 * the `event_type` values already used elsewhere in this codebase for
 * audit-log `action` strings (e.g. "academy.approved" in lib/academies/approve.ts).
 */
export const NOTIFICATION_TEMPLATE_IDS = [
  // Academy onboarding / lifecycle
  "academy.onboarding",
  "academy.activation",
  "academy.suspension",
  // Subscription
  "subscription.expiry_reminder",
  "subscription.renewal",
  // Result / finance approvals
  "result.approval_requested",
  "result.approval_decided",
  "finance.approval_requested",
  "finance.approval_decided",
  // Receipts
  "payment.receipt_issued",
  // Results published
  "result.published",
  // Certificates
  "certificate.issued",
  "certificate.cancelled",
  // Security
  "security.new_device_signin",
] as const;

export type NotificationTemplateId = (typeof NOTIFICATION_TEMPLATE_IDS)[number];

export function isNotificationTemplateId(value: string): value is NotificationTemplateId {
  return (NOTIFICATION_TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * DESIGN.md §9.8: "Notification preference toggles live in
 * `/academy/settings`... optional event types get a normal toggle;
 * mandatory ones (e.g. suspension, security alerts) render as a disabled,
 * always-on toggle." That preference UI is Item 59 (a later wave), not
 * built here — but the mandatory/optional classification is intrinsic to
 * the event catalog, not the UI, so it's recorded here once so 58b/59 don't
 * have to re-derive it from prose. `enqueueNotification` itself does not
 * yet consult this (no preference storage exists until Item 59), so every
 * event is currently sent unconditionally regardless of this table.
 */
export const MANDATORY_NOTIFICATION_TEMPLATE_IDS: ReadonlySet<NotificationTemplateId> = new Set([
  "academy.suspension",
  "security.new_device_signin",
]);
