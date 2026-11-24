/**
 * The Students page's "Registration date" filter: the presets professional
 * tools share (Today, Yesterday, Last 7 / 30 days, This month, Last month,
 * This year), a month, or a custom range, each resolved to an inclusive
 * date range in Mogadishu time. Pure: `today` is passed in, so the page,
 * the counts and the tests all agree on the same dates.
 *
 * URL: `reg` = a preset key, a month ("2026-11"), or "custom" with
 * `regFrom` / `regTo` ("YYYY-MM-DD").
 */

export const REGISTRATION_TIME_ZONE = "Africa/Mogadishu";

export const REGISTRATION_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "year", label: "This year" },
] as const;

export type RegistrationPresetKey = (typeof REGISTRATION_PRESETS)[number]["key"];

/** An inclusive range of calendar days, "YYYY-MM-DD". */
export interface DateRange {
  from: string;
  to: string;
}

export interface RegistrationPeriod extends DateRange {
  /** "Last 7 days", "November 2026", "Custom range". */
  label: string;
  /** The dates it covers: "18 – 24 Nov", "October 2026". */
  hint: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Today's date in Mogadishu, "YYYY-MM-DD". */
export function registrationToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REGISTRATION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function iso(y: number, m: number, d: number): string {
  // Normalises overflow (day 0 = last day of the previous month).
  const value = new Date(Date.UTC(y, m - 1, d));
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return iso(y, m, d + days);
}

/** A real calendar day ("2026-02-30" is not). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = parts(value);
  return iso(y, m, d) === value;
}

export function isIsoMonth(value: string): boolean {
  return ISO_MONTH.test(value);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

/** "24 Nov", "18 – 24 Nov", "26 Oct – 24 Nov", "28 Dec 2025 – 3 Jan 2026";
 * the year is added when the range is not in `today`'s year. */
export function formatDateRange(range: DateRange, today: string): string {
  const [fy, fm, fd] = parts(range.from);
  const [ty, tm, td] = parts(range.to);
  const thisYear = parts(today)[0];
  const showYear = fy !== ty || ty !== thisYear;
  const end = `${td} ${MONTHS[tm - 1]}${showYear ? ` ${ty}` : ""}`;
  if (range.from === range.to) return end;
  if (fy === ty && fm === tm) return `${fd} – ${end}`;
  return `${fd} ${MONTHS[fm - 1]}${fy !== ty ? ` ${fy}` : ""} – ${end}`;
}

/** A preset's dates relative to `today` (inclusive, ending today). */
export function presetRange(key: RegistrationPresetKey, today: string): DateRange {
  const [y, m] = parts(today);
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: iso(y, m, 1), to: today };
    case "last-month":
      return { from: iso(y, m - 1, 1), to: iso(y, m, 0) };
    case "year":
      return { from: iso(y, 1, 1), to: today };
  }
}

function presetHint(key: RegistrationPresetKey, range: DateRange, today: string): string {
  if (key === "last-month") return monthLabel(range.from.slice(0, 7));
  if (key === "year") return String(parts(today)[0]);
  return formatDateRange(range, today);
}

/** What the URL asks for, or null for "All time" (or anything invalid). */
export function resolveRegistrationPeriod(
  params: { reg?: string; regFrom?: string; regTo?: string },
  today: string,
): RegistrationPeriod | null {
  const reg = params.reg ?? "";
  const preset = REGISTRATION_PRESETS.find((item) => item.key === reg);
  if (preset) {
    const range = presetRange(preset.key, today);
    return { ...range, label: preset.label, hint: presetHint(preset.key, range, today) };
  }
  if (isIsoMonth(reg)) {
    const [y, m] = reg.split("-").map(Number);
    return { from: iso(y, m, 1), to: iso(y, m + 1, 0), label: monthLabel(reg), hint: "Whole month" };
  }
  if (reg === "custom") {
    const from = params.regFrom ?? "";
    const to = params.regTo ?? "";
    if (!isIsoDate(from) || !isIsoDate(to)) return null;
    const range = from <= to ? { from, to } : { from: to, to: from };
    return { ...range, label: "Custom range", hint: formatDateRange(range, today) };
  }
  return null;
}

/** Every preset with its dates, for the filter's list. */
export function registrationPresetOptions(today: string): { key: RegistrationPresetKey; label: string; hint: string; range: DateRange }[] {
  return REGISTRATION_PRESETS.map((preset) => {
    const range = presetRange(preset.key, today);
    return { key: preset.key, label: preset.label, hint: presetHint(preset.key, range, today), range };
  });
}
