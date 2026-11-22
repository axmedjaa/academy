import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookCoverUrl, type BookRecord } from "@/lib/academies/books";
import { getRecentSaleCountsByBook } from "@/lib/academies/book-sales";
import { LOW_STOCK_THRESHOLD, getStockStatus } from "@/lib/academies/book-stock";
import { formatMoney } from "@/lib/ui/money";
import { EmptyState, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, ROW_BTN, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { getBooksOverview } from "../../books-data";
import { StockAdjustButton, StockBadge } from "../../books-client";
import { sumByCurrency } from "../../books-view";

const PAGE_SIZE = 10;

/** A title's level as the Stock tab shows it: inactive titles are their own group. */
type Level = "in_stock" | "low_stock" | "out_of_stock" | "inactive";
const levelOf = (book: Pick<BookRecord, "status" | "stockQuantity">): Level =>
  book.status !== "active" ? "inactive" : getStockStatus(book.stockQuantity);

const LEVELS: { value: Level; label: string; bar: string; dot: string; empty: string }[] = [
  { value: "out_of_stock", label: "Out of stock", bar: "bg-danger", dot: "bg-danger", empty: "out of stock" },
  { value: "low_stock", label: "Low stock", bar: "bg-warning", dot: "bg-warning", empty: "low on stock" },
  { value: "in_stock", label: "In stock", bar: "bg-success", dot: "bg-success", empty: "in stock" },
  { value: "inactive", label: "Inactive", bar: "bg-border-strong", dot: "bg-border-strong", empty: "inactive" },
];

const SORTS = [
  { value: "", label: "Lowest stock first" },
  { value: "most", label: "Most stock first" },
  { value: "sold", label: "Best selling (30 days)" },
  { value: "name", label: "Title A–Z" },
] as const;

/** The stock number's colour follows its level; the level badge beside it
 * always carries the words, so colour is never the only signal. */
const COUNT_TONE: Record<Level, string> = {
  out_of_stock: "text-danger",
  low_stock: "text-warning",
  in_stock: "text-ink",
  inactive: "text-muted",
};

/**
 * Books stock (design A16, Stock tab). A stock overview first: copies on the
 * shelf, what they are worth at the selling price, and one bar splitting the
 * titles by level, whose legend is also the level filter. Then search, sort
 * and a paged table: copies in stock with their level, copies sold in the
 * last 30 days, price, and the stock actions. Staff who manage books adjust
 * stock with a reason (Add / Remove); sales and books given from orders lower
 * it, copies returned on a refund raise it. History lists every movement.
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
  const level = LEVELS.some((l) => l.value === get("level")) ? (get("level") as Level) : "";
  const sort = SORTS.some((s) => s.value === get("sort")) ? get("sort") : "";

  const all = booksResult.books;
  const recent = await getRecentSaleCountsByBook(context, all.map((book) => book.id));
  const soldOf = (id: string) => (recent.ok ? (recent.counts.get(id) ?? 0) : 0);

  // Overview figures cover the whole catalogue, never just the filtered page.
  const counts = Object.fromEntries(LEVELS.map((l) => [l.value, 0])) as Record<Level, number>;
  for (const book of all) counts[levelOf(book)] += 1;
  const activeBooks = all.filter((book) => book.status === "active");
  const copies = activeBooks.reduce((n, book) => n + book.stockQuantity, 0);
  const shelfValue = sumByCurrency(activeBooks.map((book) => ({ cents: book.priceCents * book.stockQuantity, currency: book.currency })));
  const needRestock = counts.out_of_stock + counts.low_stock;

  const filtered = all
    .filter((book) => !q || [book.name, book.isbn ?? "", book.author ?? ""].some((field) => field.toLowerCase().includes(q)))
    .filter((book) => !level || levelOf(book) === level)
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "most") return b.stockQuantity - a.stockQuantity || a.name.localeCompare(b.name);
      if (sort === "sold") return soldOf(b.id) - soldOf(a.id) || a.stockQuantity - b.stockQuantity;
      // Default: what needs attention first (inactive titles last).
      const rank = (book: BookRecord) => (book.status === "active" ? 0 : 1);
      return rank(a) - rank(b) || a.stockQuantity - b.stockQuantity || a.name.localeCompare(b.name);
    });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) ? Math.min(Math.max(pageParam, 1), pageCount) : 1;
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Covers are signed per request: only for the rows on this page.
  const coverUrls = Object.fromEntries(
    await Promise.all(rows.filter((book) => book.coverRef).map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const)),
  );

  /** A level filter link that keeps the search and sort and starts at page 1. */
  const levelHref = (value: Level | "") => {
    const next = new URLSearchParams();
    if (q) next.set("q", get("q"));
    if (sort) next.set("sort", sort);
    if (value) next.set("level", value);
    const query = next.toString();
    return query ? `/academy/books/stock?${query}` : "/academy/books/stock";
  };

  if (all.length === 0) {
    return (
      <Section className="mb-8">
        <EmptyState
          message="No stock to show yet. Stock appears once a title is in the catalogue. Add copies that arrive with Add, and record damaged or lost copies with Remove."
          icon={<Icon name="layers" />}
          action={
            <Link href="/academy/books" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
              Go to Books
            </Link>
          }
        />
      </Section>
    );
  }

  return (
    <>
      <section aria-labelledby="stock-overview" className="mb-6 rounded-card border border-border bg-surface p-4 shadow-card sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h2 id="stock-overview" className="text-lg font-bold leading-tight text-ink">
            <span className="tabular-nums">{copies.toLocaleString("en-US")}</span> {copies === 1 ? "copy" : "copies"} on the shelf
          </h2>
          <p className="text-sm text-muted">
            {activeBooks.length} active {activeBooks.length === 1 ? "title" : "titles"} · worth{" "}
            <span className="font-semibold text-ink tabular-nums">{shelfValue}</span> at selling price
          </p>
        </div>

        {/* One bar, every title: the share at each level. */}
        <div className="mt-4 flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-app" aria-hidden="true">
          {LEVELS.filter((l) => counts[l.value] > 0).map((l) => (
            <span key={l.value} className={`h-full min-w-1.5 basis-0 ${l.bar}`} style={{ flexGrow: counts[l.value] }} />
          ))}
        </div>

        <nav aria-label="Filter by stock level" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[{ value: "" as const, label: "All titles", dot: "bg-brand", count: all.length }, ...LEVELS.map((l) => ({ ...l, count: counts[l.value] }))].map((item) => {
            const on = level === item.value;
            return (
              <Link
                key={item.value || "all"}
                href={levelHref(item.value)}
                aria-current={on ? "true" : undefined}
                scroll={false}
                className={`group flex min-h-14 items-center gap-2.5 rounded-lg border px-3 py-2 no-underline transition-[background-color,border-color,box-shadow] duration-150 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  on ? "border-brand bg-brand-tint shadow-[0_1px_2px_rgba(133,0,25,0.12)]" : "border-border bg-surface hover:border-border-strong hover:bg-app"
                }`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.dot}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className={`block text-lg font-bold leading-none tabular-nums ${on ? "text-brand" : "text-ink"}`}>{item.count}</span>
                  <span className={`mt-1 block truncate text-xs font-semibold ${on ? "text-brand" : "text-muted"}`}>{item.label}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        {needRestock > 0 && (
          <p className="mt-4 flex items-start gap-2 text-sm text-[#78350F]">
            <Icon name="warning" width={16} height={16} className="mt-0.5 shrink-0" />
            <span>
              {needRestock} {needRestock === 1 ? "title needs" : "titles need"} restocking: {counts.out_of_stock} out of stock, {counts.low_stock} with{" "}
              {LOW_STOCK_THRESHOLD} copies or fewer.
            </span>
          </p>
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchField placeholder="Search title, author or ISBN" />
        <FilterSelect param="sort" label="Sort titles" options={[...SORTS]} />
        <ClearFilters params={["q", "level", "sort"]} compact />
        <p className="ml-auto text-sm text-muted" aria-live="polite">
          {filtered.length === all.length
            ? `${all.length} ${all.length === 1 ? "title" : "titles"}`
            : `${filtered.length} of ${all.length} titles`}
        </p>
      </div>

      {filtered.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message={
              level
                ? `No title is ${LEVELS.find((l) => l.value === level)?.empty ?? "at that level"}${q ? " and matches that search" : ""}.`
                : "No title matches that search."
            }
            icon={<Icon name="layers" />}
            action={
              <Link href="/academy/books/stock" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                Clear filters
              </Link>
            }
          />
        </Section>
      ) : (
        <DataTable
          stackBelow={760}
          footer={<PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={filtered.length} searchParams={params} />}
        >
          <thead>
            <tr>
              <th className={rtTh}>Book</th>
              <th className={rtTh}>In stock</th>
              <th className={`${rtTh} text-right`}>Sold (30 days)</th>
              <th className={`${rtTh} text-right`}>Price</th>
              <th className={`${rtTh} text-right`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((book) => {
              const bookLevel = levelOf(book);
              const sold = soldOf(book.id);
              return (
                <tr key={book.id} className={trHover}>
                  <td className={rtTd} data-label="Book">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-brand-tint to-[#E9C3CC] text-xs font-bold text-brand shadow-[0_1px_2px_rgba(15,23,42,0.12)]">
                        {coverUrls[book.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
                          <img src={coverUrls[book.id]!} alt="" className="h-full w-full object-cover" />
                        ) : (
                          book.name.slice(0, 2).toUpperCase()
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-semibold [overflow-wrap:anywhere]">{book.name}</span>
                        {(book.author || book.isbn) && (
                          <span className="block text-xs text-muted [overflow-wrap:anywhere]">
                            {[book.author, book.isbn ? `ISBN ${book.isbn}` : null].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className={rtTd} data-label="In stock">
                    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={`text-xl font-bold leading-none tabular-nums ${COUNT_TONE[bookLevel]}`}>
                        {book.stockQuantity}
                        <span className="sr-only"> {book.stockQuantity === 1 ? "copy" : "copies"}</span>
                      </span>
                      <StockBadge quantity={book.stockQuantity} inactive={book.status !== "active"} />
                    </span>
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Sold (30 days)">
                    {sold > 0 ? <span className="font-semibold">{sold}</span> : <span className="text-muted">0</span>}
                  </td>
                  <td className={`${rtTd} text-right tabular-nums`} data-label="Price">
                    {formatMoney(book.priceCents, book.currency)}
                  </td>
                  <td className={`${rtTd} text-right`} data-actions="">
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      {booksResult.canManage && (
                        <>
                          <StockAdjustButton direction="in" book={{ id: book.id, name: book.name, stockQuantity: book.stockQuantity }} />
                          <StockAdjustButton direction="out" book={{ id: book.id, name: book.name, stockQuantity: book.stockQuantity }} />
                        </>
                      )}
                      <Link href={`/academy/books/stock/${book.id}`} className={ROW_BTN} aria-label={`Stock history of ${book.name}`}>
                        <Icon name="history" width={16} height={16} />
                        History
                      </Link>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Low stock means {LOW_STOCK_THRESHOLD} copies or fewer. Shelf value counts active titles at their selling price. Sold counts copies sold in
        the last 30 days.
      </NoteBlock>
    </>
  );
}
