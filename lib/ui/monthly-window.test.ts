import { describe, expect, it } from "vitest";
import { buildMonthlyWindow } from "./monthly-window";

describe("buildMonthlyWindow", () => {
  const now = new Date(Date.UTC(2026, 9, 22));

  it("fills a fixed seven-month window ending this month, zero for missing months", () => {
    const points = buildMonthlyWindow([{ period: "2026-08", count: 3 }], { now });
    expect(points.map((p) => p.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
    expect(points.map((p) => p.value)).toEqual([0, 0, 0, 0, 3, 0, 0]);
    expect(points[6].fullLabel).toBe("October 2026");
  });

  it("cumulative mode carries everything before the window into the running total", () => {
    const points = buildMonthlyWindow(
      [
        { period: "2025-12", count: 4 },
        { period: "2026-05", count: 2 },
        { period: "2026-10", count: 1 },
      ],
      { now, cumulative: true },
    );
    expect(points.map((p) => p.value)).toEqual([4, 6, 6, 6, 6, 6, 7]);
  });

  it("crosses a year boundary correctly", () => {
    const points = buildMonthlyWindow([], { now: new Date(Date.UTC(2027, 1, 3)), months: 4 });
    expect(points.map((p) => p.fullLabel)).toEqual(["November 2026", "December 2026", "January 2027", "February 2027"]);
  });
});
