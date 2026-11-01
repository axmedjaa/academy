"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getClientIp } from "@/lib/http/client-ip";
import {
  updateWebsiteSettings,
  type WebsiteActionError,
  type WebsiteSettingsInput,
  type WebsiteSettingsRecord,
} from "@/lib/marketing/website-settings";
import {
  setContactSubmissionStatus,
  submitContactMessage,
  type ContactSubmissionStatus,
} from "@/lib/marketing/contact-submissions";

const UNAUTHENTICATED: WebsiteActionError = { code: "forbidden", message: "You must be signed in." };

/** Platform -> Website settings -> Contact information: Save. */
export async function saveWebsiteSettings(
  input: WebsiteSettingsInput,
): Promise<{ ok: true; settings: WebsiteSettingsRecord } | { ok: false; error: WebsiteActionError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await updateWebsiteSettings(context, input);
  if (result.ok) {
    revalidatePath("/");
    revalidatePath("/platform/website/contact");
  }
  return result;
}

export interface ContactFormState {
  ok: boolean;
  /** Bumped on every successful send so the form can reset itself. */
  sentAt?: number;
  error?: WebsiteActionError;
}

/** Public website contact form (no sign-in needed). */
export async function submitContactForm(_prev: ContactFormState, formData: FormData): Promise<ContactFormState> {
  const ip = getClientIp(await headers());
  const result = await submitContactMessage(
    {
      fullName: String(formData.get("fullName") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      message: String(formData.get("message") ?? ""),
      website: String(formData.get("website") ?? ""),
    },
    { ip },
  );
  return result.ok ? { ok: true, sentAt: Date.now() } : { ok: false, error: result.error };
}

/** Platform -> Website settings -> Contact messages: change a message's status. */
export async function updateContactMessageStatus(
  submissionId: string,
  status: ContactSubmissionStatus,
): Promise<{ ok: true } | { ok: false; error: WebsiteActionError }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await setContactSubmissionStatus(context, submissionId, status);
  if (result.ok) revalidatePath("/platform/website/messages");
  return result;
}
