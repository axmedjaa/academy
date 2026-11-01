import { z } from "zod";

/**
 * Pure (database-free) half of the website contact settings: the Zod schema
 * and the public projection. Shared by the server module
 * (lib/marketing/website-settings.ts, which re-validates every save), the
 * settings form (same rules in the browser) and the public page/preview.
 */

export const SOCIAL_NETWORKS = [
  { key: "facebookUrl", label: "Facebook", hosts: ["facebook.com", "fb.com", "fb.me"] },
  { key: "linkedinUrl", label: "LinkedIn", hosts: ["linkedin.com"] },
  { key: "instagramUrl", label: "Instagram", hosts: ["instagram.com"] },
  { key: "xUrl", label: "X", hosts: ["x.com", "twitter.com"] },
  { key: "youtubeUrl", label: "YouTube", hosts: ["youtube.com", "youtu.be"] },
  { key: "tiktokUrl", label: "TikTok", hosts: ["tiktok.com"] },
] as const;

export type SocialKey = (typeof SOCIAL_NETWORKS)[number]["key"];

/** Removes control characters (keeping line breaks and tabs) and trims. */
export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

/** "" / whitespace -> null, so an empty field means "not shown". */
const optional = (inner: z.ZodType<string, string>) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.union([z.literal(""), inner]))
    .transform((value): string | null => (value === "" ? null : value));

const phoneNumber = (label: string) =>
  z
    .string()
    .max(30, `${label} is too long.`)
    .regex(/^\+?[0-9 ()\-.]+$/, `Enter a valid ${label.toLowerCase()} (digits, spaces, + ( ) - only).`)
    .refine((value) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15;
    }, `Enter a valid ${label.toLowerCase()} with 7 to 15 digits.`);

function socialUrl(label: string, hosts: readonly string[]) {
  return z
    .string()
    .max(500, `${label} link is too long.`)
    .refine((value) => {
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === "https:" && hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
      } catch {
        return false;
      }
    }, `Enter a ${label} link starting with https:// (${hosts[0]}).`);
}

export const websiteSettingsSchema = z.object({
  supportEmail: optional(z.string().max(254).email("Enter a valid support email address.")),
  phone: optional(phoneNumber("Phone number")),
  whatsappNumber: optional(phoneNumber("WhatsApp number")),
  officeAddress: optional(z.string().max(300, "The office address is too long (300 characters at most).")),
  businessHours: optional(z.string().max(500, "Business hours are too long (500 characters at most).")),
  facebookUrl: optional(socialUrl("Facebook", SOCIAL_NETWORKS[0].hosts)),
  linkedinUrl: optional(socialUrl("LinkedIn", SOCIAL_NETWORKS[1].hosts)),
  instagramUrl: optional(socialUrl("Instagram", SOCIAL_NETWORKS[2].hosts)),
  xUrl: optional(socialUrl("X", SOCIAL_NETWORKS[3].hosts)),
  youtubeUrl: optional(socialUrl("YouTube", SOCIAL_NETWORKS[4].hosts)),
  tiktokUrl: optional(socialUrl("TikTok", SOCIAL_NETWORKS[5].hosts)),
  contactFormEnabled: z.boolean(),
});

export type WebsiteSettingsInput = z.input<typeof websiteSettingsSchema>;
export type WebsiteSettingsValues = z.output<typeof websiteSettingsSchema>;

export interface PublicContactSettings {
  supportEmail: string | null;
  phone: string | null;
  /** Digits-only number for display next to the WhatsApp link. */
  whatsappNumber: string | null;
  /** https://wa.me/<digits>, built from the number. */
  whatsappUrl: string | null;
  officeAddress: string | null;
  businessHours: string | null;
  socials: { key: SocialKey; label: string; url: string }[];
  contactFormEnabled: boolean;
}

export const EMPTY_WEBSITE_SETTINGS: WebsiteSettingsValues = {
  supportEmail: null,
  phone: null,
  whatsappNumber: null,
  officeAddress: null,
  businessHours: null,
  facebookUrl: null,
  linkedinUrl: null,
  instagramUrl: null,
  xUrl: null,
  youtubeUrl: null,
  tiktokUrl: null,
  contactFormEnabled: false,
};

/** The public projection of saved (or draft, for the preview) values:
 * empty fields stay null and are simply not shown. */
export function toPublicContact(values: WebsiteSettingsValues): PublicContactSettings {
  const whatsappDigits = values.whatsappNumber?.replace(/\D/g, "") || null;
  return {
    supportEmail: values.supportEmail,
    phone: values.phone,
    whatsappNumber: values.whatsappNumber,
    whatsappUrl: whatsappDigits ? `https://wa.me/${whatsappDigits}` : null,
    officeAddress: values.officeAddress,
    businessHours: values.businessHours,
    socials: SOCIAL_NETWORKS.flatMap((network) => {
      const url = values[network.key];
      return url ? [{ key: network.key, label: network.label, url }] : [];
    }),
    contactFormEnabled: values.contactFormEnabled,
  };
}

/** True when the public site has anything to show in a Contact section. */
export function hasPublicContact(contact: PublicContactSettings): boolean {
  return Boolean(
    contact.supportEmail ||
      contact.phone ||
      contact.whatsappUrl ||
      contact.officeAddress ||
      contact.businessHours ||
      contact.socials.length > 0 ||
      contact.contactFormEnabled,
  );
}
