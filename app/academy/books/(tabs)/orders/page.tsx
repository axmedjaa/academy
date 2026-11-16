import Link from "next/link";
import { redirect } from "next/navigation";
import { BOOK_ORDER_PAYMENT_STATUS_LABEL, type BookOrderPaymentStatus } from "@/lib/academies/book-order-math";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { ClearFilters, DateParamField, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { GatedAction, ToneBadge } from "../../books-sections";
import { CARD, EmptyCard, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { BUYER_TYPE_LABEL, buyerOrderStatusBadge, formatIsoDate, issueBadge, issueStatusOf, orderNo, orderPaymentBadge, plural, sumByCurrency } from "../../books-view";

const PAGE_SIZE = 10;
const PAYMENT_STATUSES: BookOrderPaymentStatus[] = ["unpaid", "partially_paid", "paid"];

/**
 * Orders: every book order from a Student or an Other Buyer, in one list —
 * order number, buyer and buyer type, copies, total, paid, balance, and the
 * payment, order and giving statuses. Search by order number, buyer, student
 * number, phone or email; filter by buyer type, payment status, order status
 * and order date. Create Order opens the one order form. Figures come from
 * the server (book-orders.ts), already limited to the member's branches.
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { ordersResult } = overview;
  if (!ordersResult.ok) {
    return <PageMessage title={ordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={ordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const q = get("q").toLowerCase().replace(/^#/, "");
  const type = get("type");
  const pay = get("pay");
  const status = get("status");
  const from = get("from");
  const to = get("to");
  const { orders } = ordersResult.overview;

  const rows = orders.filter(
    (o) =>
      (!q || `${o.orderNumber} ${o.buyerName} ${o.studentNumber ?? ""} ${o.buyerPhone ?? ""} ${o.buyerEmail ?? ""}`.toLowerCase().includes(q)) &&
      (!type || o.buyerType === type) &&
      (!pay || (o.status !== "cancelled" && o.paymentStatus === pay)) &&
      (!status || (status === "cancelled" ? o.status === "cancelled" : o.status !== "cancelled")) &&
      (!from || o.orderDate >= from) &&
      (!to || o.orderDate <= to),
  );
  const open = orders.filter((o) => o.status !== "cancelled");
  const filtered = Boolean(q || type || pay || status || from || to);

  return (
    <>
      <SectionHead title="Orders" description="Books bought by students and other buyers. Open an order to see its payments and the books given." />
      <KpiGrid
        items={[
          { label: "Open orders", value: open.length, sub: `${open.filter((o) => o.outstandingCents > 0).length} with a balance` },
          { label: "Total ordered", value: sumByCurrency(open.map((o) => ({ cents: o.totalCents, currency: o.currency }))) },
          { label: "Balance to collect", value: sumByCurrency(open.map((o) => ({ cents: o.outstandingCents, currency: o.currency }))) },
        ]}
      />
      {orders.length > 0 && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <SearchField placeholder="Order number, buyer, student number, phone or email" />
          <FilterSelect
            param="type"
            label="Buyer type"
            options={[
              { value: "", label: "All buyers" },
              { value: "student", label: "Students" },
              { value: "other_person", label: "Other buyers" },
            ]}
          />
          <FilterSelect param="pay" label="Payment status" options={[{ value: "", label: "Any payment status" }, ...PAYMENT_STATUSES.map((s) => ({ value: s, label: BOOK_ORDER_PAYMENT_STATUS_LABEL[s] }))]} />
          <FilterSelect
            param="status"
            label="Order status"
            options={[
              { value: "", label: "Open and cancelled" },
              { value: "open", label: "Open" },
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
          <DateParamField param="from" label="From" />
          <DateParamField param="to" label="To" />
          {filtered && <ClearFilters params={["q", "type", "pay", "status", "from", "to"]} />}
        </div>
      )}
      {rows.length === 0 ? (
        orders.length === 0 ? (
          <EmptyCard
            title="No orders yet"
            description="Create an order when a student or another buyer wants books."
            action={
              <GatedAction need="canManageOrders" dialog={{ kind: "order" }} variant="secondary">
                Create Order
              </GatedAction>
            }
          />
        ) : (
          <EmptyCard title="No orders match" description="Try a different search or filter." />
        )
      ) : (
        <div className={`${CARD} overflow-hidden`}>
          {paginate(rows, page, PAGE_SIZE).map((o, i) => (
            <Link
              key={o.id}
              href={`/academy/books/orders/${o.id}`}
              className={`grid grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-3 !text-ink !no-underline hover:bg-app hover:!no-underline md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] ${i ? "border-t border-border" : ""}`}
            >
              <div className="col-span-2 min-w-0 md:col-span-1">
                <p className="truncate font-semibold">
                  <span className="text-muted tabular-nums">{orderNo(o.orderNumber)}</span> {o.buyerName}
                </p>
                <p className="truncate text-xs text-muted">
                  {o.buyerType ? BUYER_TYPE_LABEL[o.buyerType] : "Buyer"}
                  {o.studentNumber ? ` · ${o.studentNumber}` : ""} · {formatIsoDate(o.orderDate)} · {plural(o.copies, "copy", "copies")}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted">Total</p>
                <p className="font-semibold tabular-nums">{formatMoney(o.totalCents, o.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Paid</p>
                <p className="tabular-nums">{formatMoney(o.paidCents, o.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Balance</p>
                <p className="font-semibold tabular-nums">{o.status === "cancelled" ? "—" : formatMoney(o.outstandingCents, o.currency)}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {o.status === "cancelled" ? (
                  <ToneBadge badge={buyerOrderStatusBadge(o.status)} />
                ) : (
                  <>
                    <ToneBadge badge={orderPaymentBadge(o.paymentStatus)} />
                    <ToneBadge badge={issueBadge(issueStatusOf(o.issuedCopies, o.copies))} />
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="mt-2">
        <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} params={params} />
      </div>
    </>
  );
}
