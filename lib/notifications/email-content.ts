import { notificationEmail, type EmailContent } from "@/lib/email/templates";
import type { NotificationTemplateId } from "@/lib/notifications/templates";

/**
 * Email wording for queued notifications (deployment readiness, Step 2).
 *
 * Deliberately generic: a subject, one sentence naming the academy, and a
 * link to sign in. No notification payload is ever placed in an email —
 * amounts, student names, marks and similar details stay inside the app,
 * behind sign-in and the usual permission checks. The academy name is the
 * only dynamic value, and it is HTML-escaped by `notificationEmail`.
 */
interface Wording {
  subject: string;
  heading: string;
  /** `{academy}` is replaced with the academy name, or "your academy". */
  message: string;
}

const WORDING: Record<NotificationTemplateId, Wording> = {
  "academy.onboarding": {
    subject: "Academy registered",
    heading: "Academy registered",
    message: "{academy} has been registered on Dardar School System.",
  },
  "academy.activation": {
    subject: "Academy activated",
    heading: "Academy activated",
    message: "{academy} is now active on Dardar School System.",
  },
  "academy.suspension": {
    subject: "Academy suspended",
    heading: "Academy suspended",
    message: "Access to {academy} has been suspended. Sign in for details.",
  },
  "subscription.expiry_reminder": {
    subject: "Subscription ending soon",
    heading: "Subscription ending soon",
    message: "The subscription for {academy} ends soon. Sign in to review it.",
  },
  "subscription.renewal": {
    subject: "Subscription renewed",
    heading: "Subscription renewed",
    message: "The subscription for {academy} has been renewed.",
  },
  "result.approval_requested": {
    subject: "Results waiting for review",
    heading: "Results waiting for review",
    message: "Results in {academy} are waiting for review.",
  },
  "result.approval_decided": {
    subject: "Results reviewed",
    heading: "Results reviewed",
    message: "Results you submitted in {academy} have been reviewed.",
  },
  "finance.approval_requested": {
    subject: "Finance item waiting for review",
    heading: "Finance item waiting for review",
    message: "A finance item in {academy} is waiting for review.",
  },
  "finance.approval_decided": {
    subject: "Finance item reviewed",
    heading: "Finance item reviewed",
    message: "A finance item you submitted in {academy} has been reviewed.",
  },
  "payment.receipt_issued": {
    subject: "Receipt issued",
    heading: "Receipt issued",
    message: "A payment receipt was issued in {academy}.",
  },
  "result.published": {
    subject: "Results published",
    heading: "Results published",
    message: "New results were published in {academy}.",
  },
  "certificate.issued": {
    subject: "Certificate issued",
    heading: "Certificate issued",
    message: "A certificate was issued in {academy}.",
  },
  "certificate.cancelled": {
    subject: "Certificate cancelled",
    heading: "Certificate cancelled",
    message: "A certificate was cancelled in {academy}.",
  },
  "security.new_device_signin": {
    subject: "New sign-in to your account",
    heading: "New sign-in to your account",
    message:
      "Your Dardar School System account was just signed in to from a new device or location. If this wasn't you, reset your password now.",
  },
};

export function notificationEmailContent(
  templateId: NotificationTemplateId,
  context: { academyName?: string | null; appUrl?: string | null },
): EmailContent {
  const wording = WORDING[templateId];
  const academy = context.academyName?.trim() || "your academy";
  const appUrl = context.appUrl?.replace(/\/$/, "");
  const isSecurity = templateId === "security.new_device_signin";
  const filled = wording.message.replace("{academy}", academy);
  return notificationEmail({
    subject: wording.subject,
    heading: wording.heading,
    message: filled.charAt(0).toUpperCase() + filled.slice(1),
    buttonLabel: isSecurity ? "Reset password" : "Sign in",
    buttonUrl: appUrl ? `${appUrl}${isSecurity ? "/forgot-password" : "/login"}` : undefined,
  });
}
