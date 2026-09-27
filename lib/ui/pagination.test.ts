import { describe, expect, it } from "vitest";
import { buildPaginationItems, parsePageParam } from "./pagination";

describe("parsePageParam", () => {
  it("defaults to 1 when there is no page param", () => {
    expect(parsePageParam({})).toBe(1);
  });

  it("parses a plain numeric string", () => {
    expect(parsePageParam({ page: "3" })).toBe(3);
  });

  it("takes the first value when page is an array (repeated query param)", () => {
    expect(parsePageParam({ page: ["2", "5"] })).toBe(2);
  });

  it.each(["0", "-1", "abc", ""])("falls back to 1 for an invalid value %j", (value) => {
    expect(parsePageParam({ page: value })).toBe(1);
  });
});

describe("buildPaginationItems", () => {
  it("returns an empty array for a single page (no controls should render)", () => {
    expect(buildPaginationItems(1, 1)).toEqual([]);
  });

  it("returns an empty array for zero total pages", () => {
    expect(buildPaginationItems(1, 0)).toEqual([]);
  });

  it("shows every page number when the total is small — no ellipsis", () => {
    expect(buildPaginationItems(1, 4)).toEqual([1, 2, 3, 4]);
    expect(buildPaginationItems(3, 4)).toEqual([1, 2, 3, 4]);
  });

  it("collapses a single gap with one ellipsis marker near the start", () => {
    expect(buildPaginationItems(1, 10)).toEqual([1, 2, "ellipsis", 10]);
  });

  it("collapses a single gap with one ellipsis marker near the end", () => {
    expect(buildPaginationItems(10, 10)).toEqual([1, "ellipsis", 9, 10]);
  });

  it("shows two ellipsis markers when the current page is in the middle, far from both ends", () => {
    expect(buildPaginationItems(5, 10)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  });

  it("never shows an ellipsis for a gap of exactly one page (renders the number instead)", () => {
    // Current page 2 of 4: anchors {1,4} plus neighbors {1,2,3} -> no gap
    // ever exceeds 1, so every page from 1..4 appears with no ellipsis.
    expect(buildPaginationItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("clamps an out-of-range current page instead of producing invalid items", () => {
    expect(buildPaginationItems(999, 10)).toEqual([1, "ellipsis", 9, 10]);
    expect(buildPaginationItems(0, 10)).toEqual([1, 2, "ellipsis", 10]);
  });
});
