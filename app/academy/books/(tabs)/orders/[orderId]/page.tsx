import Link from "next/link";
import { redirect } from "next/navigation";
import { BOOK_ORDER_PAYMENT_METHOD_LABEL, BOOK_ORDER_PAYMENT_STATUS_LABEL } from "@/lib/academies/book-order-math";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { getBooksOverview } from "../../../books-data";
import { CancelOrderButton, GatedAction, PayButton, ToneBadge } from "../../../books-sections";
import { CARD, EmptyCard, KpiGrid } from "../../../books-ui";
import { BUYER_TYPE_LABEL, buyerOrderStatusBadge, formatIsoDate, issueBadge, issueStatusOf, orderNo, orderPaymentBadge, plural } from "../../../books-view";

/**
 * One book order (Student or Other Buyer): the buyer, the books at their
 * selling price, the money (total, paid, balance and every payment) and the
 * books given (how many, when, by whom). Record payment, Give books, Change
 * discount and Cancel appear only when they apply and the member may use
 * them; the server checks every rule again. Another academy's order, an
 * order outside the member's branches, or an old supplier order reads as
 * not found.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { ordersResult, booksResult } = overview;
  if (!ordersResult.ok) {
    return <PageMessage title={ordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={ordersResult.error.message} />;
  }
  const back = (
    <Link href="/academy/books/orders" className="mb-4 inline-flex min-h-11 items-center gap-1 font-semibold">
      ← Orders
    </Link>
  );
  const order = ordersResult.overview.orders.find((o) => o.id === orderId);
  if (!order) {
    return (
      <>
        {back}
        <EmptyCard title="This order was not found." description="The link may be wrong, or the order belongs to a branch you can't see." />
      </>
    );
  }
  const m = (cents: number) => formatMoney(cents, order.currency);
  const stockOf = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b.stockQuantity]));
  const issues = ordersResult.overview.issues.filter((x) => x.orderId === order.id);
  const cancelled = order.status === "cancelled";
  const remaining = order.copies - order.issuedCopies;
  const canGiveNow = !cancelled && order.outstandingCents === 0 && order.items.some((i) => i.quantity > i.issuedQuantity && (stockOf.get(i.bookId) ?? 0) > 0);
  const history = [
    { at: order.createdAt.getTime(), when: formatDate(order.createdAt), text: `Order created: ${plural(order.copies, "copy", "copies")}, ${m(order.totalCents)}`, by: order.createdByLabel },
    ...order.payments.map((p) => ({ at: p.createdAt.getTime(), when: formatIsoDate(p.paidOn), text: `Payment ${m(p.amountCents)} by ${BOOK_ORDER_PAYMENT_METHOD_LABEL[p.method].toLowerCase()}`, by: p.recordedByLabel })),
    ...issues.map((x) => ({ at: x.createdAt.getTime(), when: formatIsoDate(x.issuedOn), text: `Gave ${x.quantity} × ${x.bookName}`, by: x.issuedByLabel })),
  ].sort((a, b) => b.at - a.at);

  return (
    <>
      {back}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted tabular-nums">Order {orderNo(order.orderNumber)}</p>
          <h2 className="text-2xl font-bold [overflow-wrap:anywhere]">{order.buyerName}</h2>
          <p className="mt-1 text-sm text-muted">Ordered {formatIsoDate(order.orderDate)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <ToneBadge badge={buyerOrderStatusBadge(order.status)} />
            {!cancelled && <ToneBadge badge={orderPaymentBadge(order.paymentStatus)} />}
            {!cancelled && <ToneBadge badge={issueBadge(issueStatusOf(order.issuedCopies, order.copies))} />}
          </div>
        </div>
        {!cancelled && (
          <div className="flex flex-wrap gap-2">
            {canGiveNow && (
              <GatedAction need="canIssue" dialog={{ kind: "issue", orderId: order.id }}>
                Give books
              </GatedAction>
            )}
            {order.outstandingCents > 0 && <PayButton orderId={order.id} />}
            {order.paidCents === 0 && order.issuedCopies === 0 && (
              <>
                <GatedAction need="canManageOrders" dialog={{ kind: "discount", orderId: order.id }} variant="secondary">
                  Change discount
                </GatedAction>
                <CancelOrderButton orderId={order.id} summary={`Order ${orderNo(order.orderNumber)} for ${order.buyerName}: ${plural(order.copies, "copy", "copies")}, ${m(order.totalCents)}.`} />
              </>
            )}
          </div>
        )}
      </div>

      <KpiGrid
        items={[
          { label: "Order total", value: m(order.totalCents), sub: order.discountCents > 0 ? `After ${m(order.discountCents)} discount` : undefined },
          { label: "Paid", value: m(order.paidCents), sub: BOOK_ORDER_PAYMENT_STATUS_LABEL[order.paymentStatus] },
          { label: "Balance", value: cancelled ? "—" : m(order.outstandingCents) },
          { label: "Books given", value: `${order.issuedCopies} of ${order.copies}`, sub: !cancelled && remaining > 0 ? `${remaining} still to give` : undefined },
        ]}
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className={`${CARD} p-4`}>
            <h3 className="mb-3 font-bold">Buyer</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Buyer type</dt>
                <dd className="font-semibold">{order.buyerType ? BUYER_TYPE_LABEL[order.buyerType] : "—"}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted">Name</dt>
                <dd className="font-semibold [overflow-wrap:anywhere]">
                  {order.studentId ? <Link href={`/academy/students/${order.studentId}`}>{order.buyerName}</Link> : order.buyerName}
                </dd>
              </div>
              {order.studentNumber && (
                <div>
                  <dt className="text-xs text-muted">Student ID</dt>
                  <dd className="font-semibold tabular-nums">{order.studentNumber}</dd>
                </div>
              )}
              {order.branchName && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Branch</dt>
                  <dd className="font-semibold [overflow-wrap:anywhere]">{order.branchName}</dd>
                </div>
              )}
              {order.buyerPhone && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Phone</dt>
                  <dd className="font-semibold [overflow-wrap:anywhere]">{order.buyerPhone}</dd>
                </div>
              )}
              {order.buyerEmail && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Email</dt>
                  <dd className="font-semibold [overflow-wrap:anywhere]">{order.buyerEmail}</dd>
                </div>
              )}
            </dl>
            {order.notes && <p className="mt-3 text-sm text-muted">Note: {order.notes}</p>}
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <h3 className="px-4 pb-2 pt-4 font-bold">Books</h3>
            {order.items.map((item) => (
              <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3">
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]">{item.bookName}</p>
                  <p className="text-xs text-muted tabular-nums">
                    {item.quantity} × {m(item.unitCostCents)} · {item.issuedQuantity} given
                    {!cancelled && item.quantity > item.issuedQuantity ? ` · ${item.quantity - item.issuedQuantity} to give · ${stockOf.get(item.bookId) ?? 0} in stock` : ""}
                  </p>
                </div>
                <p className="font-semibold tabular-nums">{m(item.lineTotalCents)}</p>
              </div>
            ))}
            <div className="border-t border-border bg-app px-4 py-3 text-sm tabular-nums">
              {order.discountCents > 0 && (
                <>
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span>{m(order.subtotalCents)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Discount</span>
                    <span>−{m(order.discountCents)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between font-bold">
                <span>Total</span>
                <span>{m(order.totalCents)}</span>
              </div>
            </div>
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <h3 className="px-4 pb-2 pt-4 font-bold">Payments</h3>
            {order.payments.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted">No payments yet.</p>
            ) : (
              order.payments.map((p) => (
                <div key={p.id} className="grid grid-cols-2 items-center gap-3 border-t border-border px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
                  <div>
                    <p className="font-bold tabular-nums">{m(p.amountCents)}</p>
                    <p className="text-xs text-muted">{formatIsoDate(p.paidOn)}</p>
                  </div>
                  <div className="min-w-0">
                    <p>{BOOK_ORDER_PAYMENT_METHOD_LABEL[p.method]}</p>
                    <p className="truncate text-xs text-muted">{p.reference ?? "No reference"}</p>
                  </div>
                  <p className="col-span-2 text-xs text-muted md:col-span-1">Recorded by {p.recordedByLabel}</p>
                </div>
              ))
            )}
          </section>

          <section className={`${CARD} overflow-hidden`}>
            <h3 className="px-4 pb-2 pt-4 font-bold">Books given</h3>
            {issues.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted">
                {cancelled ? "Nothing was given." : order.outstandingCents > 0 ? "Books are given once the order is fully paid." : "Nothing given yet."}
              </p>
            ) : (
              issues.map((x) => (
                <div key={x.id} className="grid grid-cols-2 items-center gap-3 border-t border-border px-4 py-3 md:grid-cols-[110px_minmax(0,1.5fr)_70px_minmax(0,1fr)]">
                  <p className="font-semibold tabular-nums">{formatIsoDate(x.issuedOn)}</p>
                  <div className="min-w-0">
                    <p className="[overflow-wrap:anywhere]">{x.bookName}</p>
                    {x.notes && <p className="truncate text-xs text-muted">{x.notes}</p>}
                  </div>
                  <p className="font-bold tabular-nums">×{x.quantity}</p>
                  <p className="text-xs text-muted">By {x.issuedByLabel}</p>
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
                <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-brand" />
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
