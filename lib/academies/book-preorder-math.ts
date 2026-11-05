/**
 * Pure book pre-order rules, safe to import on the server and in the
 * browser (no database, no "use server"). The server is the authority:
 * lib/academies/book-preorders.ts recomputes every figure with these same
 * functions inside its transactions and never trusts a client total. The
 * client uses them only to preview what the server will save.
 */

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "open", "closed", "receiving", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  open: "Open",
  closed: "Closed",
  receiving: "Receiving",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Statuses whose deliveries may still be recorded. A draft campaign has
 * never been offered and a cancelled one will not be delivered. */
export const RECEIVABLE_STATUSES: readonly CampaignStatus[] = ["scheduled", "open", "closed", "receiving", "completed"];

export const PREORDER_PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer", "other"] as const;
export type PreorderPaymentMethod = (typeof PREORDER_PAYMENT_METHODS)[number];

export const PREORDER_PAYMENT_METHOD_LABEL: Record<PreorderPaymentMethod, string> = {
  cash: "Cash",
  mobile_money: "Mobile money",
  bank_transfer: "Bank transfer",
  other: "Other",
};

export interface PreorderLineInput {
  unitPriceCents: number;
  quantity: number;
}

/** Order pricing: line subtotals, a whole-number percentage discount on the
 * order subtotal (rounded to the cent), and the total (never below zero). */
export function computePreorderPricing(
  lines: PreorderLineInput[],
  discountPercent: number,
): { lineSubtotals: number[]; subtotalCents: number; discountAmountCents: number; totalCents: number } {
  const lineSubtotals = lines.map((line) => line.unitPriceCents * line.quantity);
  const subtotalCents = lineSubtotals.reduce((sum, value) => sum + value, 0);
  const pct = Math.min(100, Math.max(0, Math.trunc(discountPercent)));
  const discountAmountCents = Math.round((subtotalCents * pct) / 100);
  return { lineSubtotals, subtotalCents, discountAmountCents, totalCents: Math.max(0, subtotalCents - discountAmountCents) };
}

export type PreorderPaymentStatus = "unpaid" | "partially_paid" | "paid";

export const PREORDER_PAYMENT_STATUS_LABEL: Record<PreorderPaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid in full",
};

export function preorderPaymentStatus(totalCents: number, paidCents: number): PreorderPaymentStatus {
  if (paidCents <= 0) return totalCents <= 0 ? "paid" : "unpaid";
  return paidCents >= totalCents ? "paid" : "partially_paid";
}

export type PreorderDistributionStatus = "none" | "partial" | "all";

export const PREORDER_DISTRIBUTION_LABEL: Record<PreorderDistributionStatus, string> = {
  none: "Nothing given yet",
  partial: "Partly given",
  all: "All books given",
};

export function preorderDistributionStatus(copies: number, given: number): PreorderDistributionStatus {
  if (given <= 0) return "none";
  return given >= copies ? "all" : "partial";
}

/**
 * Copies of one book that can still be given out from a campaign's pool:
 * usable copies received (received minus damaged) minus copies already
 * given to any student of that campaign. Never negative.
 */
export function availableToGive(usableReceived: number, alreadyGiven: number): number {
  return Math.max(0, usableReceived - alreadyGiven);
}

/** The most that may be given right now on one order line: what the
 * student still has to collect, capped by what the pool can supply. */
export function maxGivable(lineQuantity: number, lineGiven: number, poolAvailable: number): number {
  return Math.max(0, Math.min(lineQuantity - lineGiven, poolAvailable));
}

/** PO-<year>-<4-digit sequence>, e.g. PO-2026-0007. */
export function formatPreorderReference(year: number, sequence: number): string {
  return `PO-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Sequence part of a reference for the given year, or 0 when the
 * reference belongs to another year or another format. */
export function referenceSequence(reference: string, year: number): number {
  const match = /^PO-(\d{4})-(\d+)$/.exec(reference);
  if (!match || Number(match[1]) !== year) return 0;
  return Number(match[2]);
}
