import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBookCoverUrl, listBooks } from "@/lib/academies/books";
import { getRecentSaleCountsByBook } from "@/lib/academies/book-sales";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { StockManager } from "./stock-manager";

/**
 * Dedicated Stock view — a read-focused inventory page separate from the
 * Books catalogue (which is about creating/editing/selling), per the Books
 * design report's own "Stock" nav item requirement. Reuses `listBooks`
 * (same data as /academy/books) rather than a parallel query — this page
 * only adds stock-status bucketing and a recent-sales count on top.
 */
export default async function AcademyBooksStockPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const booksResult = await listBooks(context);
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }

  const coverUrls = Object.fromEntries(
    await Promise.all(
      booksResult.books
        .filter((book) => book.coverRef)
        .map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const),
    ),
  );

  const recentSalesResult = await getRecentSaleCountsByBook(
    context,
    booksResult.books.map((book) => book.id),
  );
  const recentSaleCounts = recentSalesResult.ok
    ? Object.fromEntries(recentSalesResult.counts)
    : {};

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Stock"
        description="Inventory levels across the book catalogue — covers, quantities, prices, and recent sales activity."
      />
      <StockManager books={booksResult.books} coverUrls={coverUrls} recentSaleCounts={recentSaleCounts} />
    </div>
  );
}
