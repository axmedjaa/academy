import { formatMoney } from "@/lib/ui/money";
import {
  CAMPAIGN_STATUS_LABEL,
  PREORDER_DISTRIBUTION_LABEL,
  PREORDER_PAYMENT_STATUS_LABEL,
  type CampaignStatus,
  type PreorderDistributionStatus,
  type PreorderPaymentStatus,
} from "@/lib/academies/book-preorder-math";

/**
 * Presentation helpers for Book Management (design B01-B12), safe on the
 * server and in the browser. Display only: every figure they format was
 * computed by the server.
 */

export type Tone = "gray" | "amber" | "green" | "red" | "blue" | "slate";

/** Badge tones from the design's status table. */
export const CAMPAIGN_TONE: Record<CampaignStatus, Tone> = {
  draft: "gray",
  scheduled: "blue",
  open: "green",
  closed: "amber",
  receiving: "blue",
  completed: "gray",
  cancelled: "red",
};
export const PAYMENT_TONE: Record<PreorderPaymentStatus, Tone> = { unpaid: "red", partially_paid: "amber", paid: "green" };
export const DISTRIBUTION_TONE: Record<PreorderDistributionStatus, Tone> = { none: "gray", partial: "blue", all: "green" };

export const campaignBadge = (status: CampaignStatus) => ({ label: CAMPAIGN_STATUS_LABEL[status], tone: CAMPAIGN_TONE[status] });
export const paymentBadge = (status: PreorderPaymentStatus) => ({ label: PREORDER_PAYMENT_STATUS_LABEL[status], tone: PAYMENT_TONE[status] });
export const distributionBadge = (status: PreorderDistributionStatus) => ({ label: PREORDER_DISTRIBUTION_LABEL[status], tone: DISTRIBUTION_TONE[status] });

/** Amounts in several currencies are never added together: "USD 10.00 + SLSH 5,000". */
export function sumByCurrency(rows: { cents: number; currency: string }[], fallbackCurrency = "USD"): string {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cents);
  if (totals.size === 0) return formatMoney(0, fallbackCurrency);
  return [...totals].map(([currency, cents]) => formatMoney(cents, currency)).join(" + ");
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-17" -> "Oct 17, 2026" (calendar date, no timezone shift). */
export function formatIsoDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function shortIsoDate(value: string): string {
  const [, m, d] = value.split("-").map(Number);
  if (!m || !d) return value;
  return `${MONTHS[m - 1]} ${d}`;
}

/** The design's book tile colours, picked by subject so a subject keeps
 * one colour everywhere. */
const TILE_COLORS = ["#850019", "#1F4E79", "#2F6B4F", "#8A5A00", "#4B3F72", "#0F5C63", "#7A3E48"];

export function tileOf(subject: string | null, title: string): { color: string; text: string } {
  const key = subject || title;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { color: TILE_COLORS[h % TILE_COLORS.length], text: key.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "BK" };
}

/** At most two titles, then "+N more" (design order cards). */
export function titlesLine(titles: string[]): string {
  return titles.length > 2 ? `${titles.slice(0, 2).join(", ")} +${titles.length - 2} more` : titles.join(", ");
}

/** Today in the viewer's timezone as YYYY-MM-DD. */
export function todayIso(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round(Math.min(part / whole, 1) * 100);
}

export interface BuyerFields {
  buyerType: "student" | "other_person";
  buyerName: string;
  studentNumber: string | null;
  buyerPhone: string | null;
  branchName: string;
}

/**
 * How an order's buyer is shown everywhere (design update: Student and
 * Other Person buyers). A student shows the student number; another person
 * shows the phone when there is one. Both show the order's branch.
 */
export function buyerOf(order: BuyerFields): { name: string; id: string; sub: string; isOther: boolean } {
  if (order.buyerType === "other_person") {
    return { name: order.buyerName, id: order.buyerPhone || "No phone", sub: `Other person · ${order.branchName}`, isOther: true };
  }
  return { name: order.buyerName, id: order.studentNumber ?? "", sub: order.branchName, isOther: false };
}

/** Text an order matches in searches: reference, name, student number, phone. */
export function buyerSearchText(order: BuyerFields & { reference: string }): string {
  return `${order.reference} ${order.buyerName} ${order.studentNumber ?? ""} ${order.buyerPhone ?? ""} ${(order.buyerPhone ?? "").replace(/\D/g, "")}`.toLowerCase();
}
