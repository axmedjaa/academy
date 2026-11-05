import Link from "next/link";
import type { OrderView } from "@/lib/academies/book-preorders";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { Icon } from "@/app/academy/_shell/icons";
import { PayButton, ToneBadge } from "./books-sections";
import { BTN_SECONDARY, MoneyBoxes, ProgressBar } from "./books-ui";
import { buyerOf, initials, paymentBadge, percent, plural } from "./books-view";

/** One order as the design's order card (B03 / B06): the buyer (a
 * student, or another person with phone and branch),
 * reference, payment status, books, Total / Paid / Remaining Balance and
 * how much of the total is paid. */
export function OrderCard({ order, titles }: { order: OrderView; titles: string }) {
  const buyer = buyerOf(order);
  const accent = order.paymentStatus === "unpaid" ? "bg-[#DC2626]" : order.paymentStatus === "partially_paid" ? "bg-[#F59E0B]" : "bg-[#2F6B4F]";
  const pct = percent(order.paidCents, order.totalCents);
  return (
    <article className="relative mb-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-card transition-shadow duration-150 hover:shadow-[0_8px_20px_rgba(17,24,39,0.08)]">
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-[5px] ${accent}`} />
      <div className="flex flex-col gap-3.5 py-4 pl-[26px] pr-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <div className="flex min-w-0 flex-[1_1_240px] items-center gap-3">
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-tint to-[#E9C3CC] font-bold text-brand">
              {initials(buyer.name)}
            </span>
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight">{buyer.name}</p>
              <p className="text-[13px] text-muted">
                {buyer.id} · {buyer.sub}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-xs text-muted">
              Order {order.reference} · {formatDate(order.createdAt)}
            </span>
            <ToneBadge badge={paymentBadge(order.paymentStatus)} />
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[13px] text-[#374151]">
          <span className="flex shrink-0 text-muted">
            <Icon name="inventory_2" width={16} height={16} />
          </span>
          <span className="min-w-0 truncate">
            {plural(order.copies, "copy", "copies")} · {order.given} given · {titles}
          </span>
        </div>
        <MoneyBoxes
          items={[
            { label: "Order Total", value: formatMoney(order.totalCents, order.currency) },
            { label: "Amount Paid", value: formatMoney(order.paidCents, order.currency) },
            { label: "Remaining Balance", value: formatMoney(order.balanceCents, order.currency), tone: order.balanceCents > 0 ? "danger" : "success" },
          ]}
        />
        <ProgressBar percent={pct} color={order.paymentStatus === "paid" ? "bg-[#2F6B4F]" : "bg-[#F59E0B]"} label={`${pct}% of the order total paid`} />
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={`/academy/books/orders/${order.id}`} className={`${BTN_SECONDARY} max-w-full flex-[1_1_140px]`}>
            View Order
          </Link>
          {order.balanceCents > 0 && <PayButton orderId={order.id} className="flex-[1_1_160px]" />}
        </div>
      </div>
    </article>
  );
}
