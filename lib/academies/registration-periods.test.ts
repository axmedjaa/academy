import { describe, expect, it } from "vitest";
import {
  formatDateRange,
  isIsoDate,
  presetRange,
  registrationPresetOptions,
  registrationToday,
  resolveRegistrationPeriod,
} from "./registration-periods";

const TODAY = "2026-11-24";

describe("registrationToday", () => {
  it("uses Mogadishu time (UTC+3)", () => {
    expect(registrationToday(new Date("2026-11-24T20:59:00Z"))).toBe("2026-11-24");
    expect(registrationToday(new Date("2026-11-24T21:00:00Z"))).toBe("2026-11-25");
  });
});

describe("presetRange", () => {
  it("resolves each preset to inclusive days ending today", () => {
    expect(presetRange("today", TODAY)).toEqual({ from: "2026-11-24", to: "2026-11-24" });
    expect(presetRange("yesterday", TODAY)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(presetRange("7d", TODAY)).toEqual({ from: "2026-11-18", to: "2026-11-24" });
    expect(presetRange("30d", TODAY)).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect(presetRange("month", TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-24" });
    expect(presetRange("last-month", TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("year", TODAY)).toEqual({ from: "2026-01-01", to: "2026-11-24" });
  });

  it("crosses month and year ends", () => {
    expect(presetRange("yesterday", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
    expect(presetRange("last-month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("last-month", "2028-03-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("formatDateRange", () => {
  it("is short within this year and adds the year otherwise", () => {
    expect(formatDateRange({ from: "2026-11-24", to: "2026-11-24" }, TODAY)).toBe("24 Nov");
    expect(formatDateRange({ from: "2026-11-18", to: "2026-11-24" }, TODAY)).toBe("18 – 24 Nov");
    expect(formatDateRange({ from: "2026-10-26", to: "2026-11-24" }, TODAY)).toBe("26 Oct – 24 Nov");
    expect(formatDateRange({ from: "2025-12-28", to: "2026-01-03" }, TODAY)).toBe("28 Dec 2025 – 3 Jan 2026");
    expect(formatDateRange({ from: "2025-03-01", to: "2025-03-31" }, TODAY)).toBe("1 – 31 Mar 2025");
  });
});

describe("resolveRegistrationPeriod", () => {
  it("reads a preset, a month and a custom range", () => {
    expect(resolveRegistrationPeriod({ reg: "7d" }, TODAY)).toMatchObject({ from: "2026-11-18", to: "2026-11-24", label: "Last 7 days", hint: "18 – 24 Nov" });
    expect(resolveRegistrationPeriod({ reg: "last-month" }, TODAY)).toMatchObject({ label: "Last month", hint: "October 2026" });
    expect(resolveRegistrationPeriod({ reg: "2026-02" }, TODAY)).toMatchObject({ from: "2026-02-01", to: "2026-02-28", label: "February 2026" });
    expect(resolveRegistrationPeriod({ reg: "custom", regFrom: "2026-11-01", regTo: "2026-11-10" }, TODAY)).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-10",
      hint: "1 – 10 Nov",
    });
  });

  it("swaps a backwards custom range and ignores anything invalid", () => {
    expect(resolveRegistrationPeriod({ reg: "custom", regFrom: "2026-11-10", regTo: "2026-11-01" }, TODAY)).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    expect(resolveRegistrationPeriod({ reg: "custom", regFrom: "2026-02-30", regTo: "2026-03-01" }, TODAY)).toBeNull();
    expect(resolveRegistrationPeriod({ reg: "custom" }, TODAY)).toBeNull();
    expect(resolveRegistrationPeriod({ reg: "2026-13" }, TODAY)).toBeNull();
    expect(resolveRegistrationPeriod({ reg: "" }, TODAY)).toBeNull();
    expect(resolveRegistrationPeriod({ reg: "anything" }, TODAY)).toBeNull();
  });

  it("checks real calendar days", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
  });

  it("lists the seven presets in order", () => {
    expect(registrationPresetOptions(TODAY).map((option) => option.label)).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last month",
      "This year",
    ]);
  });
});
