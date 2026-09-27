import { describe, expect, it } from "vitest";
import { getStatusTone } from "./status";

describe("getStatusTone", () => {
  it.each([
    ["active", "green"],
    ["archived", "gray"],
    ["pending_approval", "amber"],
    ["approved", "green"],
    ["rejected", "red"],
    ["cancelled", "red"],
    ["reversed", "slate"],
    ["paid", "green"],
    ["unpaid", "amber"],
    ["posted", "green"],
    ["open", "gray"],
    ["partially_paid", "amber"],
  ] as const)("maps %s to %s", (status, tone) => {
    expect(getStatusTone(status)).toBe(tone);
  });

  it("falls back to gray for an unknown status", () => {
    expect(getStatusTone("some_future_status")).toBe("gray");
  });
});
