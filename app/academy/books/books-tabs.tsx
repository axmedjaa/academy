"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Books, Stock and Book sales as tabs of one section (Screen Inventory A16;
 * the sidebar carries a single "Books" entry per the design). All three
 * routes share the same `academy.books` permission row, so any user who
 * reaches one of these pages can open the other two.
 */
const TABS = [
  { href: "/academy/books", label: "Catalogue" },
  { href: "/academy/books/stock", label: "Stock" },
  { href: "/academy/books/sales", label: "Sales" },
];

export function BooksTabs() {
  const pathname = usePathname();
  const active =
    [...TABS].sort((a, b) => b.href.length - a.href.length).find((tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`))?.href ?? TABS[0].href;
  return (
    <nav aria-label="Books sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {TABS.map((tab) => {
        const current = tab.href === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm no-underline transition-colors duration-150 hover:no-underline ${
              current ? "border-brand font-semibold !text-brand" : "border-transparent font-medium !text-muted hover:!text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
