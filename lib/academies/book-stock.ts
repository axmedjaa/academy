/**
 * Pure stock-status logic, deliberately split out of lib/academies/books.ts
 * (a server-only module that imports the `pg` driver) so the Stock page's
 * client component can compute/display stock buckets without pulling
 * server-only code into the browser bundle. No DB, no "use server" — safe
 * to import from either side.
 */

export const LOW_STOCK_THRESHOLD = 5;

export type StockStatus = "out_of_stock" | "low_stock" | "in_stock";

/** Smallest-sensible-solution stock bucketing (no new schema column — see
 * this task's own "don't create unnecessary schema complexity" guidance):
 * a fixed, app-wide low-stock threshold rather than a per-book/per-academy
 * configurable value. */
export function getStockStatus(stockQuantity: number): StockStatus {
  if (stockQuantity <= 0) return "out_of_stock";
  if (stockQuantity <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

/**
 * Manual stock adjustments (Books > Stock): every change needs a reason, as
 * in any stock system. Client-safe labels, shared by the dialog, the server
 * validation and the stock history.
 */
export const STOCK_IN_REASONS = ["received", "returned", "stocktake", "other"] as const;
export const STOCK_OUT_REASONS = ["damaged", "lost", "mistake", "stocktake", "other"] as const;
export type StockInReason = (typeof STOCK_IN_REASONS)[number];
export type StockOutReason = (typeof STOCK_OUT_REASONS)[number];
export type StockAdjustReason = StockInReason | StockOutReason;
export type StockDirection = "in" | "out";

export const STOCK_REASON_LABEL: Record<StockAdjustReason, string> = {
  received: "Delivery received",
  returned: "Returned to shelf",
  damaged: "Damaged",
  lost: "Lost",
  mistake: "Added by mistake",
  stocktake: "Stock-take correction",
  other: "Other",
};

/** Most copies one adjustment may move (a typing guard, not a business limit). */
export const MAX_STOCK_ADJUSTMENT = 100_000;

/** What moved the stock, as shown in a book's stock history. */
export type StockMovementSource = "adjustment" | "sale" | "refund" | "order_issue" | "manual_update";

export const STOCK_SOURCE_LABEL: Record<StockMovementSource, string> = {
  adjustment: "Stock adjustment",
  sale: "Sale",
  refund: "Refund (copies returned)",
  order_issue: "Given from an order",
  manual_update: "Stock edited",
};
