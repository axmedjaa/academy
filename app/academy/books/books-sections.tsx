"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import { updateBookAction } from "@/lib/academies/books-actions";
import { cancelBookOrderAction } from "@/lib/academies/book-orders-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatMoney } from "@/lib/ui/money";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge } from "@/app/academy/_shell/ui";
import { ActionButton, useBooksActions } from "./books-actions";
import { initials, tileOf, type Tone } from "./books-view";

/** Interactive pieces of the Book Management sections (design B01-B09). */

function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const write = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("page");
    const query = next.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  };
  return { write, pending, searchParams };
}

/** The design's rounded filter chips with counts; writes one URL param. */
export function PillChips({ param, label, options }: { param: string; label: string; options: { value: string; label: string; count: number }[] }) {
  const { write, searchParams } = useParamWriter();
  const current = searchParams.get(param) ?? "";
  return (
    <div role="group" aria-label={label} className="mb-4 flex flex-wrap gap-2">
      {options.map((o) => {
        const on = current === o.value;
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={on}
            onClick={() => write({ [param]: o.value || null })}
            className={`inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 font-semibold transition-colors duration-150 ${
              on ? "border-brand bg-brand-tint text-brand" : "border-border-strong bg-surface text-[#374151] hover:bg-app"
            }`}
          >
            <span>{o.label}</span>
            <span className="opacity-75 tabular-nums">{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ToggleParam({ param, label }: { param: string; label: string }) {
  const { write, searchParams } = useParamWriter();
  const on = searchParams.get(param) === "1";
  return (
    <label className="flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3">
      <input type="checkbox" checked={on} onChange={() => write({ [param]: on ? null : "1" })} className="h-4 w-4 accent-brand" />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Book card (design B01)                                              */
/* ------------------------------------------------------------------ */

export function BookCard({ book }: { book: BookRecord }) {
  const router = useRouter();
  const { data, open } = useBooksActions();
  const [toggling, startToggle] = useTransition();
  const archived = book.status !== "active";
  const noSell = archived || book.stockQuantity <= 0;
  const sellWhy = archived ? "Archived book." : book.stockQuantity <= 0 ? "Out of stock. Take a pre-order instead." : undefined;
  const stockText = book.stockQuantity === 0 ? "Out of stock" : book.stockQuantity <= 5 ? `Low stock: ${book.stockQuantity} left` : `${book.stockQuantity} in stock`;
  const stockColor = book.stockQuantity === 0 ? "text-[#B91C1C]" : book.stockQuantity <= 5 ? "text-[#92400E]" : "text-[#166534]";
  const tile = tileOf(book.subject, book.name);
  const cover = data.coverUrls[book.id];

  function toggleArchive() {
    startToggle(async () => {
      try {
        const next = archived ? "active" : "inactive";
        const result = await updateBookAction(book.id, { status: next });
        if (!result.ok) {
          showErrorToast(result.error?.message ?? "The book couldn't be updated.");
          return;
        }
        showSuccessToast(next === "inactive" ? `Archived: ${book.name}. Existing orders keep this book.` : `Restored: ${book.name}`);
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const textButton = "min-h-11 rounded-lg px-1.5 font-semibold transition-colors duration-150 hover:bg-app disabled:opacity-60";
  return (
    <article className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card ${archived ? "opacity-85" : ""}`}>
      {/* Cover area: the uploaded cover, or a book in the subject's colour. */}
      <div className="relative flex h-[164px] items-center justify-center" style={{ background: `${tile.color}14` }}>
        <span
          aria-hidden="true"
          className="flex h-[132px] w-24 items-center justify-center overflow-hidden rounded-md text-[28px] font-bold text-white shadow-[inset_6px_0_0_rgba(0,0,0,0.18),0_6px_14px_rgba(17,24,39,0.18)]"
          style={{ background: tile.color }}
        >
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(book.name)
          )}
        </span>
        <span className="absolute right-3 top-3">
          <Badge label={archived ? "Archived" : "Active"} tone={archived ? "gray" : "green"} />
        </span>
      </div>
      <div className="flex flex-1 flex-col px-4 pb-3.5 pt-4">
        <h3 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">{book.name}</h3>
        <p className="mt-1 text-[13px] leading-snug text-muted">{[book.subject, book.classLevel].filter(Boolean).join(" · ") || book.author || "No subject or class"}</p>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-2xl font-bold tracking-[-0.01em] tabular-nums">{formatMoney(book.priceCents, book.currency)}</span>
          <span className={`text-[13px] font-semibold ${stockColor}`}>{stockText}</span>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-0.5 border-t border-border px-3 py-3">
        {data.canSell && (
          <button
            type="button"
            disabled={noSell}
            title={sellWhy}
            onClick={() => open({ kind: "sell", bookId: book.id })}
            className="mr-auto min-h-11 shrink-0 rounded-lg bg-brand px-3.5 font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
          >
            Sell Book
          </button>
        )}
        <button type="button" onClick={() => open({ kind: "viewBook", bookId: book.id })} className={`${textButton} text-[#374151]`}>
          View
        </button>
        {data.canManageBooks && (
          <>
            <button type="button" onClick={() => open({ kind: "editBook", bookId: book.id })} className={`${textButton} text-[#374151]`}>
              Edit
            </button>
            <button type="button" disabled={toggling} onClick={toggleArchive} className={`${textButton} text-brand hover:bg-brand-tint`}>
              {toggling ? "Saving…" : archived ? "Restore" : "Archive"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Order buttons                                                       */
/* ------------------------------------------------------------------ */

export function ToneBadge({ badge }: { badge: { label: string; tone: Tone } }) {
  return <Badge label={badge.label} tone={badge.tone} />;
}

/** "Record payment" (money from the buyer) on a student book order with a balance. */
export function PayButton({ orderId, className = "" }: { orderId: string; className?: string }) {
  const { data } = useBooksActions();
  if (!data.canManageOrders) return null;
  return (
    <ActionButton dialog={{ kind: "pay", orderId }} variant="secondary" className={className}>
      Record payment
    </ActionButton>
  );
}

/** Cancel a student book order (only before any payment or hand-over). */
export function CancelOrderButton({ orderId, summary }: { orderId: string; summary: string }) {
  const { confirm, data } = useBooksActions();
  if (!data.canManageOrders) return null;
  return (
    <button
      type="button"
      onClick={() =>
        confirm({
          title: "Cancel this order?",
          body: `${summary} A cancelled order can't take payments or be given.`,
          label: "Cancel order",
          success: "Order cancelled.",
          run: async () => {
            const result = await cancelBookOrderAction(orderId);
            return result.ok ? null : (result.error?.message ?? "The order couldn't be cancelled.");
          },
        })
      }
      className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 font-semibold text-[#B91C1C] hover:bg-app"
    >
      Cancel order
    </button>
  );
}

export function GatedAction({ need, ...props }: { need: "canManageOrders" | "canIssue" | "canManageBooks" | "canSell" } & Parameters<typeof ActionButton>[0]) {

  const { data } = useBooksActions();
  if (!data[need]) return null;
  return <ActionButton {...props} />;
}
