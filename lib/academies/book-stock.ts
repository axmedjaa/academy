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
