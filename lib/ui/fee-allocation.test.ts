import { describe, expect, it } from "vitest";
import { nextDuePeriod, outstandingCents, previewAllocation, previewInstallmentDates, previewScheduleChange } from "./fee-allocation";

const periods = [
  { id: "p3", periodStart: "2026-03-01", dueDate: "2026-03-01", remainingCents: 3_000 },
  { id: "p1", periodStart: "2026-01-01", dueDate: "2026-01-01", remainingCents: 0 },
  { id: "p2", periodStart: "2026-02-01", dueDate: "2026-02-01", remainingCents: 1_500 },
  { id: "p4", periodStart: "2026-04-01", dueDate: "2026-04-01", remainingCents: 3_000 },
];

describe("outstandingCents / nextDuePeriod", () => {
  it("sums what every period still owes, started or not", () => {
    expect(outstandingCents(periods)).toBe(7_500);
  });

  it("returns the earliest-due period that still owes something", () => {
    expect(nextDuePeriod(periods)?.id).toBe("p2");
    expect(nextDuePeriod(periods.map((p) => ({ ...p, remainingCents: 0 })))).toBeNull();
  });
});

describe("previewAllocation", () => {
  it("pays the whole outstanding balance oldest first, one allocation per period", () => {
    expect(previewAllocation(periods, 7_500)).toEqual({
      allocations: [
        { periodId: "p2", amountCents: 1_500 },
        { periodId: "p3", amountCents: 3_000 },
        { periodId: "p4", amountCents: 3_000 },
      ],
      excessCents: 0,
    });
  });

  it("covers part of a period when the amount runs out", () => {
    expect(previewAllocation(periods, 2_000).allocations).toEqual([
      { periodId: "p2", amountCents: 1_500 },
      { periodId: "p3", amountCents: 500 },
    ]);
  });

  it("reports an overpayment instead of applying it", () => {
    expect(previewAllocation(periods, 8_000).excessCents).toBe(500);
  });

  it("allocates nothing for a zero or negative amount", () => {
    expect(previewAllocation(periods, 0)).toEqual({ allocations: [], excessCents: 0 });
    expect(previewAllocation(periods, -5)).toEqual({ allocations: [], excessCents: 0 });
  });
});

describe("previewInstallmentDates", () => {
  it("steps one calendar month at a time from the start date", () => {
    expect(previewInstallmentDates("2026-10-29", 3)).toEqual(["2026-10-29", "2026-11-29", "2026-12-29"]);
  });

  it("clamps to short months and carries the clamped day forward, as the server does", () => {
    expect(previewInstallmentDates("2026-01-31", 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-28"]);
  });

  it("crosses the year boundary", () => {
    expect(previewInstallmentDates("2026-12-15", 2)).toEqual(["2026-12-15", "2027-01-15"]);
  });

  it("returns nothing for an invalid date or count", () => {
    expect(previewInstallmentDates("", 3)).toEqual([]);
    expect(previewInstallmentDates("2026-01-01", 0)).toEqual([]);
  });
});

describe("previewScheduleChange", () => {
  const today = "2026-03-15";
  const current = { amountCents: 9_000, anchorDate: "2026-02-01" };
  const schedulePeriods = [
    { periodStart: "2026-02-01", periodEnd: "2026-02-28", expectedAmountCents: 3_000, paidCents: 3_000 },
    { periodStart: "2026-03-01", periodEnd: "2026-03-31", expectedAmountCents: 3_000, paidCents: 1_000 },
    { periodStart: "2026-04-01", periodEnd: "2026-04-30", expectedAmountCents: 3_000, paidCents: 0 },
  ];

  it("uses the typed amount and date for a first schedule", () => {
    const preview = previewScheduleChange({ current: null, periods: [], today, amountCents: 10_000, anchorDate: "2026-04-01", count: 3 });
    expect(preview).toMatchObject({ keptCount: 0, amountCarried: false, dateMoved: false, nothingToReschedule: false, totalCents: 10_000 });
    expect(preview.installments).toEqual([
      { date: "2026-04-01", amountCents: 3_333 },
      { date: "2026-05-01", amountCents: 3_333 },
      { date: "2026-06-01", amountCents: 3_334 },
    ]);
  });

  it("subtracts the kept periods' EXPECTED amounts (not what was paid) and resumes after them", () => {
    const preview = previewScheduleChange({ current, periods: schedulePeriods, today, amountCents: 50_000, anchorDate: "2026-01-01", count: 2 });
    // 9,000 - (3,000 + 3,000): the partly paid March period keeps its own 2,000 balance.
    expect(preview).toMatchObject({ keptCount: 2, keptPaidCents: 4_000, keptOutstandingCents: 2_000, amountCarried: true, dateMoved: true, totalCents: 3_000 });
    expect(preview.installments).toEqual([
      { date: "2026-04-01", amountCents: 1_500 },
      { date: "2026-05-01", amountCents: 1_500 },
    ]);
  });

  it("keeps a not-started period that was paid in advance", () => {
    const paidAhead = schedulePeriods.map((p, i) => (i === 2 ? { ...p, paidCents: 500 } : p));
    const preview = previewScheduleChange({ current, periods: paidAhead, today, amountCents: 1, anchorDate: "2026-01-01", count: 1 });
    expect(preview).toMatchObject({ keptCount: 3, nothingToReschedule: true, totalCents: 0, installments: [] });
  });

  it("ignores periods kept from an earlier plan (they start before the saved plan's anchor)", () => {
    const later = { amountCents: 6_000, anchorDate: "2026-03-01" };
    const preview = previewScheduleChange({ current: later, periods: schedulePeriods, today, amountCents: 1, anchorDate: "2026-01-01", count: 2 });
    expect(preview.totalCents).toBe(3_000);
  });

  it("reports nothing to reschedule when every installment of the saved plan is kept", () => {
    const single = [{ periodStart: "2026-03-01", periodEnd: "2026-03-31", expectedAmountCents: 9_000, paidCents: 0 }];
    const preview = previewScheduleChange({ current: { amountCents: 9_000, anchorDate: "2026-03-01" }, periods: single, today, amountCents: 9_000, anchorDate: "2026-03-01", count: 3 });
    expect(preview).toMatchObject({ nothingToReschedule: true, installments: [] });
  });
});
