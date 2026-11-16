"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { ActionButton, useBooksActions } from "./books-actions";

/**
 * Book Management navigation: two main tabs, each with its pages as pills.
 * - Books: Books (catalogue, Add Book, search), Stock and Sell.
 * - Orders: Orders (Create Order for a Student or an Other Buyer, the list
 *   and each order's page), Payments (money received from those buyers) and
 *   Give Books (giving paid books from stock).
 * - Reports: its own tab (orders and Sell totals), also opened from the hero.
 * Every page is its own route, so links, refresh and the back button keep
 * working; the shared layout stays mounted and this reads the URL.
 */

export type BooksSection = "books" | "stock" | "sell" | "orders" | "payments" | "give" | "reports";
type Group = "books" | "orders" | "reports";

export function sectionOf(pathname: string): BooksSection {
  const rest = pathname.replace(/^\/academy\/books/, "");
  if (rest.startsWith("/stock")) return "stock";
  if (rest.startsWith("/sales")) return "sell";
  if (rest.startsWith("/orders")) return "orders";
  if (rest.startsWith("/payments")) return "payments";
  if (rest.startsWith("/reports")) return "reports";
  if (rest.startsWith("/distribution") || rest.startsWith("/pre-orders")) return "give";
  return "books";
}

const GROUP_OF: Record<BooksSection, Group> = {
  books: "books",
  stock: "books",
  sell: "books",
  orders: "orders",
  payments: "orders",
  give: "orders",
  reports: "reports",
};

/** The pages of each main tab, in order. */
export const NAV_PILLS: Record<Group, { key: BooksSection; label: string; href: string }[]> = {
  books: [
    { key: "books", label: "Books", href: "/academy/books" },
    { key: "stock", label: "Stock", href: "/academy/books/stock" },
    { key: "sell", label: "Sell", href: "/academy/books/sales" },
  ],
  orders: [
    { key: "orders", label: "Orders", href: "/academy/books/orders" },
    { key: "payments", label: "Payments", href: "/academy/books/payments" },
    { key: "give", label: "Give Books", href: "/academy/books/distribution" },
  ],
  // Reports is its own main tab with a single page (no pills).
  reports: [],
};

const MAIN_TABS = [
  { key: "books" as const, label: "Books", href: "/academy/books" },
  { key: "orders" as const, label: "Orders", href: "/academy/books/orders" },
  { key: "reports" as const, label: "Reports", href: "/academy/books/reports" },
];

export function groupOf(section: BooksSection): Group {
  return GROUP_OF[section];
}

/**
 * The Books / Orders tabs and the open tab's pages as pills. Rendered by the
 * page and by its loading skeleton, so the two always match. `right` is the
 * page's main action (or its placeholder while loading).
 */
export function BooksNavFrame({ section, right }: { section: BooksSection; right: ReactNode }) {
  const group = GROUP_OF[section];
  return (
    <>
      <nav aria-label="Book Management" className="mb-4 border-b border-border">
        <div className="-mb-px flex gap-2">
          {MAIN_TABS.map((t) => {
            const on = t.key === group;
            // Reports sits on its own at the end of the tab bar.
            const end = t.key === "reports";
            return (
              <Link
                key={t.key}
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`flex h-[52px] items-center gap-2 border-b-[3px] px-[18px] text-base font-semibold !no-underline transition-colors duration-150 hover:!no-underline ${
                  end ? "ml-auto" : ""
                } ${on ? "border-brand !text-brand" : "border-transparent !text-[#4B5563] hover:!text-ink"}`}
              >
                {end && <Icon name="bar_chart" width={18} height={18} />}
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        {NAV_PILLS[group].length > 0 && (
        <div aria-label={group === "books" ? "Books pages" : "Orders pages"} role="navigation" className="flex min-w-0 max-w-full gap-2 overflow-x-auto [scrollbar-width:none]">
          {NAV_PILLS[group].map((p) => {
            const on = p.key === section;
            return (
              <Link
                key={p.key}
                href={p.href}
                aria-current={on ? "page" : undefined}
                className={`flex h-10 shrink-0 items-center whitespace-nowrap rounded-full border px-[15px] text-sm font-semibold !no-underline transition-colors duration-150 hover:!no-underline ${
                  on ? "border-brand bg-brand !text-white" : "border-border-strong bg-surface !text-ink hover:bg-app"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{right}</div>
      </div>
    </>
  );
}

export interface NavPermissions {
  canManageBooks: boolean;
  canSell: boolean;
  canManageOrders: boolean;
  canIssue: boolean;
}

/** The hero banner shows on every section except an order's own page,
 * which gets the compact title instead (design B05). */
export function HeroGate({ hero, compact }: { hero: ReactNode; compact: ReactNode }) {
  const pathname = usePathname();
  const isDetail = /^\/academy\/books\/orders\/(?!new)[^/]+/.test(pathname);
  return <>{isDetail ? compact : hero}</>;
}

/** The hero's main actions (Add Book, Create Order, Give Books). An action
 * the member can't use is omitted, not disabled. */
export function HeroActions({ can }: { can: NavPermissions }) {
  const { open } = useBooksActions();
  const router = useRouter();
  const actions = [
    can.canManageBooks && { key: "add", icon: "book", title: "Add Book", sub: "Add a title and set its price", gold: true, run: () => open({ kind: "addBook" }) },
    can.canManageOrders && { key: "order", icon: "receipt_long", title: "Create Order", sub: "Books for a student or another buyer", gold: false, run: () => open({ kind: "order" }) },
    can.canIssue && { key: "give", icon: "group", title: "Give Books", sub: "Give books that are paid and in stock", gold: false, run: () => router.push("/academy/books/distribution") },
    { key: "reports", icon: "bar_chart", title: "Reports", sub: "Orders and sales totals", gold: false, run: () => router.push("/academy/books/reports") },
  ].filter((a): a is { key: string; icon: string; title: string; sub: string; gold: boolean; run: () => void } => Boolean(a));
  if (!actions.length) return null;
  return (
    <div className={`relative mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3.5 ${actions.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={a.run}
          className={`flex min-h-[74px] min-w-0 items-center gap-3.5 rounded-[14px] px-4 py-3.5 text-left transition-colors duration-150 ${
            a.gold
              ? "border-0 bg-[#F5B638] text-ink shadow-[0_2px_10px_rgba(0,0,0,0.18)] hover:bg-[#FFC65A]"
              : "border border-white/25 bg-white/[0.08] text-white hover:bg-white/[0.16]"
          }`}
        >
          <span
            aria-hidden="true"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] ${a.gold ? "bg-black/[0.08] text-ink" : "bg-white/[0.14] text-white"}`}
          >
            <Icon name={a.icon} width={22} height={22} />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-bold leading-tight">{a.title}</span>
            <span className={`mt-0.5 block text-[13px] leading-snug ${a.gold ? "text-[#3F2A00]" : "text-white/85"}`}>{a.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function BooksSectionNav({ can }: { can: NavPermissions }) {
  const pathname = usePathname();
  const section = sectionOf(pathname);

  const actions: Partial<Record<BooksSection, ReactNode>> = {
    books: can.canManageBooks ? <ActionButton dialog={{ kind: "addBook" }}>Add Book</ActionButton> : null,
    sell: can.canSell ? <ActionButton dialog={{ kind: "sell" }}>Sell Book</ActionButton> : null,
    orders: can.canManageOrders ? <ActionButton dialog={{ kind: "order" }}>Create Order</ActionButton> : null,
    payments: can.canManageOrders ? <ActionButton dialog={{ kind: "pay" }}>Record payment</ActionButton> : null,
  };

  return (
    <BooksNavFrame
      section={section}
      right={
        <>
          {actions[section]}
        </>
      }
    />
  );
}
