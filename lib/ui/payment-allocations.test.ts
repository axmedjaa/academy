import { describe, expect, it } from "vitest";
import { describeAllocations } from "./payment-allocations";

describe("describeAllocations", () => {
  it("names the one course a single-period payment funded, with no detail", () => {
    expect(describeAllocations([{ enrollmentId: "e1", courseName: "Backend", batchName: "B1" }])).toEqual({ label: "Backend · B1", detail: null });
  });

  it("keeps a payment over several periods of one course as one label with the period count", () => {
    const periods = [1, 2, 3].map(() => ({ enrollmentId: "e1", courseName: "Backend", batchName: "B1" }));
    expect(describeAllocations(periods)).toEqual({ label: "Backend · B1", detail: "3 fee periods" });
  });

  it("names every course when one payment funded periods of several enrollments", () => {
    expect(
      describeAllocations([
        { enrollmentId: "e1", courseName: "Backend", batchName: "B1" },
        { enrollmentId: "e2", courseName: "Frontend", batchName: "B1" },
        { enrollmentId: "e1", courseName: "Backend", batchName: "B1" },
      ]),
    ).toEqual({ label: "Backend · B1; Frontend · B1", detail: "3 fee periods" });
  });
});
