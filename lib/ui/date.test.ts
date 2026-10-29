import { describe, expect, it } from "vitest";
import { formatCalendarDate, formatDate } from "./date";

describe("formatDate", () => {
  it("formats a date-only string as a calendar date, independent of timezone", () => {
    expect(formatDate("2026-10-16")).toBe("Oct 16, 2026");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("formats Date objects and ISO timestamps", () => {
    expect(formatDate(new Date(2026, 6, 28, 12))).toBe("Jul 28, 2026");
  });

  it("returns the fallback for empty values and passes through unparseable strings", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined, "Not set")).toBe("Not set");
    expect(formatDate("")).toBe("—");
    expect(formatDate("soon")).toBe("soon");
  });
});

describe("formatCalendarDate", () => {
  it("shows the day a UTC-midnight timestamp was entered for, whatever the local timezone", () => {
    expect(formatCalendarDate(new Date("2026-10-20T00:00:00Z"))).toBe("Oct 20, 2026");
    expect(formatCalendarDate("2026-10-20T00:00:00.000Z")).toBe("Oct 20, 2026");
  });

  it("returns the fallback for empty or invalid values", () => {
    expect(formatCalendarDate(null)).toBe("—");
    expect(formatCalendarDate("not a date", "n/a")).toBe("n/a");
  });
});
