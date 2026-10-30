import { describe, expect, it } from "vitest";
import {
  attributeRefund,
  checkRefundAmount,
  checkRefundCents,
  paidForEnrollmentCents,
  refundableCents,
  refundedForEnrollmentCents,
  type EnrollmentPaymentShare,
} from "./course-refund-rules";

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const shares: EnrollmentPaymentShare[] = [
  { paymentId: "p-old", receivedAt: "2026-08-01T10:00:00Z", allocatedCents: 1_000, refundedCents: 0 },
  { paymentId: "p-mid", receivedAt: "2026-09-01T10:00:00Z", allocatedCents: 1_500, refundedCents: 500 },
  { paymentId: "p-new", receivedAt: "2026-10-01T10:00:00Z", allocatedCents: 500, refundedCents: 0 },
];

describe("refund cap: net paid for the course minus refunds already recorded", () => {
  it("adds only this enrollment's shares and subtracts earlier refunds", () => {
    expect(paidForEnrollmentCents(shares)).toBe(3_000);
    expect(refundedForEnrollmentCents(shares)).toBe(500);
    expect(refundableCents(shares)).toBe(2_500);
  });

  it("is zero when nothing was paid or everything is already refunded", () => {
    expect(refundableCents([])).toBe(0);
    expect(refundableCents([{ ...shares[0], refundedCents: 1_000 }])).toBe(0);
  });

  it("never goes negative for a payment whose refunds exceed its share (e.g. bad legacy data)", () => {
    expect(refundableCents([{ ...shares[0], refundedCents: 1_200 }, shares[2]])).toBe(500);
  });
});

describe("refund amount checks (server and dialog)", () => {
  it("accepts a positive amount up to the cap, including exactly the cap", () => {
    expect(checkRefundAmount("25", 2_500, fmt)).toEqual({ ok: true, amountCents: 2_500 });
    expect(checkRefundAmount("10.50", 2_500, fmt)).toEqual({ ok: true, amountCents: 1_050 });
  });

  it("rejects zero, negatives, junk and more than two decimals instead of rounding", () => {
    for (const bad of ["0", "0.00", "-5", "abc", "", "1.005", "1e3"]) {
      expect(checkRefundAmount(bad, 2_500, fmt).ok).toBe(false);
    }
  });

  it("rejects one cent over the cap, and anything when nothing is refundable", () => {
    expect(checkRefundCents(2_501, 2_500, fmt)).toEqual({ ok: false, message: "At most $25.00 can be refunded for this course." });
    expect(checkRefundCents(1, 0, fmt).ok).toBe(false);
  });
});

describe("attributeRefund: links a refund to the original payments, newest first", () => {
  it("takes from the newest payment first, never more than its remaining share", () => {
    expect(attributeRefund(shares, 1_200)).toEqual([
      { paymentId: "p-new", amountCents: 500 },
      { paymentId: "p-mid", amountCents: 700 },
    ]);
  });

  it("covers the full cap across every payment, skipping fully refunded ones", () => {
    const links = attributeRefund(shares, 2_500)!;
    expect(links.reduce((sum, link) => sum + link.amountCents, 0)).toBe(2_500);
    expect(links.map((link) => link.paymentId)).toEqual(["p-new", "p-mid", "p-old"]);
  });

  it("refuses an amount above the cap", () => {
    expect(attributeRefund(shares, 2_501)).toBeNull();
  });
});
