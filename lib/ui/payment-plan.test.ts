import { describe, expect, it } from "vitest";
import { describePaymentPlan, parseDollarsToCents, splitInstallments } from "./payment-plan";

describe("payment plan helpers", () => {
  it("splits like the server, last installment absorbing the remainder", () => {
    expect(splitInstallments(10000, 3)).toEqual([3333, 3333, 3334]);
    expect(splitInstallments(18000, 6)).toEqual([3000, 3000, 3000, 3000, 3000, 3000]);
  });

  it("describes installments, not a frequency", () => {
    expect(describePaymentPlan(18000, 6, "USD")).toBe("6 monthly payments of $30.00");
    expect(describePaymentPlan(10000, 3, "USD")).toBe("3 monthly payments of $33.33 (last $33.34)");
    expect(describePaymentPlan(18000, 1, "USD")).toBe("Full payment of $180.00");
  });

  it("parses typed dollar amounts", () => {
    expect(parseDollarsToCents("180")).toBe(18000);
    expect(parseDollarsToCents("1,200.5")).toBe(120050);
    expect(parseDollarsToCents("12.345")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
  });
});
