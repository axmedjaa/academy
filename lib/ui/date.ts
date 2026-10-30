/**
 * Display date format used across the Academy console ("Oct 16, 2026"),
 * matching the design. A date-only string ("2026-10-16", a Postgres `date`
 * column) is a calendar date, not an instant, so it is formatted in UTC and
 * never shifts a day in a timezone west of UTC. Timestamps (Date objects or
 * full ISO strings) are formatted in the runtime's local zone, as before.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(value: Date | string | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const dateOnly = typeof value === "string" && DATE_ONLY.test(value);
  const date = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : fallback;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  });
}

/**
 * A calendar date stored as a UTC-midnight timestamp (a form's date input
 * coerced with z.coerce.date, such as a payment's received date). Formatted
 * in UTC so it shows the day that was entered, in any timezone.
 */
export function formatCalendarDate(value: Date | string | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatDate(date.toISOString().slice(0, 10), fallback);
}
