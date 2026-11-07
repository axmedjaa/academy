import Link from "next/link";
import type { OrderView } from "@/lib/academies/book-preorders";
import { formatMoney } from "@/lib/ui/money";
import { PayButton, ToneBadge } from "./books-sections";
import { BTN_SECONDARY } from "./books-ui";
import { buyerOf, initials, paymentBadge } from "./books-view";

/** One order as the design's compact order row (B03 / B06): a coloured
 * edge for the payment status, the buyer (a student, or another person with
 * phone and branch), Total / Paid / Balance, the status, View, and Record
 * Payment while money is owed. The order's books and reference are on its
 * own page (View). On phones the figures and actions wrap under the buyer. */
export function OrderCard({ order }: { order: OrderView }) {
  const buyer = buyerOf(order);
  const accent = order.paymentStatus === "unpaid" ? "bg-[#DC2626]" : order.paymentStatus === "partially_paid" ? "bg-[#F59E0B]" : "bg-[#2F6B4F]";
  const avatar =
    order.paymentStatus === "unpaid" ? "bg-[#FEF3C7] text-[#92400E]" : order.buyerType === "other_person" ? "bg-[#DBEAFE] text-[#1E40AF]" : "bg-brand-tint text-brand";
  const owes = order.balanceCents > 0;
  return (
    <article className="relative mb-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-card transition-shadow duration-150 hover:shadow-[0_8px_20px_rgba(17,24,39,0.08)]">
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-[5px] ${accent}`} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 pl-[25px] pr-5">
        <div className="flex min-w-0 flex-[1_1_200px] items-center gap-3.5">
          <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold ${avatar}`}>
            {initials(buyer.name)}
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold leading-tight [overflow-wrap:anywhere]">{buyer.name}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted">
              {buyer.id} · {buyer.sub}
            </p>
          </div>
        </div>
        <dl className="grid min-w-0 flex-[0_1_300px] grid-cols-3 gap-3 max-sm:flex-[1_1_100%]">
          <Figure label="Total" value={formatMoney(order.totalCents, order.currency)} />
          <Figure label="Paid" value={formatMoney(order.paidCents, order.currency)} />
          <Figure
            label="Balance"
            value={formatMoney(order.balanceCents, order.currency)}
            tone={owes ? "text-[#B91C1C]" : "text-[#166534]"}
          />
        </dl>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5 max-sm:ml-0 max-sm:w-full max-sm:justify-start">
          <ToneBadge badge={paymentBadge(order.paymentStatus)} />
          <Link href={`/academy/books/orders/${order.id}`} className={`${BTN_SECONDARY} px-4`} aria-label={`View order for ${buyer.name}`}>
            View
          </Link>
          {owes && <PayButton orderId={order.id} />}
        </div>
      </div>
    </article>
  );
}

function Figure({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 text-lg font-bold leading-tight tabular-nums [overflow-wrap:anywhere] ${tone}`}>{value}</dd>
    </div>
  );
}
