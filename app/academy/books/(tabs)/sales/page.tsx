import Link from "next/link";
import { redirect } from "next/navigation";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";
import { getStatusTone } from "@/lib/ui/status";
import { Badge, EmptyState, PageMessage, Section } from "@/app/academy/_shell/ui";
import { ChipParamFilter, ClearFilters, DateParamField, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { getBooksOverview } from "../../books-data";
import { SaleActions } from "../../books-client";
import { GatedAction } from "../../books-sections";
import { CARD, Pager, SectionHead } from "../../books-ui";

// The design pages recent sales six at a time.
const PAGE_SIZE = 6;

const buyerOf = (sale: BookSaleListRow) =>
  sale.buyerType === "student" ? (sale.studentName ?? "Student") : (sale.otherBuyerName ?? "Other person");

/**
 * Book sales (design A16, Sales tab): every sale with its total, what has
 * been paid net of refunds, and the balance; follow-up payments, refunds
 * and receipts per row. Filters are URL params applied to the scoped
 * `listBookSales` result.
 */
export default async function BookSalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Same cached read as the Books layout above (one query per request).
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { salesResult, booksResult } = overview;
  if (!salesResult.ok) {
    return (
      <PageMessage
        title={salesResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={salesResult.error.message}
      />
    );
  }

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const q = get("q").toLowerCase();
  const status = get("status");
  const bookId = get("book");
  const method = get("method");
  const from = get("from") ? new Date(`${get("from")}T00:00:00`) : null;
  const to = get("to") ? new Date(`${get("to")}T23:59:59.999`) : null;
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const all = [...salesResult.sales].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const filtered = all.filter((sale) => {
    if (q && !`${sale.id} ${buyerOf(sale)} ${sale.bookName}`.toLowerCase().includes(q)) return false;
    if (status === "owing" && sale.remainingCents <= 0) return false;
    if (status && status !== "owing" && sale.paymentStatus !== status) return false;
    if (bookId && sale.bookId !== bookId) return false;
    if (method && sale.latestPaymentMethod !== method) return false;
    if (from && sale.createdAt < from) return false;
    if (to && sale.createdAt > to) return false;
    return true;
  });
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const books = booksResult.ok ? booksResult.books : [];
  const filteredBy = Boolean(q || status || bookId || method || from || to);

  return (
    <>
      <SectionHead title="Sell Book" description="Two ways to give someone a book. Choose the one that matches whether the book is on your shelf today." />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-2xl border border-border border-t-4 border-t-brand bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-tint text-brand">
              <Icon name="payments" width={22} height={22} />
            </span>
            <h3 className="text-lg font-bold">Sell Book</h3>
          </div>
          <p className="leading-normal text-[#4B5563]">
            <b className="text-ink">The book is in stock now.</b> Pick the buyer and the book, set the quantity and any discount, and record the payment. Stock
            goes down when the sale is saved.
          </p>
          <GatedAction need="canSell" dialog={{ kind: "sell" }} className="self-start px-5">
            Sell Book
          </GatedAction>
        </div>
        <div className="flex flex-col gap-3 rounded-2xl border border-border border-t-4 border-t-[#F5B638] bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning-bg text-[#78350F]">
              <Icon name="autorenew" width={22} height={22} />
            </span>
            <h3 className="text-lg font-bold">Pre-Order Book</h3>
          </div>
          <p className="leading-normal text-[#4B5563]">
            <b className="text-ink">The book has not arrived yet.</b> Take an order for an existing student or another person. Stock does not change until
            you receive the books, and books are given once the order is paid in full and verified.
          </p>
          <GatedAction need="canManage" dialog={{ kind: "order" }} variant="secondary" className="self-start px-5">
            Create Order
          </GatedAction>
        </div>
      </div>
      <h3 className="mb-3 text-base font-bold">Recent sales</h3>
      {all.length > 0 && (
        <div className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SearchField placeholder="Search receipt, book or buyer" />
          </div>
          {/* The design shows one search field; the existing filters stay
              available here so no way of finding a sale is lost. */}
          <details className="group" open={Boolean(status || bookId || method || from || to) || undefined}>
            <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-[13px] font-semibold text-brand [&::-webkit-details-marker]:hidden">
              <Icon name="sliders" width={16} height={16} />
              More filters
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <ChipParamFilter
                param="status"
                label="Filter by payment"
                options={[
                  { value: "", label: "All" },
                  { value: "owing", label: "Balance due" },
                  { value: "paid", label: "Paid" },
                ]}
              />
              <FilterDropdown
                param="book"
                label="Book"
                icon="book"
                options={[{ value: "", label: "All books" }, ...books.map((book) => ({ value: book.id, label: book.name }))]}
              />
              <FilterDropdown
                param="method"
                label="Method"
                icon="payments"
                options={[
                  { value: "", label: "Any method" },
                  { value: "cash", label: "Cash" },
                  { value: "mobile_money", label: "Mobile money" },
                ]}
              />
              <DateParamField param="from" label="From" />
              <DateParamField param="to" label="To" />
              <ClearFilters params={["q", "status", "book", "method", "from", "to"]} />
            </div>
          </details>
        </div>
      )}

      {rows.length === 0 ? (
        <Section className="mb-8">
          {all.length > 0 && filteredBy ? (
            <EmptyState
              message="No sales match. Try a different search or clear the filters."
              icon={<Icon name="receipt_long" />}
              action={
                <Link href="/academy/books/sales" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                  Clear filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              message={
                !salesResult.canManage
                  ? "No sales yet. Sales recorded by staff who manage books appear here with their receipts."
                  : books.some((book) => book.status === "active" && book.stockQuantity > 0)
                    ? "No sales yet. Sell a book that is in stock and the sale will appear here."
                    : books.length > 0
                      ? "No sales yet. No active book has copies in stock, so nothing can be sold right now."
                      : "No sales yet. Add a book in Books first, then sell it."
              }
              icon={<Icon name="receipt_long" />}
            />
          )}
        </Section>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((sale) => (
            <article key={sale.id} className={`${CARD} flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4`}>
              <div className="min-w-0 flex-[1_1_230px]">
                <p className="font-bold [overflow-wrap:anywhere]">{sale.bookName}</p>
                <p className="text-xs text-muted">
                  Receipt {sale.id.slice(0, 8).toUpperCase()} · {formatDate(sale.createdAt)}
                </p>
                <p className="text-xs text-muted">
                  {sale.quantity} × {formatMoney(sale.unitPriceCents, sale.currency)}
                  {sale.discountAmountCents > 0 ? `, ${formatMoney(sale.discountAmountCents, sale.currency)} discount` : ""}
                </p>
              </div>
              <div className="min-w-0 flex-[1_1_190px]">
                <p className="text-xs text-muted">Buyer</p>
                <p className="font-semibold [overflow-wrap:anywhere]">{buyerOf(sale)}</p>
                <p className="text-xs text-muted">
                  {sale.buyerType === "student" ? "Student" : `Other person${sale.otherBuyerPhone ? ` · ${sale.otherBuyerPhone}` : ""}`} · Recorded by{" "}
                  {sale.recordedByLabel}
                </p>
              </div>
              <div className="grid min-w-0 flex-[2_1_300px] grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-muted">Total</p>
                  <p className="font-bold tabular-nums">{formatMoney(sale.finalAmountCents, sale.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Paid</p>
                  <p className="font-bold tabular-nums">{formatMoney(sale.netPaidCents, sale.currency)}</p>
                  {sale.totalRefundedCents > 0 && <p className="text-xs text-muted">{formatMoney(sale.totalRefundedCents, sale.currency)} refunded</p>}
                </div>
                <div>
                  <p className="text-xs text-muted">Balance</p>
                  <p className={`font-bold tabular-nums ${sale.remainingCents > 0 ? "text-[#B91C1C]" : "text-[#166534]"}`}>
                    {formatMoney(sale.remainingCents, sale.currency)}
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-[0_1_260px] flex-col items-start gap-2 [&>span:last-child]:justify-start">
                <Badge label={sale.paymentStatus} tone={getStatusTone(sale.paymentStatus)} />
                <SaleActions sale={sale} canManage={salesResult.canManage} />
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="mt-2">
        <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} params={params} />
      </div>
    </>
  );
}
