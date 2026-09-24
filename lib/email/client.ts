import { Resend } from "resend";
import { logger } from "@/lib/logger";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmailResult = { ok: true } | { ok: false; error: string };

/**
 * Isolates the Resend SDK behind one function — nothing outside lib/email
 * ever imports `Resend` or touches `RESEND_API_KEY` directly, so the
 * provider can change without touching lib/auth/*.
 *
 * RESEND_API_KEY/EMAIL_FROM are deliberately NOT in lib/env.ts's required
 * schema (see .env.example) — the app must still boot and serve every
 * unrelated feature when email isn't configured yet. Presence is checked
 * here, at call time, so an email-dependent flow fails safely (a returned
 * error) instead of the whole app crashing at startup.
 *
 * Never logs `html`/`text` (they carry the caller's reset/verification
 * link, which embeds the raw one-time token) — only recipient/subject and,
 * on failure, the provider's own error message.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    logger.error("email not sent: email provider is not configured", {
      missingEnvVars: [!apiKey && "RESEND_API_KEY", !from && "EMAIL_FROM"].filter(Boolean),
    });
    return { ok: false, error: "Email delivery is not configured." };
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (error) {
      // error.message/name/statusCode are Resend's own safe, non-secret
      // diagnostic fields (e.g. a 403 validation_error explaining a
      // sandbox sender/recipient restriction) — never the API key or the
      // email body (which may embed a one-time token/code).
      logger.error("email send failed", {
        to: input.to,
        subject: input.subject,
        providerErrorName: error.name,
        providerErrorMessage: error.message,
        providerStatusCode: error.statusCode,
      });
      return { ok: false, error: "Failed to send email." };
    }

    logger.info("email sent", { to: input.to, subject: input.subject });
    return { ok: true };
  } catch (err) {
    logger.error("email send threw", {
      to: input.to,
      subject: input.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Failed to send email." };
  }
}
