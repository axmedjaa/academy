/**
 * Shows where a verification code went without revealing the whole address:
 * the first two characters of the name (one if it is that short), then ***,
 * then the full domain. "adnan@gmail.com" -> "ad***@gmail.com".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}***@${domain}`;
}
