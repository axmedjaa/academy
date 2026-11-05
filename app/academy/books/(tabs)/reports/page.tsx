import { redirect } from "next/navigation";
import {
  PREORDER_DISTRIBUTION_LABEL,
  PREORDER_PAYMENT_METHODS,
  PREORDER_PAYMENT_METHOD_LABEL,
  PREORDER_PAYMENT_STATUS_LABEL,
} from "@/lib/academies/book-preorder-math";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { GatedAction } from "../../books-sections";
import { CARD, EmptyCard, KpiGrid, SectionHead, readParams } from "../../books-ui";
import { plural, sumByCurrency } from "../../books-view";

/**
 * Reports (design B09): totals across pre-order campaigns, from the same
 * scoped read as every section. Amounts in different currencies are listed
 * side by side, never added together. Branch-limited members see their
 * branches' orders and payments; received copies are academy-wide.
 */
export default async function BookReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const { get } = readParams(await searchParams);
  const campaignId = get("campaign");
  const { orders: allOrders, campaigns: allCampaigns, receipts } = preordersResult.overview;
  const campaigns = campaignId ? allCampaigns.filter((c) => c.id === campaignId) : allCampaigns;
  const orders = campaignId ? allOrders.filter((o) => o.campaignId === campaignId) : allOrders;
  const books = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b]));
  const money = (rows: typeof orders, pick: (o: (typeof orders)[number]) => number) => sumByCurrency(rows.map((o) => ({ cents: pick(o), currency: o.currency })));
  const rcpts = receipts.filter((r) => !campaignId || r.campaignId === campaignId);
  const usable = rcpts.reduce((s, r) => s + r.quantityReceived - r.damagedQuantity, 0);
  const damaged = rcpts.reduce((s, r) => s + r.damagedQuantity, 0);

  const byBook = new Map<string, { ordered: number; given: number }>();
  for (const o of orders) for (const i of o.items) {
    const cur = byBook.get(i.bookId) ?? { ordered: 0, given: 0 };
    cur.ordered += i.quantity;
    cur.given += i.givenQuantity;
    byBook.set(i.bookId, cur);
  }
  const bookRows = [...byBook].sort((a, b) => b[1].ordered - a[1].ordered);
  const payments = orders.flatMap((o) => o.payments.map((p) => ({ p, currency: o.currency })));
  const methodTotals = PREORDER_PAYMENT_METHODS.map((m) => ({ m, rows: payments.filter((x) => x.p.method === m) }));
  const maxMethod = Math.max(1, ...methodTotals.map((t) => t.rows.reduce((s, x) => s + x.p.amountCents, 0)));
  const statusRows: [string, number, boolean][] = [
    [PREORDER_PAYMENT_STATUS_LABEL.unpaid, orders.filter((o) => o.paymentStatus === "unpaid").length, false],
    [PREORDER_PAYMENT_STATUS_LABEL.partially_paid, orders.filter((o) => o.paymentStatus === "partially_paid").length, false],
    [PREORDER_PAYMENT_STATUS_LABEL.paid, orders.filter((o) => o.paymentStatus === "paid").length, false],
    [PREORDER_DISTRIBUTION_LABEL.none, orders.filter((o) => o.distributionStatus === "none").length, true],
    [PREORDER_DISTRIBUTION_LABEL.partial, orders.filter((o) => o.distributionStatus === "partial").length, false],
    [PREORDER_DISTRIBUTION_LABEL.all, orders.filter((o) => o.distributionStatus === "all").length, false],
  ];
  const th = "border-b border-border bg-app px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted";
  const td = "border-b border-border px-4 py-3 tabular-nums";

  return (
    <>
      <SectionHead title="Reports" description="Totals across book pre-order campaigns." />
      {allCampaigns.length > 0 && (
        <div className="mb-4">
          <FilterSelect param="campaign" label="Campaign" options={[{ value: "", label: "All campaigns" }, ...allCampaigns.map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
      )}
      {orders.length === 0 ? (
        <EmptyCard
          title="No orders to report on"
          description="Reports fill in as orders, payments and receiving are recorded."
          action={
            <GatedAction need="canManage" dialog={{ kind: "order" }} variant="secondary">
              New order
            </GatedAction>
          }
        />
      ) : (
        <>
          <KpiGrid
            items={[
              { label: "Total orders", value: orders.length, sub: `${money(orders, (o) => o.totalCents)} order value` },
              { label: "Books ordered", value: orders.reduce((s, o) => s + o.copies, 0), sub: "Copies" },
              { label: "Payments collected", value: money(orders, (o) => o.paidCents), sub: `${money(orders, (o) => o.unverifiedCents)} not yet verified` },
              { label: "Outstanding balances", value: money(orders, (o) => o.balanceCents), sub: plural(orders.filter((o) => o.balanceCents > 0).length, "order", "orders") },
              { label: "Books received", value: usable, sub: `${damaged} damaged copies not counted` },
              { label: "Books given", value: orders.reduce((s, o) => s + o.given, 0), sub: `${orders.reduce((s, o) => s + o.copies - o.given, 0)} still to collect` },
            ]}
          />
          <h3 className="mb-2 mt-1 font-bold">Campaign summary</h3>
          <div className={`${CARD} overflow-x-auto`}>
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr>
                  {["Campaign", "Orders", "Books ordered", "Order value", "Collected", "Outstanding", "Received", "Given"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const os = orders.filter((o) => o.campaignId === c.id);
                  return (
                    <tr key={c.id}>
                      <td className={`${td} font-semibold`}>{c.name}</td>
                      <td className={td}>{os.length}</td>
                      <td className={td}>{os.reduce((s, o) => s + o.copies, 0)}</td>
                      <td className={td}>{money(os, (o) => o.totalCents)}</td>
                      <td className={td}>{money(os, (o) => o.paidCents)}</td>
                      <td className={`${td} text-[#B91C1C]`}>{money(os, (o) => o.balanceCents)}</td>
                      <td className={td}>{c.books.reduce((s, b) => s + b.usable, 0)}</td>
                      <td className={td}>{os.reduce((s, o) => s + o.given, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h3 className="mb-2 mt-6 font-bold">Books</h3>
          <div className={`${CARD} overflow-x-auto`}>
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr>
                  {["Book", "Ordered", "Received", "Given", "Waiting to be given"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bookRows.map(([bookId, m]) => {
                  const book = books.get(bookId);
                  const recv = rcpts.filter((r) => r.bookId === bookId).reduce((s, r) => s + r.quantityReceived - r.damagedQuantity, 0);
                  return (
                    <tr key={bookId}>
                      <td className={td}>
                        <span className="block font-semibold">{book?.name ?? "Book"}</span>
                        <span className="block text-xs text-muted">{[book?.subject, book?.classLevel].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td className={td}>{m.ordered}</td>
                      <td className={td}>{recv}</td>
                      <td className={td}>{m.given}</td>
                      <td className={td}>{m.ordered - m.given}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
            <section className={`${CARD} p-4`}>
              <h3 className="mb-3 font-bold">Payments by method</h3>
              {methodTotals.map(({ m, rows }) => {
                const cents = rows.reduce((s, x) => s + x.p.amountCents, 0);
                return (
                  <div key={m} className="mb-3">
                    <div className="flex justify-between gap-2 text-sm">
                      <span>{PREORDER_PAYMENT_METHOD_LABEL[m]}</span>
                      <span className="font-semibold tabular-nums">{sumByCurrency(rows.map((x) => ({ cents: x.p.amountCents, currency: x.currency })))}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded bg-[#F1F2F5]">
                      <div className="h-full rounded bg-brand" style={{ width: `${Math.round((cents / maxMethod) * 100)}%` }} />
                    </div>
                  </div>
                );
              })}
            </section>
            <section className={`${CARD} p-4`}>
              <h3 className="mb-3 font-bold">Orders by status</h3>
              {statusRows.map(([label, value, divider], i) => (
                <div key={label} className={`flex justify-between py-2 text-sm ${i === 0 ? "" : divider ? "border-t-2 border-border" : "border-t border-border"}`}>
                  <span>{label}</span>
                  <span className="font-semibold tabular-nums">{value}</span>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}
