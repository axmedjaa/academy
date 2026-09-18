import type { NotificationTemplateId } from "@/lib/notifications/templates";

/**
 * PLAN.md Phase 5, Item 59 / DESIGN.md §9.8: "type icon per row
 * (success/error/warning/info/security)". Neither PLAN.md nor DESIGN.md
 * name an exact template-id -> icon-category mapping, so this is a
 * documented judgment call, derived from each template's own semantics in
 * the fixed catalog (lib/notifications/templates.ts):
 *
 * - "security": the one category DESIGN.md names explicitly by event
 *   (new-device sign-in) — reserved for `security.new_device_signin` only.
 * - "error": states that are unambiguously bad news for the recipient
 *   (an academy being suspended).
 * - "warning": states that need attention soon but aren't yet a failure
 *   (a subscription nearing expiry, a certificate being cancelled — the
 *   certificate itself isn't an error, but cancellation is an attention-
 *   worthy reversal of a prior "issued" state).
 * - "success": a positive/completed outcome (activation, renewal, a
 *   receipt being issued, results published, a certificate issued).
 * - "info": everything else — requests/notices that are neutral until a
 *   human decision resolves them (onboarding, approval *requested*,
 *   approval *decided* — decided could be an approval or a rejection, and
 *   the template id alone doesn't encode which, so it stays neutral rather
 *   than guessing).
 */
export type NotificationIconCategory = "success" | "error" | "warning" | "info" | "security";

const ICON_CATEGORY_BY_TEMPLATE: Record<NotificationTemplateId, NotificationIconCategory> = {
  "academy.onboarding": "info",
  "academy.activation": "success",
  "academy.suspension": "error",
  "subscription.expiry_reminder": "warning",
  "subscription.renewal": "success",
  "result.approval_requested": "info",
  "result.approval_decided": "info",
  "finance.approval_requested": "info",
  "finance.approval_decided": "info",
  "payment.receipt_issued": "success",
  "result.published": "success",
  "certificate.issued": "success",
  "certificate.cancelled": "warning",
  "security.new_device_signin": "security",
};

/** Falls back to "info" for any templateId not in the fixed catalog (should
 * be unreachable in practice — every row is written via `enqueueNotification`,
 * which validates `templateId` against `NOTIFICATION_TEMPLATE_IDS` — but a
 * plain `text` column has no DB-level guarantee, so this stays defensive
 * rather than throwing on an unrecognized value). */
export function getNotificationIconCategory(templateId: string): NotificationIconCategory {
  return ICON_CATEGORY_BY_TEMPLATE[templateId as NotificationTemplateId] ?? "info";
}
