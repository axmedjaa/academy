import { redirect } from "next/navigation";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { BooksShell } from "../books-shell";
import { getBooksOverview } from "../books-data";

/**
 * Books (design A16): one page with Catalogue, Stock and Sales tabs. This
 * layout renders the shared header, summary cards and tab bar once; each
 * tab is its own route (`/academy/books`, `/stock`, `/sales`), so links,
 * refresh and the back button open the right tab, and switching tabs only
 * swaps the content below while this stays mounted. The `(tabs)` group
 * keeps the sale receipt pages (`/sales/[saleId]/...`) outside it.
 */
export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, salesResult } = overview;
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }

  return (
    <div className={PAGE_WRAP}>
      <BooksShell books={booksResult.books} sales={salesResult.ok ? salesResult.sales : null} canManage={booksResult.canManage}>
        {children}
      </BooksShell>
    </div>
  );
}
