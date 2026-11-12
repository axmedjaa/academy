import { Resend } from "resend";
import { logger } from "@/lib/logger";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * `permanent: true` means sending the same message again cannot succeed
 * (email not configured, or the provider rejected the request itself, e.g.
 * Resend's 403 "verify a domain" sandbox restriction). Callers that retry
 * (the notification worker) stop at once; temporary failures (network,
 * timeouts, 429, 5xx) leave it unset and stay retryable.
 */
export type SendEmailResult = { ok: true } | { ok: false; error: string; permanent?: boolean; statusCode?: number };

/** 4xx means the request itself was refused; 408/409/429 are worth retrying. */
const RETRYABLE_CLIENT_STATUS = new Set([408, 409, 429]);

export function isPermanentProviderStatus(statusCode: number | null | undefined): boolean {
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && !RETRYABLE_CLIENT_STATUS.has(statusCode);
}

/** Logs keep the domain only: enough to diagnose, without the person's address. */
export function maskRecipient(to: string): string {
  const at = to.lastIndexOf("@");
  return at === -1 ? "<redacted>" : `<redacted>${to.slice(at)}`;
}

export interface SendEmailOptions {
  /**
   * Sent as Resend's `Idempotency-Key`: a retried send with the same key is
   * not delivered twice. Used by the notification worker (one key per
   * notification row); the direct password-reset/invitation flows omit it.
   */
  idempotencyKey?: string;
}

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
 * link, which embeds the raw one-time token) or the full recipient address
 * — only the recipient's domain, the subject and, on failure, the
 * provider's own error message.
 */
export async function sendEmail(input: SendEmailInput, options: SendEmailOptions = {}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    logger.error("email not sent: email provider is not configured", {
      missingEnvVars: [!apiKey && "RESEND_API_KEY", !from && "EMAIL_FROM"].filter(Boolean),
    });
    return { ok: false, error: "Email delivery is not configured.", permanent: true };
  }

  try {
    const resend = new Resend(apiKey);
    const payload = {
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    };
    const { error } = options.idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey: options.idempotencyKey })
      : await resend.emails.send(payload);

    if (error) {
      // error.message/name/statusCode are Resend's own safe, non-secret
      // diagnostic fields (e.g. a 403 validation_error explaining a
      // sandbox sender/recipient restriction) — never the API key or the
      // email body (which may embed a one-time token/code).
      logger.error("email send failed", {
        to: maskRecipient(input.to),
        subject: input.subject,
        providerErrorName: error.name,
        providerErrorMessage: error.message,
        providerStatusCode: error.statusCode,
      });
      const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
      return {
        ok: false,
        error: "Failed to send email.",
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(isPermanentProviderStatus(statusCode) ? { permanent: true } : {}),
      };
    }

    logger.info("email sent", { to: maskRecipient(input.to), subject: input.subject });
    return { ok: true };
  } catch (err) {
    logger.error("email send threw", {
      to: maskRecipient(input.to),
      subject: input.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Failed to send email." };
  }
}
