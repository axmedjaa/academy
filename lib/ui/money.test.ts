import { describe, expect, it } from "vitest";
import { centsToDollars, dollarsToCents } from "./money";

describe("dollarsToCents", () => {
  it.each([
    ["1", 100],
    ["2", 200],
    ["10", 1000],
    ["100", 10000],
    ["5.55", 555],
    ["0.50", 50],
    ["0.5", 50],
    ["0.01", 1],
    ["0.99", 99],
    ["10.01", 1001],
    ["10.5", 1050],
    ["10.50", 1050],
    ["0", 0],
    ["0.00", 0],
  ] as const)("%s -> %i cents", (input, expected) => {
    expect(dollarsToCents(input)).toBe(expected);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(dollarsToCents("  10  ")).toBe(1000);
  });

  it.each([
    [""],
    ["   "],
    ["abc"],
    ["-5"],
    ["-0.01"],
    ["5.555"],
    ["5.5.5"],
    ["1e10"],
    ["Infinity"],
    ["NaN"],
    ["$5.55"],
    ["5,55"],
  ])("rejects invalid input %s as null", (input) => {
    expect(dollarsToCents(input)).toBeNull();
  });

  it("never loses precision the way a naive `Number(value) * 100` would", () => {
    // 5.55 * 100 === 554.9999999999999 in plain JS float arithmetic —
    // dollarsToCents must not reproduce that error.
    expect(dollarsToCents("5.55")).toBe(555);
    expect(dollarsToCents("19.9")).toBe(1990);
    expect(dollarsToCents("29.99")).toBe(2999);
  });

  it("rejects an amount too large to represent as a safe integer number of cents", () => {
    expect(dollarsToCents("999999999999999")).toBeNull();
  });
});

describe("centsToDollars", () => {
  it.each([
    [100, "1.00"],
    [200, "2.00"],
    [1000, "10.00"],
    [555, "5.55"],
    [50, "0.50"],
    [1, "0.01"],
    [99, "0.99"],
    [1001, "10.01"],
    [0, "0.00"],
    [10000, "100.00"],
  ] as const)("%i cents -> %s", (cents, expected) => {
    expect(centsToDollars(cents)).toBe(expected);
  });

  it("round-trips through dollarsToCents for every case above", () => {
    for (const cents of [100, 555, 1, 99, 1001, 0, 10000]) {
      expect(dollarsToCents(centsToDollars(cents))).toBe(cents);
    }
  });
});
