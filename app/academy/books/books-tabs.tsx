"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { ActionButton } from "./books-actions";

/**
 * Book Management navigation (design B01-B09): the four-step roadmap
 * (Books, Pre-Orders, Orders and Payments, Receive and Give Books), the
 * open step's section tabs, the Reports link and the open section's main
 * action. Every section is its own route under /academy/books, so links,
 * refresh and the back button keep working; the shared layout stays
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

const STAGE_OF: Record<BooksSection, number> = { books: 1, stock: 1, sell: 1, campaigns: 2, orders: 3, payments: 3, receive: 4, give: 4, reports: 0 };

export interface StageCounts {
  activeBooks: number;
  copiesInStock: number;
  openCampaigns: number;
  orders: number;
  payments: number;
  toVerify: number;
  toReceive: number;
  toGive: number;
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

export function BooksStageNav({ counts, can }: { counts: StageCounts; can: NavPermissions }) {
  const pathname = usePathname();
  const section = sectionOf(pathname);
  const stage = STAGE_OF[section];

  const stages = [
    { n: 1, title: "Books", verb: "Add books and sell what is in stock", q: "What books does the academy have?", href: "/academy/books", count: counts.activeBooks },
    { n: 2, title: "Pre-Orders", verb: "Open books for ordering", q: "What can be ordered right now?", href: "/academy/books/pre-orders", count: counts.openCampaigns },
    { n: 3, title: "Orders and Payments", verb: "Take orders, record payments", q: "Who ordered and who has paid?", href: "/academy/books/orders", count: counts.orders },
    { n: 4, title: "Receive and Give Books", verb: "Receive books, give them to students", q: "Which books arrived and were given to students?", href: "/academy/books/receiving", count: counts.toGive },
  ];
  const fill = `${Math.round((Math.max(0, stage - 1) / 3) * 100)}%`;

  type Tab = { key: BooksSection; label: string; href: string; count: string; warn?: boolean; action?: ReactNode };
  const tabs: Tab[] =
    stage === 1
      ? [
          {
            key: "books",
            label: "Books",
            href: "/academy/books",
            count: String(counts.activeBooks),
            action: can.canManageBooks ? <ActionButton dialog={{ kind: "addBook" }}>Add Book</ActionButton> : null,
          },
          {
            key: "stock",
            label: "Stock",
            href: "/academy/books/stock",
            count: `${counts.copiesInStock} copies`,
          },
          {
            key: "sell",
            label: "Sell Book",
            href: "/academy/books/sales",
            count: `${counts.copiesInStock} in stock`,
            action: can.canSell ? <ActionButton dialog={{ kind: "sell" }}>Sell Book</ActionButton> : null,
          },
        ]
      : stage === 3
        ? [
            {
              key: "orders",
              label: "Student Orders",
              href: "/academy/books/orders",
              count: String(counts.orders),
              action: can.canManage ? <ActionButton dialog={{ kind: "order" }}>Create Order</ActionButton> : null,
            },
            {
              key: "payments",
              label: "Payments",
              href: "/academy/books/payments",
              count: counts.toVerify ? `${counts.toVerify} to verify` : String(counts.payments),
              warn: counts.toVerify > 0,
              action: can.canManage ? <ActionButton dialog={{ kind: "pay" }}>Record Payment</ActionButton> : null,
            },
          ]
        : stage === 4
          ? [
              {
                key: "receive",
                label: "Receive Books",
                href: "/academy/books/receiving",
                count: `${counts.toReceive} to receive`,
                action: can.canManageCampaigns ? <ActionButton dialog={{ kind: "receive" }}>Receive Books</ActionButton> : null,
              },
              { key: "give", label: "Give Books to Students", href: "/academy/books/distribution", count: `${counts.toGive} to give` },
            ]
          : [];
  const current = tabs.find((t) => t.key === section);

  return (
    <>
      <nav aria-label="Book steps" className="mb-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        {/* Horizontal roadmap (tablet and desktop) */}
        <div className="relative hidden grid-cols-4 px-2 pt-5 sm:grid">
          <div aria-hidden="true" className="absolute left-[12.5%] right-[12.5%] top-[38px] h-1 rounded-sm bg-border">
            <div className="h-full rounded-sm bg-brand transition-[width] duration-200" style={{ width: fill }} />
          </div>
          {stages.map((s) => {
            const on = stage === s.n;
            const done = stage > s.n;
            return (
              <Link
                key={s.n}
                href={s.href}
                aria-current={on ? "step" : undefined}
                title={s.q}
                className="relative flex min-w-0 flex-col items-center gap-1.5 px-2 pb-[18px] text-center !no-underline hover:!no-underline"
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[3px] text-base font-bold ${
                    done ? "border-brand bg-brand text-white" : on ? "border-brand bg-surface text-brand shadow-[0_0_0_4px_#F9E8EC,0_0_0_6px_#F5B638]" : "border-border-strong bg-surface text-muted"
                  }`}
                >
                  {done ? "✓" : s.n}
                </span>
                <span className={`mt-1.5 text-[15px] font-bold leading-tight ${on ? "text-brand" : "text-ink"}`}>{s.title}</span>
                <span className="max-w-[190px] text-xs leading-snug text-muted">{s.verb}</span>
                <StagePill on={on} value={String(s.count)} />
              </Link>
            );
          })}
        </div>
        {/* Vertical roadmap (phones) */}
        <div className="px-3.5 py-2 sm:hidden">
          {stages.map((s, i) => {
            const on = stage === s.n;
            const done = stage > s.n;
            return (
              <Link
                key={s.n}
                href={s.href}
                aria-current={on ? "step" : undefined}
                className="relative flex min-h-[60px] w-full items-center gap-3.5 py-2.5 text-left !no-underline hover:!no-underline"
              >
                {i < 3 && <span aria-hidden="true" className={`absolute bottom-[-12px] left-[17px] top-12 w-[3px] rounded-sm ${done ? "bg-brand" : "bg-border"}`} />}
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[3px] text-[15px] font-bold ${
                    done ? "border-brand bg-brand text-white" : on ? "border-brand bg-surface text-brand shadow-[0_0_0_4px_#F9E8EC,0_0_0_6px_#F5B638]" : "border-border-strong bg-surface text-muted"
                  }`}
                >
                  {done ? "✓" : s.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] font-bold leading-tight ${on ? "text-brand" : "text-ink"}`}>{s.title}</span>
                  <span className="block text-xs leading-snug text-muted">{s.verb}</span>
                </span>
                <StagePill on={on} value={String(s.count)} />
              </Link>
            );
          })}
        </div>
      </nav>

      <div className={`mb-5 mt-1 flex flex-wrap items-end gap-x-6 gap-y-1 ${tabs.length ? "border-b border-border" : ""}`}>
        {tabs.length > 0 && (
          <div role="tablist" aria-label="Section" className="-mb-px flex max-w-full gap-6 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((t) => {
              const on = t.key === section;
              return (
                <Link
                  key={t.key}
                  href={t.href}
                  role="tab"
                  aria-selected={on}
                  className={`flex h-12 items-center gap-2 whitespace-nowrap border-b-[3px] px-0.5 text-[15px] font-semibold !no-underline hover:!no-underline ${
                    on ? "border-brand !text-brand" : "border-transparent !text-[#4B5563] hover:!text-ink"
                  }`}
                >
                  <span>{t.label}</span>
                  <span
                    className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-2 text-xs font-semibold ${
                      t.warn ? "bg-warning-bg text-[#78350F]" : on ? "bg-brand-tint text-brand" : "bg-[#EEF0F3] text-[#374151]"
                    }`}
                  >
                    {t.count}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2 pb-1.5">
          <Link
            href="/academy/books/reports"
            aria-current={section === "reports" ? "page" : undefined}
            className={`flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 font-semibold !text-brand !no-underline hover:bg-brand-tint hover:!no-underline ${section === "reports" ? "bg-brand-tint" : ""}`}
          >
            <Icon name="bar_chart" width={18} height={18} />
            Reports
          </Link>
          {current?.action}
        </div>
      </div>
    </>
  );
}

function StagePill({ on, value }: { on: boolean; value: string }) {
  return (
    <span
      className={`inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border px-2 text-xs font-bold ${
        on ? "border-[#F5B638] bg-[#F5B638] text-ink" : "border-border bg-surface text-[#374151]"
      }`}
    >
      {value}
    </span>
  );
}
