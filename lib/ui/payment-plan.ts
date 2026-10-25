import { formatMoney } from "./money";

/**
 * Display helpers for an enrollment's payment plan. The stored value
 * (`paymentPlanIntervalMonths`, 1/2/3/4/6/12) is the NUMBER of equal monthly
 * installments the total fee is split into — see the "Payment schedule
 * model" comment in lib/academies/fee-periods.ts. Labels and summaries here
 * say exactly that, never "every N months".
 */

export const PAYMENT_PLAN_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 payment" },
  { value: 2, label: "2 monthly payments" },
  { value: 3, label: "3 monthly payments" },
  { value: 4, label: "4 monthly payments" },
  { value: 6, label: "6 monthly payments" },
  { value: 12, label: "12 monthly payments" },
];

/** Same split as fee-periods.ts `splitIntoMonthlyInstallments`: equal
 * installments, the last one absorbing any remainder. */
export function splitInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const installments = new Array<number>(count).fill(base);
  installments[count - 1] = totalCents - base * (count - 1);
  return installments;
}

/** "6 monthly payments of $30.00" (or "1 payment of $180.00"). */
export function describePaymentPlan(totalCents: number, count: number, currency: string): string {
  if (count <= 1) return `1 payment of ${formatMoney(totalCents, currency)}`;
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
