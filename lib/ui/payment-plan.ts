import { formatMoney } from "./money";

/**
 * Display helpers for an enrollment's payment plan. The stored value
 * (`paymentPlanIntervalMonths`, 1/2/3/4/6/12) is the NUMBER of equal monthly
 * installments the total fee is split into — see the "Payment schedule
 * model" comment in lib/academies/fee-periods.ts. Labels and summaries here
 * say exactly that, never "every N months".
 */

/** Installment counts offered for a "Monthly installments" plan (1 is Full payment). */
export const MONTHLY_INSTALLMENT_COUNTS = [2, 3, 4, 6, 12] as const;

export const PAYMENT_PLAN_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Full payment" },
  ...MONTHLY_INSTALLMENT_COUNTS.map((count) => ({ value: count, label: `${count} monthly installments` })),
];

/** Same split as fee-periods.ts `splitIntoMonthlyInstallments`: equal
 * installments, the last one absorbing any remainder. */
export function splitInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const installments = new Array<number>(count).fill(base);
  installments[count - 1] = totalCents - base * (count - 1);
  return installments;
}

/** "6 monthly payments of $30.00" (or "Full payment of $180.00"). */
export function describePaymentPlan(totalCents: number, count: number, currency: string): string {
  if (count <= 1) return `Full payment of ${formatMoney(totalCents, currency)}`;
  const parts = splitInstallments(totalCents, count);
  const first = formatMoney(parts[0], currency);
  const last = parts[count - 1];
  return last === parts[0]
    ? `${count} monthly payments of ${first}`
    : `${count} monthly payments of ${first} (last ${formatMoney(last, currency)})`;
}

/** Parses a typed dollar amount ("180", "180.5", "1,200.00") to cents. */
export function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
