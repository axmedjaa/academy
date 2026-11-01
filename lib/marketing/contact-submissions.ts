import { createHash } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { contactSubmissions, contactSubmissionStatusEnum } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email/client";
import { logger } from "@/lib/logger";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  WEBSITE_SETTINGS_CAPABILITY,
  cleanText,
  getPublicContactSettings,
  type WebsiteActionError,
} from "@/lib/marketing/website-settings";

/**
 * Messages sent through the public website contact form.
 *
 * Submissions are always stored (`contact_submissions`) for the platform
 * owner to review under Platform -> Website settings -> Contact messages.
 * When an email provider (RESEND_API_KEY / EMAIL_FROM) and a support email
 * are configured, a notification is also sent; `notified_at` is set only
 * when the provider confirmed it, and the visitor is never told their
 * message was emailed — only that it was received.
 *
 * Abuse controls: the form must be enabled in website settings; per-IP and
 * per-email rate limits (lib/rate-limit.ts, the same Redis limiter as
 * sign-in); a hidden honeypot field; length limits; control characters
 * stripped; and a dedupe key so an accidental double submit stores one row.
 * Only `platform_owner` can read or change submissions.
 */

export type ContactSubmissionStatus = (typeof contactSubmissionStatusEnum.enumValues)[number];

const IP_LIMIT = { maxAttempts: 5, windowSeconds: 60 * 60 };
const EMAIL_LIMIT = { maxAttempts: 3, windowSeconds: 60 * 60 };

const text = (label: string, min: number, max: number) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(min, min <= 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
        .max(max, `${label} must be ${max} characters or fewer.`),
    );

export const contactMessageSchema = z.object({
  fullName: text("Full name", 1, 120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "Email address is too long.")
    .email("Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .min(1, "Phone number is required.")
    .max(30, "Phone number is too long.")
    .regex(/^\+?[0-9 ()\-.]+$/, "Enter a valid phone number (digits, spaces, + ( ) - only).")
    .refine((value) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15;
    }, "Enter a valid phone number with 7 to 15 digits."),
  subject: text("Subject", 1, 150),
  message: text("Message", 10, 5000),
  /** Honeypot: hidden from people, filled in by naive bots. */
  website: z.string().max(500).optional(),
});

export type ContactMessageInput = z.input<typeof contactMessageSchema>;

export type SubmitContactResult = { ok: true } | { ok: false; error: WebsiteActionError };

function dedupeKey(email: string, subject: string, message: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return createHash("sha256").update([email, subject.toLowerCase(), message, day].join("\u0000")).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/**
 * Public submit. `ip` comes from the request (lib/http/client-ip.ts) and is
 * used only as a rate-limit key; it is not stored.
 */
export async function submitContactMessage(
  input: ContactMessageInput,
  { ip, now = new Date() }: { ip: string; now?: Date },
): Promise<SubmitContactResult> {
  const settings = await getPublicContactSettings();
  if (!settings.contactFormEnabled) {
    return { ok: false, error: { code: "unavailable", message: "The contact form is not available right now." } };
  }

  const ipLimit = await checkRateLimit(`contact-form:ip:${ip}`, IP_LIMIT);
  if (!ipLimit.allowed) {
    return {
      ok: false,
      error: { code: "rate_limited", message: "Too many messages from your connection. Please try again later." },
    };
  }

  const parsed = contactMessageSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: { code: "validation", message: issue?.message ?? "Check the form and try again.", field: String(issue?.path[0] ?? "") },
    };
  }
  const { fullName, email, phone, subject, message, website } = parsed.data;

  // A filled honeypot is a bot: answer like a success, store nothing.
  if (website && website.trim() !== "") {
    return { ok: true };
  }

  const emailLimit = await checkRateLimit(`contact-form:email:${email}`, EMAIL_LIMIT);
  if (!emailLimit.allowed) {
    return {
      ok: false,
      error: { code: "rate_limited", message: "You have sent several messages recently. Please try again later." },
    };
  }

  const [stored] = await db
    .insert(contactSubmissions)
    .values({ fullName, email, phone, subject, message, dedupeKey: dedupeKey(email, subject, message, now), createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: contactSubmissions.dedupeKey })
    .returning({ id: contactSubmissions.id });

  // Same message already received today: nothing new to store or notify.
  if (!stored) return { ok: true };

  if (settings.supportEmail) {
    const sent = await sendEmail({
      to: settings.supportEmail,
      subject: `Website message: ${subject}`,
      text: `${fullName} <${email}>, phone ${phone}, wrote through the Dardar website:\n\n${message}`,
      html: `<p><strong>${escapeHtml(fullName)}</strong> &lt;${escapeHtml(email)}&gt;, phone ${escapeHtml(phone)}, wrote through the Dardar website:</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
    });
    if (sent.ok) {
      await db.update(contactSubmissions).set({ notifiedAt: new Date() }).where(eq(contactSubmissions.id, stored.id));
    } else {
      logger.info("contact_form.notification_not_sent", { submissionId: stored.id });
    }
  }

  return { ok: true };
}

export interface ContactSubmissionRow {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  subject: string;
  message: string;
  status: ContactSubmissionStatus;
  notifiedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

const PAGE_SIZE = 20;

/** Platform owner only: newest first, optionally one status. */
export async function listContactSubmissions(
  context: AuthContext,
  { status, page = 1 }: { status?: ContactSubmissionStatus; page?: number } = {},
): Promise<
  | { ok: true; rows: ContactSubmissionRow[]; totalCount: number; page: number; pageSize: number; newCount: number }
  | { ok: false; error: WebsiteActionError }
> {
  if (!(await hasPermission(context, WEBSITE_SETTINGS_CAPABILITY))) {
    return { ok: false, error: { code: "forbidden", message: "Only the platform owner can read website messages." } };
  }
  const where = status ? eq(contactSubmissions.status, status) : undefined;
  const safePage = Math.max(1, Math.floor(page) || 1);
  const [rows, [total], [fresh]] = await Promise.all([
    db
      .select({
        id: contactSubmissions.id,
        fullName: contactSubmissions.fullName,
        email: contactSubmissions.email,
        phone: contactSubmissions.phone,
        subject: contactSubmissions.subject,
        message: contactSubmissions.message,
        status: contactSubmissions.status,
        notifiedAt: contactSubmissions.notifiedAt,
        reviewedAt: contactSubmissions.reviewedAt,
        createdAt: contactSubmissions.createdAt,
      })
      .from(contactSubmissions)
      .where(where)
      .orderBy(desc(contactSubmissions.createdAt))
      .limit(PAGE_SIZE)
      .offset((safePage - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(contactSubmissions).where(where),
    db.select({ n: count() }).from(contactSubmissions).where(eq(contactSubmissions.status, "new")),
  ]);
  return { ok: true, rows, totalCount: total?.n ?? 0, page: safePage, pageSize: PAGE_SIZE, newCount: fresh?.n ?? 0 };
}

/** Platform owner only: mark a message read, archived, or new again. */
export async function setContactSubmissionStatus(
  context: AuthContext,
  submissionId: string,
  status: ContactSubmissionStatus,
): Promise<{ ok: true } | { ok: false; error: WebsiteActionError }> {
  if (!(await hasPermission(context, WEBSITE_SETTINGS_CAPABILITY))) {
    return { ok: false, error: { code: "forbidden", message: "Only the platform owner can manage website messages." } };
  }
  if (!z.string().uuid().safeParse(submissionId).success || !contactSubmissionStatusEnum.enumValues.includes(status)) {
    return { ok: false, error: { code: "not_found", message: "Message not found." } };
  }
  const outcome = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: contactSubmissions.status })
      .from(contactSubmissions)
      .where(eq(contactSubmissions.id, submissionId))
      .for("update")
      .limit(1);
    if (!before) return false;
    if (before.status === status) return true;
    const now = new Date();
    await tx
      .update(contactSubmissions)
      .set({ status, updatedAt: now, reviewedAt: now, reviewedBy: context.userId })
      .where(and(eq(contactSubmissions.id, submissionId)));
    await recordAudit(
      {
        actorUserId: context.userId,
        actorRole: context.platformRole,
        action: "updateContactSubmissionStatus",
        entityType: "contact_submission",
        entityId: submissionId,
        before: { status: before.status },
        after: { status },
      },
      tx,
    );
    return true;
  });
  return outcome ? { ok: true } : { ok: false, error: { code: "not_found", message: "Message not found." } };
}
