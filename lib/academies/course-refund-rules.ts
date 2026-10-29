/**
 * Course-withdrawal refund rules (approved policy): a refund is available
 * only when a student withdraws from a course, and the most that can ever
 * be refunded for an enrollment is
 *
 *   net amount paid for that course − refunds already recorded for it.
 *
 * "Paid for that course" is never the student's payments in general: it is
 * each payment's APPROVED allocations to this enrollment's fee periods,
 * exactly the figure the fee periods already show as paid. A reversed
 * payment is already out of it (its status is no longer approved), so it
 * is never subtracted a second time here. An ADJUSTED payment drops out
 * the same way: the existing adjustment flips the original to "reversed"
 * and adds a corrected row that is itself "reversed" with no allocations,
 * so the corrected amount is not counted as paid for the course either
 * (an existing limitation of adjustments; for refunds it can only make the
 * cap lower, never higher). A payment that funded several courses
 * contributes only its share for this one.
 *
 * Pure functions, no database: the server recomputes these inside the
 * refund transaction from locked rows; the withdraw dialog uses them to
 * preview the same figures.
 */
import { parseDollarsToCents } from "@/lib/ui/payment-plan";

/** One original payment's share of an enrollment. */
export interface EnrollmentPaymentShare {
  paymentId: string;
  receivedAt: string | Date;
  /** Approved allocations of this payment to this enrollment's fee periods. */
  allocatedCents: number;
  /** Refunds already recorded against this payment for this enrollment. */
  refundedCents: number;
}

export function paidForEnrollmentCents(shares: EnrollmentPaymentShare[]): number {
  return shares.reduce((sum, share) => sum + Math.max(0, share.allocatedCents), 0);
}

export function refundedForEnrollmentCents(shares: EnrollmentPaymentShare[]): number {
  return shares.reduce((sum, share) => sum + Math.max(0, share.refundedCents), 0);
}

/** The approved cap: net paid for the course minus refunds already recorded (never below zero). */
export function refundableCents(shares: EnrollmentPaymentShare[]): number {
  return shares.reduce((sum, share) => sum + Math.max(0, share.allocatedCents - share.refundedCents), 0);
}

export type RefundAmountCheck = { ok: true; amountCents: number } | { ok: false; message: string };

/**
 * Parses and checks a typed refund amount ("25", "25.50"). Never rounds:
 * more than two decimals, signs, letters or an empty value are rejected.
 */
export function checkRefundAmount(input: string, refundable: number, format: (cents: number) => string): RefundAmountCheck {
  const cents = parseDollarsToCents(input);
  if (cents === null) return { ok: false, message: "Enter an amount like 25.00, with at most two decimals." };
  return checkRefundCents(cents, refundable, format);
}

export function checkRefundCents(cents: number, refundable: number, format: (cents: number) => string): RefundAmountCheck {
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, message: "The refund must be more than zero." };
  if (refundable <= 0) return { ok: false, message: "Nothing paid for this course is left to refund." };
  if (cents > refundable) return { ok: false, message: `At most ${format(refundable)} can be refunded for this course.` };
  return { ok: true, amountCents: cents };
}

/**
 * Which original payments a refund is recorded against: newest payment
 * first, never more from a payment than its remaining share of this
 * enrollment. Only decides the links for traceability — the amount itself
 * is the operator's, already checked against the cap. Returns null when
 * the amount exceeds what is refundable (callers check first).
 */
export function attributeRefund(shares: EnrollmentPaymentShare[], amountCents: number): { paymentId: string; amountCents: number }[] | null {
  if (amountCents > refundableCents(shares)) return null;
  const time = (value: string | Date) => new Date(value).getTime();
  const newestFirst = [...shares].sort((a, b) => time(b.receivedAt) - time(a.receivedAt) || b.paymentId.localeCompare(a.paymentId));
  const links: { paymentId: string; amountCents: number }[] = [];
  let left = amountCents;
  for (const share of newestFirst) {
    if (left <= 0) break;
    const available = Math.max(0, share.allocatedCents - share.refundedCents);
    if (available === 0) continue;
    const take = Math.min(left, available);
    links.push({ paymentId: share.paymentId, amountCents: take });
    left -= take;
  }
  return links;
}
