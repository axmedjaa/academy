"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { ActionButton, useBooksActions } from "./books-actions";

/**
 * Book Management navigation (design B01-B13, revised 2026-11-07): two main
 * tabs, Books (catalogue, stock and direct sales) and Orders (pre-order
 * campaigns, student orders, payments, receiving and giving books), each
 * with its sections as pills, plus the Reports link and the open section's
 * main action. Every section is its own route under /academy/books, so
 * links, refresh and the back button keep working; the shared layout stays
 * mounted and this reads the open section from the URL.
 */

export type BooksSection = "books" | "stock" | "sell" | "campaigns" | "orders" | "payments" | "receive" | "give" | "reports";

export function sectionOf(pathname: string): BooksSection {
  const rest = pathname.replace(/^\/academy\/books/, "");
  if (rest.startsWith("/stock")) return "stock";
  if (rest.startsWith("/sales")) return "sell";
  if (rest.startsWith("/pre-orders")) return "campaigns";
  if (rest.startsWith("/orders")) return "orders";
  if (rest.startsWith("/payments")) return "payments";
  if (rest.startsWith("/receiving")) return "receive";
  if (rest.startsWith("/distribution")) return "give";
  if (rest.startsWith("/reports")) return "reports";
  return "books";
}

/** Which main tab a section belongs to. Reports covers the pre-order flow. */
const GROUP_OF: Record<BooksSection, "books" | "orders"> = {
  books: "books",
  stock: "books",
  sell: "books",
  campaigns: "orders",
  orders: "orders",
  payments: "orders",
  receive: "orders",
  give: "orders",
  reports: "orders",
};

/** The sections of each main tab, in order (labels and routes). */
export const NAV_PILLS: Record<"books" | "orders", { key: BooksSection; label: string; href: string }[]> = {
  books: [
    { key: "books", label: "Books", href: "/academy/books" },
    { key: "stock", label: "Stock", href: "/academy/books/stock" },
    { key: "sell", label: "Sell", href: "/academy/books/sales" },
  ],
  orders: [
    { key: "campaigns", label: "Pre-Orders", href: "/academy/books/pre-orders" },
    { key: "orders", label: "Orders", href: "/academy/books/orders" },
    { key: "payments", label: "Payments", href: "/academy/books/payments" },
    { key: "receive", label: "Receive", href: "/academy/books/receiving" },
    { key: "give", label: "Give", href: "/academy/books/distribution" },
  ],
};

const MAIN_TABS = [
  { key: "books" as const, label: "Books", href: "/academy/books" },
  { key: "orders" as const, label: "Orders", href: "/academy/books/orders" },
];

export function groupOf(section: BooksSection): "books" | "orders" {
  return GROUP_OF[section];
}

/**
 * The Books / Orders tabs and the open tab's section pills: the real labels
 * and active state. Rendered by the page and by its loading skeleton, so
 * the two always match. `right` is Reports and the section action (or their
 * placeholders while loading).
 */
export function BooksNavFrame({ section, right }: { section: BooksSection; right: ReactNode }) {
  const group = GROUP_OF[section];
  return (
    <>
      <nav aria-label="Book Management" className="mb-4 border-b border-border">
        <div className="-mb-px flex gap-2">
          {MAIN_TABS.map((t) => {
            const on = t.key === group;
            return (
              <Link
                key={t.key}
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`flex h-[52px] items-center border-b-[3px] px-[18px] text-base font-semibold !no-underline transition-colors duration-150 hover:!no-underline ${
                  on ? "border-brand !text-brand" : "border-transparent !text-[#4B5563] hover:!text-ink"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div aria-label={group === "books" ? "Books sections" : "Orders sections"} role="navigation" className="flex min-w-0 max-w-full gap-2 overflow-x-auto [scrollbar-width:none]">
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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{right}</div>
      </div>
    </>
  );
}

export interface NavPermissions {
  canManageBooks: boolean;
  canSell: boolean;
  canManage: boolean;
  canManageCampaigns: boolean;
}

/** The hero banner shows on every section except an order's own page,
 * which gets the compact title instead (design B05). */
export function HeroGate({ hero, compact }: { hero: ReactNode; compact: ReactNode }) {
  const pathname = usePathname();
  const isDetail = /^\/academy\/books\/orders\/[^/]+/.test(pathname);
  return <>{isDetail ? compact : hero}</>;
}

/** The hero's three main actions (design: Add Book in gold, Sell Book and
 * Pre-Order). An action the member can't use is omitted, not disabled. */
export function HeroActions({ can }: { can: NavPermissions }) {
  const { open } = useBooksActions();
  const actions = [
    can.canManageBooks && { key: "add", icon: "book", title: "Add Book", sub: "Add a title and set its price", gold: true, run: () => open({ kind: "addBook" }) },
    can.canSell && { key: "sell", icon: "payments", title: "Sell Book", sub: "Sell a copy that is in stock", gold: false, run: () => open({ kind: "sell" }) },
    can.canManageCampaigns && { key: "pre", icon: "autorenew", title: "Pre-Order", sub: "Open books for ordering", gold: false, run: () => open({ kind: "campaign" }) },
  ].filter((a): a is { key: string; icon: string; title: string; sub: string; gold: boolean; run: () => void } => Boolean(a));
  if (!actions.length) return null;
  return (
    <div className="relative mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-3.5">
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
    campaigns: can.canManageCampaigns ? <ActionButton dialog={{ kind: "campaign" }}>Create Pre-Order Campaign</ActionButton> : null,
    orders: can.canManage ? <ActionButton dialog={{ kind: "order" }}>Create Order</ActionButton> : null,
    payments: can.canManage ? <ActionButton dialog={{ kind: "pay" }}>Record Payment</ActionButton> : null,
    receive: can.canManageCampaigns ? <ActionButton dialog={{ kind: "receive" }}>Receive Books</ActionButton> : null,
  };

  return (
    <BooksNavFrame
      section={section}
      right={
        <>
          <Link
            href="/academy/books/reports"
            aria-current={section === "reports" ? "page" : undefined}
            className={`flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 font-semibold !text-brand !no-underline hover:bg-brand-tint hover:!no-underline ${section === "reports" ? "bg-brand-tint" : ""}`}
          >
            <Icon name="bar_chart" width={18} height={18} />
            Reports
          </Link>
          {actions[section]}
        </>
      }
    />
  );
}
