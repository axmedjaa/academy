import Link from "next/link";
import { redirect } from "next/navigation";
import { PREORDER_PAYMENT_METHOD_LABEL, PREORDER_PAYMENT_STATUS_LABEL, PREORDER_DISTRIBUTION_LABEL } from "@/lib/academies/book-preorder-math";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { getBooksOverview } from "../../../books-data";
import { BookCover } from "../../../books-actions";
import { PayButton, ToneBadge, VerifyButton } from "../../../books-sections";
import { BTN_SECONDARY, CARD, EmptyCard, KpiGrid } from "../../../books-ui";
import { buyerOf, distributionBadge, formatIsoDate, paymentBadge, plural } from "../../../books-view";

/**
 * Order details (design B05): the order's books with the price saved on
 * each line, given and remaining copies, its payments with verification,
 * and a history of everything recorded against it. An order outside the
 * caller's academy or branches reads as not found.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const back = (
    <Link href="/academy/books/orders" className="mb-4 inline-flex min-h-11 items-center gap-1 font-semibold">
      ← Student orders
    </Link>
  );
  const order = preordersResult.overview.orders.find((o) => o.id === orderId);
  if (!order) {
    return (
      <>
        {back}
        <EmptyCard title="This order was not found." description="It may belong to another branch, or the link is wrong." />
      </>
    );
  }
  const campaign = preordersResult.overview.campaigns.find((c) => c.id === order.campaignId);
  const books = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b]));
  const m = (cents: number) => formatMoney(cents, order.currency);

  type Event = { at: number; text: string; by: string; when: string; k: number };
  const history: Event[] = [
    { at: order.createdAt.getTime(), when: formatDate(order.createdAt), text: `Order created with ${plural(order.copies, "copy", "copies")} (${m(order.totalCents)})`, by: order.createdByLabel, k: 0 },
    ...order.payments.flatMap((p) => {
      const rows: Event[] = [
        {
          at: p.createdAt.getTime(),
          when: formatIsoDate(p.paidOn),
          text: `Payment of ${m(p.amountCents)} recorded by ${PREORDER_PAYMENT_METHOD_LABEL[p.method].toLowerCase()}`,
          by: p.recordedByLabel,
          k: 1,
        },
      ];
      if (p.verified) rows.push({ at: p.createdAt.getTime() + 1, when: formatIsoDate(p.paidOn), text: `Payment of ${m(p.amountCents)} verified`, by: p.verifiedByLabel ?? "Staff member", k: 1 });
      return rows;
    }),
    ...order.handovers.map((h) => ({ at: h.createdAt.getTime(), when: formatDate(h.createdAt), text: `Given ${h.quantity} × ${books.get(h.bookId)?.name ?? "Book"}`, by: h.givenByLabel, k: 2 })),
  ].sort((a, b) => b.at - a.at || b.k - a.k);

  return (
    <>
      {back}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tabular-nums">{order.reference}</h2>
          <p className="mt-1 text-sm text-muted">
            {buyerOf(order).name} · {buyerOf(order).id} · {buyerOf(order).sub} · {campaign?.name ?? "Campaign"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {order.copies > order.given && order.balanceCents === 0 && order.unverifiedCents === 0 && (
            <Link href={`/academy/books/distribution?stat=all&q=${encodeURIComponent(order.reference)}`} className={BTN_SECONDARY}>
              Give books
            </Link>
          )}
          {order.balanceCents > 0 && <PayButton orderId={order.id} />}
        </div>
      </div>
      <div className="-mt-1 mb-4 flex flex-wrap gap-2">
        <ToneBadge badge={paymentBadge(order.paymentStatus)} />
        <ToneBadge badge={distributionBadge(order.distributionStatus)} />
      </div>
      <KpiGrid
        items={[
          {
            label: "Order Total",
            value: m(order.totalCents),
            sub: `${plural(order.copies, "copy", "copies")}${order.discountAmountCents ? ` · ${order.discountPercent}% discount (${m(order.discountAmountCents)})` : ""}`,
          },
          { label: "Amount Paid", value: m(order.paidCents), sub: `${m(order.unverifiedCents)} not verified yet` },
          { label: "Remaining Balance", value: m(order.balanceCents), sub: PREORDER_PAYMENT_STATUS_LABEL[order.paymentStatus] },
          { label: "Books given", value: `${order.given} of ${order.copies}`, sub: PREORDER_DISTRIBUTION_LABEL[order.distributionStatus] },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className={`${CARD} overflow-hidden`}>
            <h3 className="px-4 pb-2 pt-4 font-bold">Books on this order</h3>
            <div className="hidden grid-cols-[minmax(0,2fr)_60px_minmax(0,1fr)_90px_90px] gap-3 border-y border-border bg-app px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted md:grid">
              <span>Book</span>
              <span>Qty</span>
              <span>Subtotal</span>
              <span>Given</span>
              <span>Remaining</span>
            </div>
            {order.items.map((item, i) => {
              const book = books.get(item.bookId);
              return (
                <div
                  key={item.id}
                  className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,2fr)_60px_minmax(0,1fr)_90px_90px] ${i ? "border-t border-border" : "border-t border-border md:border-t-0"}`}
                >
                  <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
                    {book && <BookCover book={book} size="sm" />}
                    <div className="min-w-0">
                      <p className="font-semibold [overflow-wrap:anywhere]">{book?.name ?? "Book"}</p>
                      <p className="text-xs text-muted">{m(item.unitPriceCents)} each</p>
                    </div>
                  </div>
                  <div className="tabular-nums">
                    <span className="text-xs text-muted md:hidden">Qty </span>
                    {item.quantity}
                  </div>
                  <div className="font-semibold tabular-nums">
                    <span className="text-xs font-normal text-muted md:hidden">Subtotal </span>
                    {m(item.subtotalCents)}
                  </div>
                  <div className="tabular-nums">
                    <span className="text-xs text-muted md:hidden">Given </span>
                    {item.givenQuantity} of {item.quantity}
                  </div>
                  <div className="tabular-nums">
                    <span className="text-xs text-muted md:hidden">Remaining </span>
                    {item.quantity - item.givenQuantity}
                  </div>
                </div>
              );
            })}
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <h3 className="px-4 pb-2 pt-4 font-bold">Payments</h3>
            {order.payments.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted">No payments recorded. Outstanding balance is the full order total.</p>
            ) : (
              order.payments.map((p) => (
                <div key={p.id} className="grid grid-cols-2 items-center gap-3 border-t border-border px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto]">
                  <div>
                    <p className="font-bold tabular-nums">{m(p.amountCents)}</p>
                    <p className="text-xs text-muted">{formatIsoDate(p.paidOn)}</p>
                  </div>
                  <div className="min-w-0">
                    <p>{PREORDER_PAYMENT_METHOD_LABEL[p.method]}</p>
                    <p className="truncate text-xs text-muted">{p.reference ?? "No reference"}</p>
                  </div>
                  <div className="min-w-0 text-sm">
                    <span className="text-xs text-muted">Recorded by </span>
                    {p.recordedByLabel}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ToneBadge badge={p.verified ? { label: "Verified", tone: "green" } : { label: "Unverified", tone: "amber" }} />
                    {!p.verified && <VerifyButton paymentId={p.id} summary={`${m(p.amountCents)} by ${PREORDER_PAYMENT_METHOD_LABEL[p.method].toLowerCase()} from ${order.buyerName} (${order.reference})`} />}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>

        <aside className={`${CARD} p-4`}>
          <h3 className="mb-3 font-bold">History</h3>
          <ol className="flex flex-col gap-3">
            {history.map((h, i) => (
              <li key={i} className="flex gap-3">
                <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${h.k === 0 ? "bg-brand" : h.k === 1 ? "bg-[#166534]" : "bg-[#1D4ED8]"}`} />
                <div className="min-w-0">
                  <p className="text-sm">{h.text}</p>
                  <p className="text-xs text-muted">
                    {h.when} · {h.by}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </>
  );
}
