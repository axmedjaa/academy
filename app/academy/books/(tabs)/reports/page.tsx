import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import {
  BOOK_ORDER_PAYMENT_METHODS,
  BOOK_ORDER_PAYMENT_METHOD_LABEL,
  BOOK_ORDER_PAYMENT_STATUS_LABEL,
  type BookOrderPaymentStatus,
} from "@/lib/academies/book-order-math";
import { PageMessage } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ClearFilters, DateParamField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { GatedAction } from "../../books-sections";
import { CARD, EmptyCard, readParams } from "../../books-ui";
import { BUYER_TYPE_LABEL, issueStatusOf, percent, plural, sumByCurrency, type IssueStatus } from "../../books-view";

/**
 * Reports (its own Books tab): book orders (Student and Other Buyer) and
 * Sell sales, from the same scoped reads as the other Books pages — so a
 * branch-limited member sees only their branches. Cancelled orders are left
 * out. Orders are filtered by order date, their payments by payment date,
 * sales by the day they were recorded. Amounts in different currencies are
 * listed side by side, never added together; bars use counts only.
 */

type Money = { cents: number; currency: string };

function Bar({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "gold" | "muted" }) {
  const width = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  const color = tone === "brand" ? "bg-brand" : tone === "gold" ? "bg-[#F5B638]" : "bg-[#CBD5E1]";
  return (
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-full bg-[#F1F2F5]">
      <span className={`block h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
    </span>
  );
}

function Panel({ title, icon, children, className = "" }: { title: string; icon: string; children: ReactNode; className?: string }) {
  return (
    <section className={`${CARD} overflow-hidden ${className}`}>
      <div className="flex items-center gap-2.5 border-b border-[#F0CDD5] bg-brand-tint px-4 py-3">
        <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
          <Icon name={icon} width={17} height={17} />
        </span>
        <h3 className="font-bold text-brand">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-bold leading-tight tabular-nums text-ink [overflow-wrap:anywhere]">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

export default async function BookReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { ordersResult, salesResult } = overview;
  if (!ordersResult.ok) {
    return <PageMessage title={ordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={ordersResult.error.message} />;
  }
  const { get } = readParams(await searchParams);
  const from = get("from");
  const to = get("to");
  const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);
  const money = (rows: Money[]) => sumByCurrency(rows);

  // Orders (cancelled orders excluded).
  const live = ordersResult.overview.orders.filter((o) => o.status !== "cancelled");
  const orders = live.filter((o) => inRange(o.orderDate));
  const payments = live.flatMap((o) => o.payments.filter((p) => inRange(p.paidOn)).map((p) => ({ p, currency: o.currency })));
  const orderCopies = orders.reduce((s, o) => s + o.copies, 0);
  const given = orders.reduce((s, o) => s + o.issuedCopies, 0);
  const orderTotal: Money[] = orders.map((o) => ({ cents: o.totalCents, currency: o.currency }));
  const orderReceived: Money[] = payments.map((x) => ({ cents: x.p.amountCents, currency: x.currency }));
  const orderBalance: Money[] = orders.map((o) => ({ cents: o.outstandingCents, currency: o.currency }));
  const ordersFullyPaid = orders.filter((o) => o.paymentStatus === "paid").length;

  // Sell (Books tab): direct sales, by the day they were recorded. Refunds
  // are money given back, so every money figure here is AFTER refunds
  // (what the academy kept), and copies brought back on a refund no longer
  // count as sold. Total = Received + Balance still holds: a refund lowers
  // both Total and Received by the same amount.
  const sales = salesResult.ok ? salesResult.sales.filter((s) => inRange(s.createdAt.toISOString().slice(0, 10))) : [];
  const saleCopies = sales.reduce((n, s) => n + s.quantity - s.totalReturnedQuantity, 0);
  const returnedCopies = sales.reduce((n, s) => n + s.totalReturnedQuantity, 0);
  const saleTotal: Money[] = sales.map((s) => ({ cents: s.finalAmountCents - s.totalRefundedCents, currency: s.currency }));
  const saleReceived: Money[] = sales.map((s) => ({ cents: s.netPaidCents, currency: s.currency }));
  const saleRefunded: Money[] = sales.filter((s) => s.totalRefundedCents > 0).map((s) => ({ cents: s.totalRefundedCents, currency: s.currency }));
  const saleBalance: Money[] = sales.map((s) => ({ cents: s.remainingCents, currency: s.currency }));
  const refundedSales = sales.filter((s) => s.totalRefundedCents > 0 && s.totalRefundedCents >= s.totalPaidCents).length;
  // A fully refunded sale is not "fully paid" any more.
  const salesFullyPaid = sales.filter((s) => s.paymentStatus === "paid" && s.totalRefundedCents < s.totalPaidCents).length;
  const refundedLine = saleRefunded.length > 0 ? `after ${money(saleRefunded)} refunded` : undefined;

  // Books: orders and Sell together.
  const byBook = new Map<string, { name: string; ordered: number; given: number; sold: number }>();
  for (const o of orders)
    for (const item of o.items) {
      const row = byBook.get(item.bookId) ?? { name: item.bookName, ordered: 0, given: 0, sold: 0 };
      row.ordered += item.quantity;
      row.given += item.issuedQuantity;
      byBook.set(item.bookId, row);
    }
  for (const s of sales) {
    const row = byBook.get(s.bookId) ?? { name: s.bookName, ordered: 0, given: 0, sold: 0 };
    row.sold += s.quantity - s.totalReturnedQuantity;
    byBook.set(s.bookId, row);
  }
  const books = [...byBook.values()].sort((a, b) => b.ordered + b.sold - (a.ordered + a.sold));
  const topCopies = Math.max(1, ...books.map((b) => b.ordered + b.sold));

  const payStatuses: { key: BookOrderPaymentStatus; tone: "brand" | "gold" | "muted" }[] = [
    { key: "paid", tone: "brand" },
    { key: "partially_paid", tone: "gold" },
    { key: "unpaid", tone: "muted" },
  ];
  const giveStatuses: { key: IssueStatus; label: string; tone: "brand" | "gold" | "muted" }[] = [
    { key: "all_given", label: "All given", tone: "brand" },
    { key: "partly_given", label: "Partly given", tone: "gold" },
    { key: "not_given", label: "Not given yet", tone: "muted" },
  ];
  const methodRows = BOOK_ORDER_PAYMENT_METHODS.map((method) => {
    const rows = payments.filter((x) => x.p.method === method);
    return { method, count: rows.length, amount: money(rows.map((x) => ({ cents: x.p.amountCents, currency: x.currency }))) };
  });
  const maxMethod = Math.max(1, ...methodRows.map((m) => m.count));
  const buyerRows = (["student", "other_person"] as const).map((type) => {
    const rows = orders.filter((o) => o.buyerType === type);
    return { type, count: rows.length, total: money(rows.map((o) => ({ cents: o.totalCents, currency: o.currency }))) };
  });
  const maxBuyer = Math.max(1, ...buyerRows.map((b) => b.count));

  const nothing = live.length === 0 && (!salesResult.ok || salesResult.sales.length === 0);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Reports</h2>
          <p className="text-sm text-muted">Book orders and Sell sales. Cancelled orders are not counted.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateParamField param="from" label="From" />
          <DateParamField param="to" label="To" />
          <ClearFilters params={["from", "to"]} />
        </div>
      </div>

      {nothing ? (
        <EmptyCard
          title="Nothing to report yet"
          description="Reports fill in as orders, payments and sales are recorded."
          action={
            <GatedAction need="canManageOrders" dialog={{ kind: "order" }} variant="secondary">
              Create Order
            </GatedAction>
          }
        />
      ) : (
        <>
          {/* Summary band: orders and Sell together, per currency. */}
          <section className="mb-6 rounded-2xl bg-[linear-gradient(135deg,#850019_0%,#6B0014_60%,#5E0012_100%)] p-5 text-white shadow-[0_10px_28px_rgba(133,0,25,0.22)] sm:p-6">
            <div className="text-sm font-semibold text-white/80">All book income{from || to ? " in these dates" : ""}</div>
            <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: "Total sold", value: money([...orderTotal, ...saleTotal]), sub: refundedLine },
                { label: "Received", value: money([...orderReceived, ...saleReceived]), sub: refundedLine },
                { label: "Balance to collect", value: money([...orderBalance, ...saleBalance]) },
                {
                  label: "Copies",
                  value: String(orderCopies + saleCopies),
                  sub: `${orderCopies} ordered · ${saleCopies} sold${returnedCopies > 0 ? ` · ${returnedCopies} returned` : ""}`,
                },
              ].map((item) => (
                <div key={item.label} className="min-w-0 rounded-xl bg-white/[0.08] px-4 py-3 ring-1 ring-white/15">
                  <div className="text-xs text-white/75">{item.label}</div>
                  <div className="mt-1 text-xl font-bold tabular-nums [overflow-wrap:anywhere] sm:text-2xl">{item.value}</div>
                  {item.sub && <div className="mt-0.5 text-xs text-white/70">{item.sub}</div>}
                </div>
              ))}
            </div>
          </section>

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Orders" icon="receipt_long">
              <div className="grid grid-cols-2 gap-4">
                <Figure label="Orders" value={orders.length} sub={plural(orderCopies, "copy", "copies")} />
                <Figure label="Total" value={money(orderTotal)} />
                <Figure label="Received" value={money(orderReceived)} sub={plural(payments.length, "payment", "payments")} />
                <Figure label="Balance" value={money(orderBalance)} />
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-semibold text-ink">Fully paid</span>
                    <span className="tabular-nums text-muted">
                      {ordersFullyPaid} of {orders.length}
                    </span>
                  </div>
                  <Bar value={ordersFullyPaid} max={orders.length} />
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-semibold text-ink">Books given</span>
                    <span className="tabular-nums text-muted">
                      {given} of {orderCopies} ({percent(given, orderCopies)}%)
                    </span>
                  </div>
                  <Bar value={given} max={orderCopies} />
                </div>
              </div>
            </Panel>

            <Panel title="Sell" icon="cash">
              {!salesResult.ok ? (
                <p className="text-sm text-muted">{salesResult.error.message}</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Figure
                      label="Sales"
                      value={sales.length}
                      sub={`${plural(saleCopies, "copy", "copies")}${refundedSales > 0 ? ` · ${refundedSales} refunded` : ""}`}
                    />
                    <Figure label="Total" value={money(saleTotal)} sub={refundedLine} />
                    <Figure label="Received" value={money(saleReceived)} sub={refundedLine} />
                    <Figure label="Balance" value={money(saleBalance)} />
                  </div>
                  <div className="mt-4">
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-semibold text-ink">Fully paid</span>
                      <span className="tabular-nums text-muted">
                        {salesFullyPaid} of {sales.length - refundedSales}
                      </span>
                    </div>
                    <Bar value={salesFullyPaid} max={sales.length - refundedSales} />
                  </div>
                </>
              )}
            </Panel>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Order payments" icon="payments">
              <ul className="space-y-3">
                {payStatuses.map(({ key, tone }) => {
                  const n = orders.filter((o) => o.paymentStatus === key).length;
                  return (
                    <li key={key}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{BOOK_ORDER_PAYMENT_STATUS_LABEL[key]}</span>
                        <span className="font-semibold tabular-nums">{n}</span>
                      </div>
                      <Bar value={n} max={orders.length} tone={tone} />
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <Panel title="Books given" icon="book">
              <ul className="space-y-3">
                {giveStatuses.map(({ key, label, tone }) => {
                  const n = orders.filter((o) => issueStatusOf(o.issuedCopies, o.copies) === key).length;
                  return (
                    <li key={key}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{label}</span>
                        <span className="font-semibold tabular-nums">{n}</span>
                      </div>
                      <Bar value={n} max={orders.length} tone={tone} />
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <Panel title="Buyers and methods" icon="group">
              <ul className="space-y-3">
                {buyerRows.map((row) => (
                  <li key={row.type}>
                    <div className="mb-1 flex justify-between gap-2 text-sm">
                      <span>{BUYER_TYPE_LABEL[row.type]}s</span>
                      <span className="text-right font-semibold tabular-nums">
                        {row.count} · {row.total}
                      </span>
                    </div>
                    <Bar value={row.count} max={maxBuyer} />
                  </li>
                ))}
              </ul>
              <ul className="mt-4 space-y-3 border-t border-border pt-4">
                {methodRows.map((row) => (
                  <li key={row.method}>
                    <div className="mb-1 flex justify-between gap-2 text-sm">
                      <span>{BOOK_ORDER_PAYMENT_METHOD_LABEL[row.method]}</span>
                      <span className="text-right font-semibold tabular-nums">{row.amount}</span>
                    </div>
                    <Bar value={row.count} max={maxMethod} tone="gold" />
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel title="Books" icon="menu_book" className="mb-4">
            {books.length === 0 ? (
              <p className="text-sm text-muted">No orders or sales in these dates.</p>
            ) : (
              <div className="-mx-4 -mb-4 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="border-b border-border px-4 py-2.5">Book</th>
                      <th className="border-b border-border px-4 py-2.5 text-right">Ordered</th>
                      <th className="border-b border-border px-4 py-2.5 text-right">Given</th>
                      <th className="border-b border-border px-4 py-2.5 text-right">Sold (Sell)</th>
                      <th className="w-[28%] border-b border-border px-4 py-2.5">Copies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {books.map((row) => (
                      <tr key={row.name} className="transition-colors duration-150 hover:bg-app/60">
                        <td className="border-b border-border px-4 py-3 font-semibold [overflow-wrap:anywhere]">{row.name}</td>
                        <td className="border-b border-border px-4 py-3 text-right tabular-nums">{row.ordered}</td>
                        <td className="border-b border-border px-4 py-3 text-right tabular-nums">{row.given}</td>
                        <td className="border-b border-border px-4 py-3 text-right tabular-nums">{row.sold}</td>
                        <td className="border-b border-border px-4 py-3">
                          <span className="flex items-center gap-2">
                            <Bar value={row.ordered + row.sold} max={topCopies} />
                            <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-brand">{row.ordered + row.sold}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <p className="text-xs text-muted">
            Orders are counted by order date and their payments by payment date; sales by the day they were recorded. Amounts in different currencies are
            shown side by side.
          </p>
        </>
      )}
    </>
  );
}
