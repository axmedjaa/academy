import { redirect } from "next/navigation";
import { getBookCoverUrl } from "@/lib/academies/books";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { BooksShell } from "../books-shell";
import { getBooksOverview, getPreorderBranches, getPreorderStudents } from "../books-data";

/**
 * Book Management (design B01-B12): one page with Books and Orders tabs.
 * This layout renders the hero, tabs and section pills once; each section
 * is its own route (`/academy/books`, `/sales`, `/stock`, `/pre-orders`,
 * `/orders`, `/orders/[orderId]`, `/payments`, `/receiving`,
 * `/distribution`, `/reports`), so links, refresh and the back button open
 * the right section while this stays mounted. The `(tabs)` group keeps the
 * sale receipt pages (`/sales/[saleId]/...`) outside it.
 */
export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, salesResult, preordersResult } = overview;
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }

  const preorders = preordersResult.ok ? preordersResult.overview : null;
  const [coverEntries, students, branchOptions] = await Promise.all([
    Promise.all(booksResult.books.filter((book) => book.coverRef).map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const)),
    preorders?.canManage || (salesResult.ok && salesResult.canManage) ? getPreorderStudents() : Promise.resolve([]),
    preorders?.canManage ? getPreorderBranches() : Promise.resolve([]),
  ]);
  const coverUrls = Object.fromEntries(coverEntries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));

  return (
    <div className={PAGE_WRAP}>
      <BooksShell
        books={booksResult.books}
        coverUrls={coverUrls}
        sales={salesResult.ok ? salesResult.sales : null}
        preorders={preorders}
        students={students}
        branches={branchOptions}
        permissions={{
          canManageBooks: booksResult.canManage,
          canSell: salesResult.ok && salesResult.canManage,
          canManage: preorders?.canManage ?? false,
          canManageCampaigns: preorders?.canManageCampaigns ?? false,
        }}
      >
        {children}
      </BooksShell>
    </div>
  );
}
