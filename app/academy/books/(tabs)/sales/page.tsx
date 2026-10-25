import Link from "next/link";
import { redirect } from "next/navigation";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";
import { getStatusTone } from "@/lib/ui/status";
import { Badge, EmptyState, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChipParamFilter, ClearFilters, DateParamField, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { getBooksOverview } from "../../books-data";
import { SaleActions } from "../../books-client";

const PAGE_SIZE = 15;

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
      {all.length > 0 && (
        <>
        <div className="mb-4">
          <ChipParamFilter
            param="status"
            label="Filter by payment"
            options={[
              { value: "", label: "All" },
              { value: "owing", label: "Balance due" },
              { value: "paid", label: "Paid" },
            ]}
          />
        </div>
        <FilterBar>
          <SearchField placeholder="Search receipt, buyer or book" />
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
        </FilterBar>
        </>
      )}

      {rows.length === 0 ? (
        <Section className="mb-8">
          {all.length > 0 && filteredBy ? (
            <EmptyState
              message="No sale matches these filters."
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
                  ? "No book sales yet. Sales recorded by staff who manage books appear here with their receipts."
                  : books.some((book) => book.status === "active" && book.stockQuantity > 0)
                    ? "No book sales yet. Use Sell on a book in the Catalogue; each sale and payment gets its own receipt."
                    : books.length > 0
                      ? "No book sales yet. No active book has copies in stock, so nothing can be sold right now."
                      : "No book sales yet. Add a book in the Catalogue first, then sell it from its card."
              }
              icon={<Icon name="receipt_long" />}
              action={
                salesResult.canManage ? (
                  <Link href="/academy/books" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                    Go to Catalogue
                  </Link>
                ) : undefined
              }
            />
          )}
        </Section>
      ) : (
        <DataTable
          stackBelow={900}
          footer={<PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={filtered.length} searchParams={params} />}
        >
          <thead>
            <tr>
              <th className={rtTh}>Sale</th>
              <th className={rtTh}>Buyer</th>
              <th className={`${rtTh} text-right`}>Total</th>
              <th className={`${rtTh} text-right`}>Paid (net)</th>
              <th className={`${rtTh} text-right`}>Balance</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((sale) => (
              <tr key={sale.id} className={trHover}>
                <td className={rtTd} data-label="Sale">
                  <span className="block font-semibold [overflow-wrap:anywhere]">
                    {sale.bookName} × {sale.quantity}
                  </span>
                  <span className="block text-xs text-muted">
                    {formatDate(sale.createdAt)} · {sale.id.slice(0, 8).toUpperCase()}
                  </span>
                </td>
                <td className={rtTd} data-label="Buyer">
                  <span className="block">{buyerOf(sale)}</span>
                  <span className="block text-xs text-muted">
                    {sale.buyerType === "student" ? "Student" : "Other person"} · Recorded by {sale.recordedByLabel}
                  </span>
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Total">
                  {formatMoney(sale.finalAmountCents, sale.currency)}
                  {sale.discountAmountCents > 0 && (
                    <span className="block text-xs text-muted">−{formatMoney(sale.discountAmountCents, sale.currency)} discount</span>
                  )}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Paid (net)">
                  {formatMoney(sale.netPaidCents, sale.currency)}
                  {sale.totalRefundedCents > 0 && (
                    <span className="block text-xs text-muted">{formatMoney(sale.totalRefundedCents, sale.currency)} refunded</span>
                  )}
                </td>
                <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="Balance">
                  {formatMoney(sale.remainingCents, sale.currency)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={sale.paymentStatus} tone={getStatusTone(sale.paymentStatus)} />
                </td>
                <td className={`${rtTd} text-right`} data-actions="">
                  <SaleActions sale={sale} canManage={salesResult.canManage} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Paid is net of refunds. Refunds need a reason; money and returned copies are independent, and returned copies go back
        into stock. Each sale and each follow-up payment has its own receipt.
      </NoteBlock>
    </>
  );
}
