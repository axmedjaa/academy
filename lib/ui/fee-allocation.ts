/**
 * Display-side previews of the fee rules the server applies. They never
 * decide anything: the server recomputes and enforces the same rules when
 * a payment is saved. Each function mirrors one server rule:
 *
 * - `previewAllocation` — `recordEnrollmentPayment` (lib/academies/
 *   fee-periods.ts): outstanding periods oldest start first, each taking as
 *   much as it still owes, and any amount above the total outstanding is
 *   refused rather than partly applied.
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
