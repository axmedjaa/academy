/**
 * The one centralized dollars<->cents boundary for every money INPUT in
 * this app. The database and every business-logic function (lib/academies/*,
 * lib/subscriptions/*) continue to store and validate `amountCents`/
 * `priceAmountCents` etc. as integer cents, exactly as before — nothing
 * about that changes. What changes is where the dollars->cents conversion
 * happens: at the UI/server-action boundary, using this file, instead of a
 * user being asked to type raw cents into a field labeled "(cents)" (the
 * bug this file fixes — e.g. typing `10` meaning "$10.00" was previously
 * recorded as 10 cents, i.e. $0.10).
 *
 * `dollarsToCents` deliberately never multiplies a parsed float by 100
 * (`Number(value) * 100` is not reliably exact for decimal input — e.g.
 * `5.55 * 100` is `554.9999999999999` in IEEE 754 double-precision
 * arithmetic before rounding masks it) — it instead splits the input into
 * its whole-dollar and cents digits as strings and combines them with
 * integer arithmetic only, which is exact for every value this function
 * accepts.
 */

/** Matches an unsigned amount with at most 2 decimal places: "10",
 * "10.5", "10.50", "0.99" — never a leading "+"/"-" sign (negative
 * amounts are rejected outright, matching this app's existing "amount
 * must be nonnegative/positive" schemas; a caller that legitimately needs
 * a negative value, e.g. a correction, should validate that separately). */
const DOLLAR_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses a user-entered dollar string into an integer number of cents.
 * Returns `null` — never `NaN`, never a silently-wrong number — for
 * anything that isn't a valid, non-negative monetary amount with at most
 * 2 decimal places: empty/whitespace-only input, non-numeric text, a
 * negative sign, more than 2 decimal places, or a value too large to
 * represent exactly as a JS integer.
 *
 * Examples: "1" -> 100, "2" -> 200, "10" -> 1000, "5.55" -> 555,
 * "0.50" -> 50, "0.01" -> 1, "10.01" -> 1001, "" -> null, "-5" -> null,
 * "5.555" -> null, "abc" -> null.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!DOLLAR_AMOUNT_PATTERN.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const cents = Number(wholePart) * 100 + Number(fractionPart.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * The inverse of `dollarsToCents`, for pre-filling an input's value from an
 * already-known cents amount (e.g. "default the amount field to the
 * period's remaining balance") — same integer-only arithmetic, no
 * float-division display artifacts. Always returns a plain, unsigned,
 * 2-decimal numeric string with no currency symbol or thousands
 * separators (e.g. "5.55", "10.00", "0.50") — a separate concern from
 * `formatMoney`'s "$10.00 USD"-style display formatting, which many
 * files already implement locally and correctly (this function does not
 * replace those).
 *
 * `cents` is expected to be a non-negative integer (this app's own
 * invariant for every stored amount); a negative or non-integer input is
 * still handled defensively (rounded, sign preserved) rather than
 * throwing, since this is a display-adjacent helper, not a validator.
 */
export function centsToDollars(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${whole}.${String(remainder).padStart(2, "0")}`;
}
