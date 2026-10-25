/**
 * WhatsApp and Telegram chat links for a stored phone number.
 *
 * Both services address a person by their full international number, so a
 * link is only built when the number is written in international form
 * ("+252 63 400 0101" or "00252 63 400 0101"). A local number such as
 * "063 400 0101" has no country code, and guessing one would send the chat
 * to someone else — those get `reason: "not-international"` so the caller
 * can show a disabled control that says why. Nothing else about the person
 * goes into the URL (no prefilled message text).
 */

export type ChatLinks =
  | { ok: true; whatsapp: string; telegram: string }
  | { ok: false; reason: "missing" | "not-international" };

// E.164 allows at most 15 digits; anything under 8 is not a callable number.
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function chatLinks(phone: string | null | undefined): ChatLinks {
  const raw = (phone ?? "").trim();
  if (!raw) return { ok: false, reason: "missing" };

  const international = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.slice(2);

  if (!international || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS || digits.startsWith("0")) {
    return { ok: false, reason: "not-international" };
  }

  const encoded = encodeURIComponent(digits);
  return {
    ok: true,
    whatsapp: `https://wa.me/${encoded}`,
    telegram: `https://t.me/+${encoded}`,
  };
}

export const CHAT_UNAVAILABLE_HINT = "Add the country code (for example +252) to chat on WhatsApp or Telegram.";
