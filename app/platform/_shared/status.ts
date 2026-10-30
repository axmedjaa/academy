import type { AcademySummary } from "@/lib/academies/approve";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";

/**
 * Badge wording and tones shared by the Platform pages (academies list and
 * detail, subscriptions). Two separate derived states, never merged:
 * approval (from approved_at/closed_at) and the subscription lifecycle
 * (academy_subscriptions.status), as DESIGN.md §11.1 describes.
 */
export type BadgeTone = "green" | "blue" | "gray" | "amber" | "red" | "slate";

export function approvalLabel(status: AcademySummary["status"]): string {
  if (status === "approved") return "Approved";
  if (status === "closed") return "Closed";
  return "Pending approval";
}

export function approvalTone(status: AcademySummary["status"]): BadgeTone {
  if (status === "approved") return "green";
  if (status === "closed") return "slate";
  return "amber";
}

const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  draft: "Draft",
  trial: "Trial",
  active: "Active",
  past_due: "Past due, grace period",
  suspended: "Suspended",
  expired: "Expired",
  cancelled: "Cancelled",
};

export function subscriptionLabel(status: SubscriptionStatus | null): string {
  return status === null ? "No subscription" : (SUBSCRIPTION_LABELS[status] ?? status);
}

export function subscriptionTone(status: SubscriptionStatus | null): BadgeTone {
  switch (status) {
    case "active":
      return "green";
    case "trial":
      return "blue";
    case "past_due":
      return "amber";
    case "suspended":
    case "expired":
    case "cancelled":
      return "red";
    default:
      return "gray";
  }
}

/** "Growth" -> "Growth plan"; a name that already says "plan" is kept. */
export function planLabel(name: string): string {
  return /\bplan\b/i.test(name) ? name : `${name} plan`;
}
