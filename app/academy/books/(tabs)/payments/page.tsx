import Link from "next/link";
import { redirect } from "next/navigation";
import { BOOK_ORDER_PAYMENT_METHODS, BOOK_ORDER_PAYMENT_METHOD_LABEL } from "@/lib/academies/book-order-math";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { ClearFilters, DateParamField, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { GatedAction, ToneBadge } from "../../books-sections";
import { CARD, EmptyCard, InfoNote, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { BUYER_TYPE_LABEL, formatIsoDate, orderNo, orderPaymentBadge, sumByCurrency } from "../../books-view";

const PAGE_SIZE = 10;

/**
 * Payments: money RECEIVED from book buyers (students and other buyers) for
 * their orders — the payment history (search, method, buyer type and date
 * filters) and the open orders that still have a balance. Each payment is
 * academy income (category "book_order"), recorded once; partial payments
 * are allowed, overpaying is refused by the server. Manual payments only.
 */
export default async function BookPaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { ordersResult } = overview;
  if (!ordersResult.ok) {
    return <PageMessage title={ordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={ordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  // "Balance" (orders still owing) opens first; "History" is the last tab.
  const view = get("view") === "history" ? "history" : "balances";
  const q = get("q").toLowerCase().replace(/^#/, "");
  const method = get("method");
  const type = get("type");
  const from = get("from");
  const to = get("to");
  const { orders } = ordersResult.overview;
  const payments = orders
    .flatMap((o) => o.payments.map((p) => ({ p, o })))
    .sort((a, b) => (a.p.paidOn === b.p.paidOn ? b.p.createdAt.getTime() - a.p.createdAt.getTime() : a.p.paidOn < b.p.paidOn ? 1 : -1));
  const match = (o: (typeof orders)[number], extra = "") =>
    (!q || `${o.orderNumber} ${o.buyerName} ${o.studentNumber ?? ""} ${o.buyerPhone ?? ""} ${extra}`.toLowerCase().includes(q)) && (!type || o.buyerType === type);
  const histRows = payments.filter((x) => match(x.o, x.p.reference ?? "") && (!method || x.p.method === method) && (!from || x.p.paidOn >= from) && (!to || x.p.paidOn <= to));
  const owing = orders.filter((o) => o.status !== "cancelled" && o.outstandingCents > 0);
  const balanceRows = owing.filter((o) => match(o)).sort((a, b) => b.outstandingCents - a.outstandingCents);
  const filtered = Boolean(q || method || type || from || to);

  const tabLink = (key: "history" | "balances", label: string, count: number) => {
    const on = view === key;
    return (
      <Link
        href={key === "history" ? "/academy/books/payments?view=history" : "/academy/books/payments"}
        role="tab"
        aria-selected={on}
        className={`inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-semibold !no-underline hover:!no-underline ${on ? "bg-surface !text-brand shadow-card" : "!text-[#374151]"}`}
      >
        {label} <span className="rounded-full bg-surface/70 px-1.5 text-xs tabular-nums">{count}</span>
      </Link>
    );
  };

  return (
    <>
      <SectionHead title="Payments" description="Money received from students and other buyers for their book orders, in full or in parts." />
      <InfoNote>
        <b>Money coming in.</b> Each payment is recorded once as academy income. Record a payment from an order, or with Record payment above.
      </InfoNote>
      <KpiGrid
        items={[
          { label: "Received", value: sumByCurrency(histRows.map((x) => ({ cents: x.p.amountCents, currency: x.o.currency }))), sub: filtered ? "Matching the filters" : `${payments.length} payments` },
          { label: "Balance to collect", value: sumByCurrency(owing.map((o) => ({ cents: o.outstandingCents, currency: o.currency }))), sub: `${owing.length} open orders` },
        ]}
      />
      <div role="tablist" aria-label="Payment views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-[#EEF0F3] p-1">
        {tabLink("balances", "Balance", owing.length)}
        {tabLink("history", "History", payments.length)}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SearchField placeholder={view === "history" ? "Order number, buyer, phone or reference" : "Order number, buyer or phone"} />
        <FilterSelect
          param="type"
          label="Buyer type"
          options={[
            { value: "", label: "All buyers" },
            { value: "student", label: "Students" },
            { value: "other_person", label: "Other buyers" },
          ]}
        />
        {view === "history" && (
          <>
            <FilterSelect param="method" label="Payment method" options={[{ value: "", label: "All methods" }, ...BOOK_ORDER_PAYMENT_METHODS.map((pm) => ({ value: pm, label: BOOK_ORDER_PAYMENT_METHOD_LABEL[pm] }))]} />
            <DateParamField param="from" label="From" />
            <DateParamField param="to" label="To" />
          </>
        )}
        {filtered && <ClearFilters params={["q", "type", "method", "from", "to"]} />}
      </div>

      {view === "history" ? (
        histRows.length === 0 ? (
          <EmptyCard title={payments.length ? "No payments match" : "No payments yet"} description={payments.length ? "Try a different search or filter." : "Payments appear here when a buyer pays for an order."} />
        ) : (
          <div className={`${CARD} overflow-hidden`}>
            {paginate(histRows, page, PAGE_SIZE).map(({ p, o }, i) => (
              <div key={p.id} className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)] ${i ? "border-t border-border" : ""}`}>
                <div>
                  <p className="font-bold tabular-nums">{formatMoney(p.amountCents, o.currency)}</p>
                  <p className="text-xs text-muted">{formatIsoDate(p.paidOn)}</p>
                </div>
                <div className="min-w-0">
                  <Link href={`/academy/books/orders/${o.id}`} className="block truncate font-semibold">
                    {orderNo(o.orderNumber)} · {o.buyerName}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    {o.buyerType ? BUYER_TYPE_LABEL[o.buyerType] : "Buyer"}
                    {o.studentNumber ? ` · ${o.studentNumber}` : ""}
                  </p>
                </div>
                <div className="min-w-0">
                  <p>{BOOK_ORDER_PAYMENT_METHOD_LABEL[p.method]}</p>
                  <p className="truncate text-xs text-muted">{p.reference ?? "No reference"}</p>
                </div>
                <p className="min-w-0 truncate text-xs text-muted">Recorded by {p.recordedByLabel}</p>
              </div>
            ))}
          </div>
        )
      ) : balanceRows.length === 0 ? (
        <EmptyCard title={owing.length ? "No orders match" : "No balances to collect"} description={owing.length ? "Try a different search." : "Every open order is fully paid."} />
      ) : (
        <div className={`${CARD} overflow-hidden`}>
          {paginate(balanceRows, page, PAGE_SIZE).map((o, i) => (
            <div key={o.id} className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))_auto] ${i ? "border-t border-border" : ""}`}>
              <div className="col-span-2 min-w-0 md:col-span-1">
                <Link href={`/academy/books/orders/${o.id}`} className="block truncate font-semibold">
                  {orderNo(o.orderNumber)} · {o.buyerName}
                </Link>
                <p className="text-xs text-muted">Ordered {formatIsoDate(o.orderDate)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Total</p>
                <p className="tabular-nums">{formatMoney(o.totalCents, o.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Paid</p>
                <p className="tabular-nums">{formatMoney(o.paidCents, o.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Balance</p>
                <p className="font-bold tabular-nums">{formatMoney(o.outstandingCents, o.currency)}</p>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1">
                <ToneBadge badge={orderPaymentBadge(o.paymentStatus)} />
                <GatedAction need="canManageOrders" dialog={{ kind: "pay", orderId: o.id }} variant="secondary">
                  Record payment
                </GatedAction>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2">
        <Pager page={page} pageSize={PAGE_SIZE} total={view === "history" ? histRows.length : balanceRows.length} params={params} />
      </div>
    </>
  );
}
