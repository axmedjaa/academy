import { describe, expect, it } from "vitest";
import { nextDuePeriod, outstandingCents, previewAllocation } from "./fee-allocation";

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
