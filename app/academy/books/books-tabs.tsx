"use client";

import { usePathname } from "next/navigation";
import { TabLinks } from "@/app/academy/_shell/page-blocks";
import { AddBookButton } from "./books-client";

type BooksTab = "catalogue" | "stock" | "sales";

/** The open tab, from the URL (the shared layout doesn't re-render on navigation). */
function useBooksTab(): BooksTab {
  const pathname = usePathname();
  if (pathname.startsWith("/academy/books/stock")) return "stock";
  if (pathname.startsWith("/academy/books/sales")) return "sales";
  return "catalogue";
}

/** Catalogue / Stock / Sales: links to the tab routes, so the URL, refresh and
 * the back button keep working while the shared header stays mounted. */
export function BooksTabBar() {
  const current = useBooksTab();
  return (
    <TabLinks
      label="Books sections"
      current={current}
      tabs={[
        { key: "catalogue", label: "Catalogue", href: "/academy/books" },
        { key: "stock", label: "Stock", href: "/academy/books/stock" },
        { key: "sales", label: "Sales", href: "/academy/books/sales" },
      ]}
    />
  );
}

/** The header action of the open tab: Add book on the Catalogue (design A16). */
export function BooksHeaderAction({ canManage }: { canManage: boolean }) {
  const current = useBooksTab();
  return canManage && current === "catalogue" ? <AddBookButton /> : null;
}
