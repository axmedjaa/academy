const APP_NAME = "Academy Management SaaS";

const BRAND_BLUE = "#2F5FE0";
const TEXT_COLOR = "#111827";
const MUTED_COLOR = "#6B7280";
const BORDER_COLOR = "#E2E5EA";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function layout(opts: { heading: string; bodyHtml: string; buttonLabel: string; buttonUrl: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#F7F8FA;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <p style="margin:0 0 24px;font-size:14px;font-weight:700;color:${TEXT_COLOR};">${APP_NAME}</p>
      <div style="background-color:#FFFFFF;border:1px solid ${BORDER_COLOR};border-radius:8px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:18px;color:${TEXT_COLOR};">${opts.heading}</h1>
        ${opts.bodyHtml}
        <a href="${opts.buttonUrl}" style="display:inline-block;margin-top:24px;background-color:${BRAND_BLUE};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:6px;">${opts.buttonLabel}</a>
        <p style="margin:24px 0 0;font-size:12px;color:${MUTED_COLOR};word-break:break-all;">Or paste this link into your browser:<br />${opts.buttonUrl}</p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * DESIGN.md §7/§11.8 forgot-password flow — sent only after a token has
 * already been minted (lib/auth/password-reset.ts); this function only
 * builds the message, it never decides whether to send one.
 */
export function passwordResetEmail(params: { resetUrl: string; expiresInMinutes: number }): EmailContent {
  const { resetUrl, expiresInMinutes } = params;
  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">
      We received a request to reset the password for your ${APP_NAME} account.
    </p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">
      This link expires in ${expiresInMinutes} minutes. If you didn't request a password reset, you can safely ignore this email — your password will not be changed.
    </p>`;

  return {
    subject: "Reset your password",
    html: layout({ heading: "Reset your password", bodyHtml, buttonLabel: "Reset password", buttonUrl: resetUrl }),
    text: `Reset your ${APP_NAME} password: ${resetUrl}\n\nThis link expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email.`,
  };
}

function codeLayout(opts: { heading: string; introHtml: string; code: string; footerHtml: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#F7F8FA;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <p style="margin:0 0 24px;font-size:14px;font-weight:700;color:${TEXT_COLOR};">${APP_NAME}</p>
      <div style="background-color:#FFFFFF;border:1px solid ${BORDER_COLOR};border-radius:8px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:18px;color:${TEXT_COLOR};">${opts.heading}</h1>
        ${opts.introHtml}
        <p style="margin:24px 0;padding:16px;text-align:center;font-size:28px;font-weight:700;letter-spacing:0.3em;color:${TEXT_COLOR};background-color:#F7F8FA;border-radius:6px;">${opts.code}</p>
        ${opts.footerHtml}
      </div>
    </div>
  </body>
</html>`;
}

/**
 * MFA login-time email OTP — an ADDITIONAL verification method alongside
 * the existing authenticator-app TOTP (lib/auth/mfa.ts), never a
 * replacement or an enrollment path: lib/auth/mfa-email-otp.ts only ever
 * sends/accepts this for an account that already has a verified TOTP
 * credential. Sent to the account's own email, never anyone else's.
 */
export function mfaEmailOtpEmail(params: { code: string; expiresInMinutes: number }): EmailContent {
  const { code, expiresInMinutes } = params;
  const introHtml = `<p style="margin:0;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">Use this code to finish signing in to your ${APP_NAME} account.</p>`;
  const footerHtml = `<p style="margin:0;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">This code expires in ${expiresInMinutes} minutes. If you didn't try to sign in, you can safely ignore this email — no one can get in without this code.</p>`;

  return {
    subject: "Your sign-in verification code",
    html: codeLayout({ heading: "Your verification code", introHtml, code, footerHtml }),
    text: `Your ${APP_NAME} sign-in verification code is: ${code}\n\nThis code expires in ${expiresInMinutes} minutes. If you didn't try to sign in, you can safely ignore this email — no one can get in without this code.`,
  };
}

/**
 * Sent only to the NEW email address during a change-email request
 * (lib/auth/email-change.ts) — the current email is never touched until
 * this link is clicked, so this is the only notice the new address gets.
 */
export function verifyEmailChangeEmail(params: { verifyUrl: string; expiresInMinutes: number }): EmailContent {
  const { verifyUrl, expiresInMinutes } = params;
  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">
      Someone requested to use this address as the sign-in email for an ${APP_NAME} account. Confirm this address to complete the change.
    </p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:${TEXT_COLOR};">
      This link expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email — no change will be made.
    </p>`;

  return {
    subject: "Verify your new email address",
    html: layout({ heading: "Verify your new email address", bodyHtml, buttonLabel: "Verify email address", buttonUrl: verifyUrl }),
    text: `Verify your new email address for ${APP_NAME}: ${verifyUrl}\n\nThis link expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email.`,
  };
}
