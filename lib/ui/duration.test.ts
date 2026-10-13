import { describe, expect, it } from "vitest";
import { formatRetryAfter } from "./duration";

describe("formatRetryAfter", () => {
  it.each([
    // [input seconds, expected]
    [0, "a moment"],
    [-5, "a moment"],
    [Number.NaN, "a moment"],
    [Number.POSITIVE_INFINITY, "a moment"],
    [1, "1 second"],
    [2, "2 seconds"],
    [45, "45 seconds"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [61, "1 minute and 1 second"],
    [90, "1 minute and 30 seconds"],
    [119, "1 minute and 59 seconds"],
    [120, "2 minutes"],
    [121, "2 minutes and 1 second"],
    [570, "9 minutes and 30 seconds"],
    [599, "9 minutes and 59 seconds"],
    [600, "10 minutes"],
    [3599, "59 minutes and 59 seconds"],
    [3600, "1 hour"],
    [3601, "1 hour"], // leftover seconds are dropped once in hour range
    [3660, "1 hour and 1 minute"],
    [3661, "1 hour and 1 minute"],
    [7200, "2 hours"],
    [7260, "2 hours and 1 minute"],
    [7320, "2 hours and 2 minutes"],
  ] as const)("%s seconds -> %s", (input, expected) => {
    expect(formatRetryAfter(input)).toBe(expected);
  });

  it("rounds a fractional input up, never down (never promises an earlier retry than allowed)", () => {
    expect(formatRetryAfter(59.1)).toBe("1 minute"); // ceil(59.1) = 60
    expect(formatRetryAfter(60.9)).toBe("1 minute and 1 second"); // ceil(60.9) = 61
    expect(formatRetryAfter(0.1)).toBe("1 second"); // ceil(0.1) = 1
  });

  it("never contains a raw second-count suffix like \"570s\"", () => {
    expect(formatRetryAfter(570)).not.toMatch(/\d+s\b/);
  });
});
