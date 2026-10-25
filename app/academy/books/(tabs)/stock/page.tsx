import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookCoverUrl } from "@/lib/academies/books";
import { getRecentSaleCountsByBook } from "@/lib/academies/book-sales";
import { getStockStatus } from "@/lib/academies/book-stock";
import { formatMoney } from "@/lib/ui/money";
import { EmptyState, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChipParamFilter, FilterBar, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { getBooksOverview } from "../../books-data";
import { StockBadge } from "../../books-client";

const LEVEL_LABEL: Record<string, string> = { in_stock: "in stock", low_stock: "low on stock", out_of_stock: "out of stock" };

/**
 * Books stock (design A16, Stock tab): a read-only inventory table — copies
 * in stock, copies sold in the last 30 days, and the stock level — with
 * search and a level filter. Stock only changes through sales and refunds.
 */
export default async function AcademyBooksStockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Same cached read as the Books layout above (one query per request).
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { context, booksResult } = overview;
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }
  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const q = get("q").toLowerCase();
  const level = get("level");

  const books = [...booksResult.books]
    .filter((book) => !q || [book.name, book.isbn ?? "", book.author ?? ""].some((field) => field.toLowerCase().includes(q)))
    .filter((book) => !level || getStockStatus(book.stockQuantity) === level)
    .sort((a, b) => a.stockQuantity - b.stockQuantity || a.name.localeCompare(b.name));

  const [recent, coverEntries] = await Promise.all([
    getRecentSaleCountsByBook(context, booksResult.books.map((book) => book.id)),
    Promise.all(books.filter((book) => book.coverRef).map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const)),
  ]);
  const recentCounts = recent.ok ? recent.counts : new Map<string, number>();
  const coverUrls = Object.fromEntries(coverEntries);

  return (
    <>
      {booksResult.books.length > 0 && (
        <>
        <div className="mb-4">
          <ChipParamFilter
            param="level"
            label="Filter by stock level"
            options={[
              { value: "", label: "All" },
              { value: "in_stock", label: "In stock" },
              { value: "low_stock", label: "Low stock" },
              { value: "out_of_stock", label: "Out of stock" },
            ]}
          />
        </div>
        <FilterBar>
          <SearchField placeholder="Search books" />
        </FilterBar>
        </>
      )}

      {books.length === 0 ? (
        <Section className="mb-8">
          {booksResult.books.length > 0 ? (
            <EmptyState
              message={level ? `No book is ${LEVEL_LABEL[level] ?? "at that level"}${q ? " and matches that search" : ""}.` : "No book matches that search."}
              icon={<Icon name="layers" />}
              action={
                <Link href="/academy/books/stock" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                  Clear filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              message="No stock to show yet. Stock appears once a title is in the catalogue, and changes only through sales and refunds."
              icon={<Icon name="layers" />}
              action={
                <Link href="/academy/books" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                  Go to Catalogue
                </Link>
              }
            />
          )}
        </Section>
      ) : (
        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Book</th>
              <th className={`${rtTh} text-right`}>Price</th>
              <th className={`${rtTh} text-right`}>In stock</th>
              <th className={`${rtTh} text-right`}>Sales (30 days)</th>
              <th className={rtTh}>Level</th>
            </tr>
          </thead>
          <tbody>
            {books.map((book) => (
              <tr key={book.id} className={trHover}>
                <td className={rtTd} data-label="Book">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-brand-tint to-[#E9C3CC] text-xs font-bold text-brand">
                      {coverUrls[book.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
                        <img src={coverUrls[book.id]!} alt="" className="h-full w-full object-cover" />
                      ) : (
                        book.name.slice(0, 2).toUpperCase()
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold [overflow-wrap:anywhere]">{book.name}</span>
                      {book.author && <span className="block text-xs text-muted">{book.author}</span>}
                    </span>
                  </span>
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Price">
                  {formatMoney(book.priceCents, book.currency)}
                </td>
                <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="In stock">
                  {book.stockQuantity}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Sales (30 days)">
                  {recentCounts.get(book.id) ?? 0}
                </td>
                <td className={rtTd} data-label="Level">
                  <StockBadge quantity={book.stockQuantity} inactive={book.status !== "active"} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>Low stock means 5 copies or fewer. The threshold is a fixed value, not a setting.</NoteBlock>
    </>
  );
}
