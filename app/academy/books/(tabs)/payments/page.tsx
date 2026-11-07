import Link from "next/link";
import { redirect } from "next/navigation";
import { PREORDER_PAYMENT_METHODS, PREORDER_PAYMENT_METHOD_LABEL } from "@/lib/academies/book-preorder-math";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { ToneBadge, VerifyButton } from "../../books-sections";
import { BTN_SECONDARY, CARD, EmptyCard, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { OrderCard } from "../../order-card";
import { buyerOf, buyerSearchText, formatIsoDate, sumByCurrency } from "../../books-view";

const PAGE_SIZE = 8;

/**
 * Payments (design B06): money students pay for their book orders, full or
 * partial, by cash, mobile money, bank transfer or other. Two views: the
 * orders that still owe money, and the payment history with verification.
 * No online payment is taken. Academy subscription payments are separate.
 */
export default async function PreorderPaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const view = get("view") === "history" ? "history" : "out";
  const q = get("q").toLowerCase();
  const method = get("method");
  const ver = get("ver");
  const { orders } = preordersResult.overview;

  const payments = orders.flatMap((o) => o.payments.map((p) => ({ p, o })));
  const unverified = payments.filter((x) => !x.p.verified);
  const owing = orders.filter((o) => o.balanceCents > 0);

  const outRows = owing
    .filter((o) => !q || buyerSearchText(o).includes(q))
    .sort((a, b) => b.balanceCents - a.balanceCents);
  const histRows = payments
    .filter((x) => (!method || x.p.method === method) && (!ver || (ver === "verified") === x.p.verified))
    .filter((x) => !q || `${buyerSearchText(x.o)} ${(x.p.reference ?? "").toLowerCase()}`.includes(q))
    .sort((a, b) => (a.p.paidOn < b.p.paidOn ? 1 : a.p.paidOn > b.p.paidOn ? -1 : b.p.createdAt.getTime() - a.p.createdAt.getTime()));

  const tabLink = (key: "out" | "history", label: string, count: number) => {
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
      <SectionHead title="Payments" description="Record the money students pay for their book orders, in full or in parts. Book payments only; academy subscription payments are separate." />
      <KpiGrid
        items={[
          { label: "Amount Paid", value: sumByCurrency(payments.map((x) => ({ cents: x.p.amountCents, currency: x.o.currency }))) },
          { label: "Remaining Balance", value: sumByCurrency(owing.map((o) => ({ cents: o.balanceCents, currency: o.currency }))) },
          { label: "To verify", value: unverified.length },
        ]}
      />
      <div role="tablist" aria-label="Payment views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-[#EEF0F3] p-1">
        {tabLink("out", "Remaining Balances", owing.length)}
        {tabLink("history", "Payment History", payments.length)}
      </div>

      {view === "out" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-3">
            <SearchField placeholder="Search name, student ID, phone or order" />
          </div>
          {outRows.length === 0 ? (
            <EmptyCard
              title="No remaining balances"
              description={orders.length ? "Every order is paid in full." : "Balances appear here once orders exist."}
              action={
                <Link href={orders.length ? "/academy/books/payments?view=history" : "/academy/books/orders"} className={BTN_SECONDARY}>
                  {orders.length ? "View payment history" : "Go to orders"}
                </Link>
              }
            />
          ) : (
            paginate(outRows, page, 6).map((o) => <OrderCard key={o.id} order={o} />)
          )}
          <Pager page={page} pageSize={6} total={outRows.length} params={params} />
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-3">
            <SearchField placeholder="Search name, order or reference" />
            <FilterSelect param="method" label="Payment method" options={[{ value: "", label: "All methods" }, ...PREORDER_PAYMENT_METHODS.map((m) => ({ value: m, label: PREORDER_PAYMENT_METHOD_LABEL[m] }))]} />
            <FilterSelect
              param="ver"
              label="Verification"
              options={[
                { value: "", label: "All payments" },
                { value: "unverified", label: "Not verified yet" },
                { value: "verified", label: "Verified" },
              ]}
            />
          </div>
          {histRows.length === 0 ? (
            <EmptyCard
              title={payments.length ? "No payments match" : "No payments recorded"}
              description={payments.length ? "Try a different search or clear the filters." : "Record a payment against an order when the academy receives money."}
              action={
                payments.length ? (
                  <Link href="/academy/books/payments?view=history" className={BTN_SECONDARY}>
                    Clear filters
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className={`${CARD} overflow-hidden`}>
              {paginate(histRows, page, PAGE_SIZE).map(({ p, o }, i) => (
                <div
                  key={p.id}
                  className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1fr)_auto] ${i ? "border-t border-border" : ""}`}
                >
                  <div>
                    <p className="font-bold tabular-nums">{formatMoney(p.amountCents, o.currency)}</p>
                    <p className="text-xs text-muted">{formatIsoDate(p.paidOn)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{o.buyerName}</p>
                    <p className="truncate text-xs text-muted">{buyerOf(o).id} · {buyerOf(o).sub}</p>
                    <Link href={`/academy/books/orders/${o.id}`} className="text-sm font-semibold">
                      Order {o.reference}
                    </Link>
                  </div>
                  <div className="min-w-0">
                    <p>{PREORDER_PAYMENT_METHOD_LABEL[p.method]}</p>
                    <p className="truncate text-xs text-muted">{p.reference ?? "No reference"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted">Recorded by</p>
                    <p className="truncate text-sm">{p.recordedByLabel}</p>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1">
                    <ToneBadge badge={p.verified ? { label: "Verified", tone: "green" } : { label: "Unverified", tone: "amber" }} />
                    {!p.verified && (
                      <VerifyButton paymentId={p.id} summary={`${formatMoney(p.amountCents, o.currency)} by ${PREORDER_PAYMENT_METHOD_LABEL[p.method].toLowerCase()} from ${o.buyerName} (${o.reference})`} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2">
            <Pager page={page} pageSize={PAGE_SIZE} total={histRows.length} params={params} />
          </div>
        </>
      )}
    </>
  );
}
