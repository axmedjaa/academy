import { z } from "zod";

/**
 * Duplicate-submission protection for finance records (security audit
 * SEC-M-06, migration 0046).
 *
 * Each staff form generates one UUID per submission and resends the same
 * value when the same submission is retried (double click, network retry,
 * resubmitted form). The service:
 *   1. checks authorization and validates input exactly as before;
 *   2. looks the key up in its own table, within the actor's academy; if a
 *      row exists it re-checks that the actor may see it (branch scope) and
 *      that it was created by the same operation with the same details, then
 *      returns it with `duplicate: true` instead of inserting;
 *   3. otherwise inserts with the key. Two identical requests racing both
 *      reach the insert; the per-academy unique index lets one commit and
 *      aborts the other's whole transaction (audit rows, stock change,
 *      linked income, balance recalculation), which then returns the winner.
 *
 * The key is optional at the service level so internal callers and existing
 * code paths that write without one behave exactly as before; every staff
 * form sends one. A key that is present must be a UUID.
 */
export const idempotencyKeyField = z.string().trim().uuid("Invalid request key.").optional();

/** Unique index names created by drizzle/0046_finance_idempotency_keys.sql. */
export const IDEMPOTENCY_INDEX = {
  studentPayments: "student_payments_academy_idempotency_unique",
  incomeRecords: "income_records_academy_idempotency_unique",
  expenseRecords: "expense_records_academy_idempotency_unique",
  bookSales: "book_sales_academy_idempotency_unique",
} as const;

/** True only for a unique violation of the given idempotency index, so an
 * unrelated constraint failure is never mistaken for a duplicate. */
export function isIdempotencyViolation(err: unknown, indexName: string): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === indexName) return true;
    current = candidate.cause;
  }
  return false;
}

/** Returned when a key is replayed for a different operation, or with
 * different details than the record it already created. */
export const IDEMPOTENCY_KEY_REUSED = {
  code: "conflict" as const,
  message: "This form was already submitted with different details. Reload the page and try again.",
};
