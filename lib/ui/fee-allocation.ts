/**
 * Display-side previews of the fee rules the server applies. They never
 * decide anything: the server recomputes and enforces the same rules when
 * a payment or schedule is saved. Each function mirrors one server rule:
 *
 * - `previewAllocation` — `recordEnrollmentPayment` (lib/academies/
 *   fee-periods.ts): outstanding periods oldest start first, each taking as
 *   much as it still owes, and any amount above the total outstanding is
 *   refused rather than partly applied.
 * - `previewInstallmentDates` — `generateFeePeriodsForEnrollment`: one
 *   period per calendar month from the start date, each step adding one
 *   month to the previous start with the day clamped to the month's length.
 */

export interface AllocatablePeriod {
  id: string;
  periodStart: string;
  dueDate: string;
  remainingCents: number;
}

/** Sum still owed across every period (started or not) — the course's outstanding balance. */
export function outstandingCents(periods: { remainingCents: number }[]): number {
  return periods.reduce((sum, period) => sum + Math.max(0, period.remainingCents), 0);
}

/** The earliest-due period that still owes something, or null when nothing is outstanding. */
export function nextDuePeriod<T extends AllocatablePeriod>(periods: T[]): T | null {
  return (
    [...periods]
      .filter((period) => period.remainingCents > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.periodStart.localeCompare(b.periodStart))[0] ?? null
  );
}

export interface AllocationPreview {
  allocations: { periodId: string; amountCents: number }[];
  /** Amount that would not fit — the server refuses the whole payment when this is above zero. */
  excessCents: number;
}

/** How `amountCents` would be applied: oldest period start first, no period over its remaining balance. */
export function previewAllocation(periods: AllocatablePeriod[], amountCents: number): AllocationPreview {
  const ordered = periods.filter((period) => period.remainingCents > 0).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  let left = Math.max(0, amountCents);
  const allocations: AllocationPreview["allocations"] = [];
  for (const period of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, period.remainingCents);
    allocations.push({ periodId: period.id, amountCents: take });
    left -= take;
  }
  return { allocations, excessCents: left };
}

function addMonthClamped(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = m; // (m - 1) + 1 month
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Start (and due) dates of `count` monthly installments from `startDate` ("YYYY-MM-DD"). */
export function previewInstallmentDates(startDate: string, count: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || count < 1) return [];
  const dates = [startDate];
  while (dates.length < count) dates.push(addMonthClamped(dates[dates.length - 1]));
  return dates;
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export interface SchedulePeriod {
  periodStart: string;
  periodEnd: string;
  expectedAmountCents: number;
  paidCents: number;
}

export interface ScheduleChangePreview {
  /** Periods the change leaves untouched: started, or already paid toward. */
  keptCount: number;
  /** Paid on the kept periods. */
  keptPaidCents: number;
  /** Still owed on the kept periods — they keep their own expected amounts. */
  keptOutstandingCents: number;
  /** True when the server will use the carried balance instead of the typed amount. */
  amountCarried: boolean;
  /** True when the server will start the new installments after the kept periods instead of on the typed date. */
  dateMoved: boolean;
  /** Every installment of the saved plan is kept: the server refuses the change. */
  nothingToReschedule: boolean;
  totalCents: number;
  installments: { date: string; amountCents: number }[];
}

/**
 * What `setEnrollmentFeeSchedule` will do with a proposed plan. Periods that
 * have started (start <= today) or have any payment are kept with their own
 * amounts. When any are kept, the new installments begin the day after the
 * last kept period ends, and the new total is the saved plan's total minus
 * the expected amounts of ITS kept periods (those starting on or after its
 * anchor date; periods kept from an earlier plan were already outside it).
 * Nothing left means the change is refused. Otherwise the typed amount and
 * date are used and the other not-started periods are replaced.
 */
export function previewScheduleChange(input: {
  current: { amountCents: number; anchorDate: string } | null;
  periods: SchedulePeriod[];
  today: string;
  amountCents: number;
  anchorDate: string;
  count: number;
}): ScheduleChangePreview {
  const kept = input.current ? input.periods.filter((p) => p.periodStart <= input.today || p.paidCents > 0) : [];
  const keptPaidCents = kept.reduce((sum, p) => sum + p.paidCents, 0);
  const keptOutstandingCents = kept.reduce((sum, p) => sum + Math.max(0, p.expectedAmountCents - p.paidCents), 0);
  let totalCents = input.amountCents;
  let anchor = input.anchorDate;
  let amountCarried = false;
  let dateMoved = false;
  let nothingToReschedule = false;
  if (kept.length > 0 && input.current) {
    const lastEnd = kept.reduce((latest, p) => (p.periodEnd > latest ? p.periodEnd : latest), kept[0].periodEnd);
    anchor = nextDay(lastEnd);
    dateMoved = true;
    amountCarried = true;
    const currentAnchor = input.current.anchorDate;
    const keptOfCurrent = kept.filter((p) => p.periodStart >= currentAnchor).reduce((sum, p) => sum + p.expectedAmountCents, 0);
    totalCents = Math.max(0, input.current.amountCents - keptOfCurrent);
    nothingToReschedule = totalCents === 0;
  }
  const dates = totalCents > 0 && input.count > 0 ? previewInstallmentDates(anchor, input.count) : [];
  const base = Math.floor(totalCents / Math.max(1, input.count));
  const installments = dates.map((date, index) => ({
    date,
    amountCents: index === dates.length - 1 ? totalCents - base * (dates.length - 1) : base,
  }));
  return { keptCount: kept.length, keptPaidCents, keptOutstandingCents, amountCarried, dateMoved, nothingToReschedule, totalCents, installments };
}
