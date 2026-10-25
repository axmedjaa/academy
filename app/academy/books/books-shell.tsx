import type { ReactNode } from "react";
import type { BookRecord } from "@/lib/academies/books";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { getStockStatus } from "@/lib/academies/book-stock";
import { formatMoney } from "@/lib/ui/money";
import { PageHeader } from "@/app/academy/_shell/ui";
import { StatBento } from "@/app/academy/_shell/page-blocks";
import { BooksHeaderAction, BooksTabBar } from "./books-tabs";

/**
 * Books header (design A16): title, the open tab's action, the stock and
 * sales summary bento, and Catalogue / Stock / Sales tabs. Rendered once by
 * the shared Books layout, so it stays in place while the tabs switch; the
 * open tab is read from the URL by the client tab bar. All three tabs share
 * the `academy.books` permission row.
 */
export function BooksShell({
  books,
  sales,
  canManage,
  children,
}: {
  books: BookRecord[];
  sales: BookSaleListRow[] | null;
  canManage: boolean;
  children: ReactNode;
}) {
  const active = books.filter((book) => book.status === "active").length;
  const copies = books.reduce((sum, book) => sum + book.stockQuantity, 0);
  const low = books.filter((book) => getStockStatus(book.stockQuantity) !== "in_stock").length;
  const owing = (sales ?? []).filter((sale) => sale.remainingCents > 0);
  const owedByCurrency = new Map<string, number>();
  for (const sale of owing) owedByCurrency.set(sale.currency, (owedByCurrency.get(sale.currency) ?? 0) + sale.remainingCents);
  const owedLine = owedByCurrency.size
    ? [...owedByCurrency].map(([currency, cents]) => formatMoney(cents, currency)).join(" + ")
    : formatMoney(0, books[0]?.currency ?? "USD");

  return (
    <>
      <PageHeader title="Books" description="Catalogue, stock and sales in one place." actions={<BooksHeaderAction canManage={canManage} />} />
      <StatBento
        hero={{
          label: "Titles in the catalogue",
          value: books.length,
          hint: `${active} active, ${books.length - active} inactive`,
          icon: "menu_book",
        }}
        side={[
          { label: "Copies in stock", value: copies, hint: "across all titles", icon: "layers" },
          { label: "Low or out of stock", value: low, hint: "5 copies or fewer", icon: "warning", tone: "gold" },
          ...(sales
            ? [
                {
                  label: "Unpaid sale balances",
                  value: owedLine,
                  hint: `${owing.length} sale${owing.length === 1 ? "" : "s"}`,
                  icon: "payments",
                  tone: "slate" as const,
                  href: "/academy/books/sales?status=owing",
                },
              ]
            : []),
        ]}
      />
      <BooksTabBar />
      {children}
    </>
  );
}
