/**
 * Pure helpers and labels for book orders (Student / Other Buyer), kept
 * apart from lib/academies/book-orders.ts (server-only, imports the DB) so
 * client components can use them.
 */

export const BOOK_ORDER_STATUSES = ["ordered", "received", "cancelled"] as const;
export type BookOrderStatus = (typeof BOOK_ORDER_STATUSES)[number];
export const BOOK_ORDER_STATUS_LABEL: Record<BookOrderStatus, string> = {
  ordered: "Ordered",
  received: "Received",
  cancelled: "Cancelled",
};

export const BOOK_ORDER_PAYMENT_METHODS = ["cash", "mobile_money", "bank_transfer"] as const;
export type BookOrderPaymentMethod = (typeof BOOK_ORDER_PAYMENT_METHODS)[number];
export const BOOK_ORDER_PAYMENT_METHOD_LABEL: Record<BookOrderPaymentMethod, string> = {
  cash: "Cash",
  mobile_money: "Mobile money",
  bank_transfer: "Bank transfer",
};

export type BookOrderPaymentStatus = "unpaid" | "partially_paid" | "paid";
export const BOOK_ORDER_PAYMENT_STATUS_LABEL: Record<BookOrderPaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Fully paid",
};

/** Derived, never stored: nothing paid / some paid / the whole total paid. */
export function bookOrderPaymentStatus(totalCents: number, paidCents: number): BookOrderPaymentStatus {
  if (paidCents <= 0) return totalCents === 0 ? "paid" : "unpaid";
  return paidCents >= totalCents ? "paid" : "partially_paid";
}
