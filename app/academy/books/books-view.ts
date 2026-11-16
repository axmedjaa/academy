import { formatMoney } from "@/lib/ui/money";
import {
  BOOK_ORDER_PAYMENT_STATUS_LABEL,
  BOOK_ORDER_STATUS_LABEL,
  type BookOrderPaymentStatus,
  type BookOrderStatus,
} from "@/lib/academies/book-order-math";

/**
 * Presentation helpers for Book Management (design B01-B12), safe on the
 * server and in the browser. Display only: every figure they format was
 * computed by the server.
 */

export type Tone = "gray" | "amber" | "green" | "red" | "blue" | "slate";

/** Order badges: order status and the derived payment status. */
export const ORDER_STATUS_TONE: Record<BookOrderStatus, Tone> = { ordered: "blue", received: "green", cancelled: "gray" };
export const ORDER_PAYMENT_TONE: Record<BookOrderPaymentStatus, Tone> = { unpaid: "red", partially_paid: "amber", paid: "green" };
export const orderStatusBadge = (status: BookOrderStatus) => ({ label: BOOK_ORDER_STATUS_LABEL[status], tone: ORDER_STATUS_TONE[status] });
export const orderPaymentBadge = (status: BookOrderPaymentStatus) => ({ label: BOOK_ORDER_PAYMENT_STATUS_LABEL[status], tone: ORDER_PAYMENT_TONE[status] });

/** Order status as staff read it: open (active) or cancelled. */
export const buyerOrderStatusBadge = (status: BookOrderStatus) =>
  status === "cancelled" ? { label: "Cancelled", tone: "gray" as Tone } : { label: "Open", tone: "blue" as Tone };

/** How many of the ordered copies were given to the buyer. */
export type IssueStatus = "not_given" | "partly_given" | "all_given";
export function issueStatusOf(issued: number, ordered: number): IssueStatus {
  if (ordered > 0 && issued >= ordered) return "all_given";
  return issued > 0 ? "partly_given" : "not_given";
}
const ISSUE_BADGE: Record<IssueStatus, { label: string; tone: Tone }> = {
  not_given: { label: "Not given yet", tone: "gray" },
  partly_given: { label: "Partly given", tone: "blue" },
  all_given: { label: "All given", tone: "green" },
};
export const issueBadge = (status: IssueStatus) => ISSUE_BADGE[status];

/** "#12" — the academy's order number. */
export const orderNo = (n: number) => `#${n}`;

export const BUYER_TYPE_LABEL = { student: "Student", other_person: "Other buyer" } as const;

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
