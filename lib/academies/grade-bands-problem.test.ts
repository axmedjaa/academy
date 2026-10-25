import { describe, expect, it } from "vitest";
import { gradeBandsProblem } from "./grade-configurations";

// Pure check (no database access).
describe("gradeBandsProblem", () => {
  it("accepts valid, non-overlapping bands", () => {
    expect(
      gradeBandsProblem([
        { label: "A", minMark: 90, maxMark: 100 },
        { label: "F", minMark: 0, maxMark: 89 },
      ]),
    ).toBeNull();
  });

  it("requires at least one band", () => {
    expect(gradeBandsProblem([])).toMatch(/at least one/);
  });

  it("rejects an inverted range", () => {
    expect(gradeBandsProblem([{ label: "B", minMark: 80, maxMark: 70 }])).toMatch(/Band B/);
  });

  it("rejects overlapping bands", () => {
    expect(
      gradeBandsProblem([
        { label: "A", minMark: 80, maxMark: 100 },
        { label: "B", minMark: 70, maxMark: 85 },
      ]),
    ).toMatch(/overlap/);
  });
});
