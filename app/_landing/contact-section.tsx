"use client";

import { startTransition, useActionState, useEffect, useState, type ReactNode } from "react";
import type { PublicContactSettings, SocialKey } from "@/lib/marketing/website-settings-schema";
import { submitContactForm, type ContactFormState } from "@/lib/marketing/website-actions";
import { guardAction } from "@/lib/ui/guard-action";
import {
  DField,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

/**
 * The public website's Contact section, its contact form, and the footer's
 * contact block — shared by the landing page and the platform owner's
 * settings preview (app/platform/website/contact), so the preview is the
 * real component, not a copy. Only configured fields render.
 */

const BODY = "text-[#374151]";

const ICONS: Record<string, string> = {
  mail: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
  phone:
    "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
  whatsapp:
    "M3 21l1.65-3.8A9 9 0 1 1 7.9 20.3L3 21M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1",
  pin: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
};

const SOCIAL_ICONS: Record<SocialKey, string> = {
  facebookUrl: "M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z",
  linkedinUrl: "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4",
  instagramUrl:
    "M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zM16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37zM17.5 6.5h.01",
  xUrl: "M4 4l6.5 8.6L4 20h2l5.4-6.1L16 20h4l-6.8-9.1L19 4h-2l-4.8 5.4L8 4z",
  youtubeUrl:
    "M2.5 17a24 24 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49 49 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24 24 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49 49 0 0 1-16.2 0A2 2 0 0 1 2.5 17M10 15l5-3-5-3z",
  tiktokUrl: "M9 12a4 4 0 1 0 4 4V2a5 5 0 0 0 5 5",
};

export function ContactIcon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function ContactItem({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 bg-white px-5 py-5">
      <div className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] bg-brand-tint text-brand">
        <ContactIcon path={ICONS[icon]} />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">{label}</div>
        <div className="mt-1 text-[15px] leading-[1.55] [overflow-wrap:anywhere] text-ink">{children}</div>
      </div>
    </div>
  );
}

const LINK = "font-semibold !text-brand no-underline hover:!text-brand-hover hover:!underline";

export function SocialLinks({ contact, tone = "light" }: { contact: PublicContactSettings; tone?: "light" | "dark" }) {
  if (contact.socials.length === 0) return null;
  const style =
    tone === "dark"
      ? "border-[#374151] !text-[#E5E7EB] hover:border-accent-gold hover:!text-white"
      : "border-border bg-white !text-brand hover:border-brand hover:bg-brand-tint";
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {contact.socials.map((social) => (
        <li key={social.key}>
          <a
            href={social.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Dardar on ${social.label} (opens in a new tab)`}
            title={social.label}
            className={`flex h-11 w-11 items-center justify-center rounded-full border no-underline transition-colors duration-200 ${style}`}
          >
            <ContactIcon path={SOCIAL_ICONS[social.key]} size={18} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Contact details list: only the fields that are configured. */
export function ContactDetails({ contact }: { contact: PublicContactSettings }) {
  const items: ReactNode[] = [];
  if (contact.supportEmail) {
    items.push(
      <ContactItem key="email" icon="mail" label="Email">
        <a href={`mailto:${contact.supportEmail}`} className={LINK}>
          {contact.supportEmail}
        </a>
      </ContactItem>,
    );
  }
  if (contact.phone) {
    items.push(
      <ContactItem key="phone" icon="phone" label="Phone">
        <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`} className={LINK}>
          {contact.phone}
        </a>
      </ContactItem>,
    );
  }
  if (contact.whatsappUrl && contact.whatsappNumber) {
    items.push(
      <ContactItem key="whatsapp" icon="whatsapp" label="WhatsApp">
        <a href={contact.whatsappUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
          {contact.whatsappNumber}
        </a>
      </ContactItem>,
    );
  }
  if (contact.officeAddress) {
    items.push(
      <ContactItem key="address" icon="pin" label="Office">
        <address className="whitespace-pre-line not-italic">{contact.officeAddress}</address>
      </ContactItem>,
    );
  }
  if (contact.businessHours) {
    items.push(
      <ContactItem key="hours" icon="clock" label="Business hours">
        <span className="whitespace-pre-line">{contact.businessHours}</span>
      </ContactItem>,
    );
  }
  if (items.length === 0 && contact.socials.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      {items.length > 0 && <div className="grid gap-px bg-border">{items}</div>}
      {contact.socials.length > 0 && (
        <div className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${items.length > 0 ? "border-t border-border" : ""}`}>
          <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">Follow us</span>
          <SocialLinks contact={contact} />
        </div>
      )}
    </div>
  );
}

const CONTACT_RULES: DesignFormRule[] = [
  { name: "fullName", label: "Full name", required: true },
  {
    name: "email",
    label: "Email address",
    required: true,
    check: (value) => (/^\S+@\S+\.\S+$/.test(value.trim()) ? null : "Enter a valid email address."),
  },
  {
    name: "phone",
    label: "Phone number",
    required: true,
    check: (value) => {
      const digits = value.replace(/\D/g, "").length;
      return /^\+?[0-9 ()\-.]+$/.test(value.trim()) && digits >= 7 && digits <= 15
        ? null
        : "Enter a valid phone number with 7 to 15 digits.";
    },
  },
  { name: "subject", label: "Subject", required: true },
  {
    name: "message",
    label: "Message",
    required: true,
    check: (value) => (value.trim().length >= 10 ? null : "Message must be at least 10 characters."),
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/full name/i, "fullName"],
  [/email/i, "email"],
  [/phone/i, "phone"],
  [/subject/i, "subject"],
  [/message must|message is/i, "message"],
];

const guardedSubmit = guardAction(submitContactForm);
const initialState: ContactFormState = { ok: false };

/**
 * The website contact form. Messages are stored for the platform owner
 * (lib/marketing/contact-submissions.ts); the success message only says the
 * message was received, never that an email was delivered. `preview` shows
 * the form disabled, for the settings page.
 */
export function ContactForm({
  defaultSubject = "",
  idPrefix = "contact",
  preview = false,
}: {
  defaultSubject?: string;
  idPrefix?: string;
  preview?: boolean;
}) {
  const [state, formAction, pending] = useActionState(guardedSubmit, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(CONTACT_RULES);
  // The success panel shows for the latest successful send until the
  // visitor chooses to write another (which remounts an empty form).
  const [dismissedSentAt, setDismissedSentAt] = useState<number | null>(null);
  const sent = Boolean(state.ok && state.sentAt && state.sentAt !== dismissedSentAt);

  useEffect(() => {
    if (!state.ok && state.error) showServerError(state.error.message, SERVER_FIELD_PATTERNS);
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (sent) {
    return (
      <div role="status" className="flex flex-col items-start gap-3 rounded-lg bg-brand-tint p-5">
        <div className="text-lg font-semibold text-brand">Thank you, your message has been received.</div>
        <p className={`text-[15px] ${BODY}`}>The Dardar team reviews every message and will contact you by phone or email.</p>
        <button
          type="button"
          onClick={() => setDismissedSentAt(state.sentAt ?? null)}
          className="h-10 cursor-pointer rounded-lg border border-brand bg-white px-4 text-sm font-semibold text-brand hover:bg-white/70"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Contact form"
      onSubmit={onDesignSubmit(validate, (data) => {
        if (preview) return;
        startTransition(() => formAction(data));
      })}
      className="grid gap-4"
    >
      <fieldset disabled={preview || pending} className="m-0 grid min-w-0 gap-4 border-0 p-0">
        <FieldGrid>
          <DField label="Full name" name={`${idPrefix}-fullName`} required error={errors.fullName}>
            <input
              name="fullName"
              autoComplete="name"
              maxLength={120}
              onBlur={blur("fullName")}
              className={controlClass(Boolean(errors.fullName))}
              {...invalidProps(`${idPrefix}-fullName`, errors.fullName)}
            />
          </DField>
          <DField label="Email address" name={`${idPrefix}-email`} required error={errors.email}>
            <input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps(`${idPrefix}-email`, errors.email)}
            />
          </DField>
          <DField label="Phone number" name={`${idPrefix}-phone`} required error={errors.phone}>
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={30}
              placeholder="+252 …"
              onBlur={blur("phone")}
              className={controlClass(Boolean(errors.phone))}
              {...invalidProps(`${idPrefix}-phone`, errors.phone)}
            />
          </DField>
          <DField label="Subject" name={`${idPrefix}-subject`} required error={errors.subject}>
            <input
              name="subject"
              maxLength={150}
              defaultValue={defaultSubject}
              onBlur={blur("subject")}
              className={controlClass(Boolean(errors.subject))}
              {...invalidProps(`${idPrefix}-subject`, errors.subject)}
            />
          </DField>
          <DField label="Message" name={`${idPrefix}-message`} required error={errors.message} full>
            <textarea
              name="message"
              rows={5}
              maxLength={5000}
              onBlur={blur("message")}
              className={`${controlClass(Boolean(errors.message), true)} resize-y`}
              {...invalidProps(`${idPrefix}-message`, errors.message)}
            />
          </DField>
        </FieldGrid>
        {/* Honeypot: hidden from people and assistive technology. */}
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            Leave this field empty
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <FormErrorBanner message={banner} />
        <button
          type="submit"
          className="min-h-12 cursor-pointer rounded-lg bg-brand px-6 text-base font-semibold text-white transition-colors duration-200 hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send message"}
        </button>
        {preview && <p className="text-[13px] text-muted">Preview only. Messages can&apos;t be sent from here.</p>}
      </fieldset>
    </form>
  );
}

/** The landing page's Contact section (id="contact"). */
export function ContactSection({ contact, preview = false }: { contact: PublicContactSettings; preview?: boolean }) {
  const hasDetails =
    Boolean(contact.supportEmail || contact.phone || contact.whatsappUrl || contact.officeAddress || contact.businessHours) ||
    contact.socials.length > 0;
  return (
    <section id="contact" className="scroll-mt-20 px-6 py-[72px]">
      <div className="mx-auto max-w-[1160px]">
        <div data-rv className="mb-2 text-[13px] font-semibold tracking-[0.06em] text-brand uppercase">
          Contact
        </div>
        <h2 data-rv className="mb-3 text-[clamp(26px,3.4vw,36px)] leading-[1.2] font-normal text-balance">
          Contact the Dardar team
        </h2>
        <p data-rv className={`mb-9 max-w-[640px] text-[17px] ${BODY}`}>
          Questions about Dardar or bringing your academy on board? Reach us using the details below
          {contact.contactFormEnabled ? " or send us a message." : "."}
        </p>
        <div
          className={`grid items-start gap-6 ${
            hasDetails && contact.contactFormEnabled ? "grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))]" : ""
          }`}
        >
          {hasDetails && (
            <div data-rv>
              <ContactDetails contact={contact} />
            </div>
          )}
          {contact.contactFormEnabled && (
            <div data-rv style={{ transitionDelay: "90ms" }} className="rounded-xl border border-border bg-white p-6">
              <h3 className="mb-1 text-xl font-normal">Send us a message</h3>
              <p className="mb-5 text-sm text-muted">All fields are required.</p>
              <ContactForm idPrefix="contact-section" preview={preview} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The footer's contact column: configured details and social links. */
export function FooterContact({ contact }: { contact: PublicContactSettings }) {
  const lines: ReactNode[] = [];
  const footLink = "!text-[#E5E7EB] no-underline hover:!text-white hover:!underline [overflow-wrap:anywhere]";
  if (contact.supportEmail)
    lines.push(
      <a key="email" href={`mailto:${contact.supportEmail}`} className={footLink}>
        {contact.supportEmail}
      </a>,
    );
  if (contact.phone)
    lines.push(
      <a key="phone" href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`} className={footLink}>
        {contact.phone}
      </a>,
    );
  if (contact.whatsappUrl && contact.whatsappNumber)
    lines.push(
      <a key="whatsapp" href={contact.whatsappUrl} target="_blank" rel="noopener noreferrer" className={footLink}>
        WhatsApp {contact.whatsappNumber}
      </a>,
    );
  if (contact.officeAddress)
    lines.push(
      <address key="address" className="whitespace-pre-line text-[#9CA3AF] not-italic">
        {contact.officeAddress}
      </address>,
    );
  if (lines.length === 0 && contact.socials.length === 0) return null;
  return (
    <div>
      <div className="mb-4 text-xs font-semibold tracking-[0.1em] text-accent-gold uppercase">Contact</div>
      <div className="grid gap-3 text-[15px]">{lines}</div>
      {contact.socials.length > 0 && (
        <div className={lines.length > 0 ? "mt-4" : ""}>
          <SocialLinks contact={contact} tone="dark" />
        </div>
      )}
    </div>
  );
}
