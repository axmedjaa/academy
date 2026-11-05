"use client";

import Link from "next/link";
import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import { updateBookAction } from "@/lib/academies/books-actions";
import { setCampaignStatusAction, verifyPreorderPaymentAction } from "@/lib/academies/book-preorders-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatMoney } from "@/lib/ui/money";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge } from "@/app/academy/_shell/ui";
import { ActionButton, BookCover, useBooksActions } from "./books-actions";
import type { Tone } from "./books-view";

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

export interface StepCard {
  n: string;
  title: string;
  sub: string;
  dialog?: Parameters<ReturnType<typeof useBooksActions>["open"]>[0];
  href?: string;
}

/** The design's numbered how-to cards above a section; a card that starts
 * an action opens it. */
export function StepCards({ steps }: { steps: StepCard[] }) {
  const { open, data } = useBooksActions();
  const body = (s: StepCard) => (
    <>
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[13px] font-bold text-brand">
        {s.n}
      </span>
      <span className="min-w-0">
        <span className="block font-bold text-ink">{s.title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{s.sub}</span>
      </span>
    </>
  );
  const cls = "flex min-w-0 items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-left";
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      {steps.map((s) =>
        s.dialog && data.canManage ? (
          <button key={s.n} type="button" onClick={() => open(s.dialog!)} className={`${cls} cursor-pointer transition-colors duration-150 hover:border-brand`}>
            {body(s)}
          </button>
        ) : s.href ? (
          <Link key={s.n} href={s.href} className={`${cls} !no-underline transition-colors duration-150 hover:border-brand hover:!no-underline`}>
            {body(s)}
          </Link>
        ) : (
          <div key={s.n} className={cls}>
            {body(s)}
          </div>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Book card (design B01)                                              */
/* ------------------------------------------------------------------ */

export function BookCard({ book, campaign }: { book: BookRecord; campaign: { name: string; sub: string } | null }) {
  const router = useRouter();
  const { data, open } = useBooksActions();
  const [toggling, startToggle] = useTransition();
  const archived = book.status !== "active";
  const noSell = archived || book.stockQuantity <= 0;
  const sellWhy = archived ? "Archived book." : book.stockQuantity <= 0 ? "Out of stock. Take a pre-order instead." : undefined;
  const stockText = book.stockQuantity === 0 ? "Out of stock" : book.stockQuantity <= 5 ? `Low stock: ${book.stockQuantity} left` : `${book.stockQuantity} in stock`;
  const stockColor = book.stockQuantity === 0 ? "text-[#B91C1C]" : book.stockQuantity <= 5 ? "text-[#92400E]" : "text-[#166534]";

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

  return (
    <article className={`flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card ${archived ? "opacity-85" : ""}`}>
      <div className="flex items-start gap-3.5">
        <BookCover book={book} url={data.coverUrls[book.id]} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-snug [overflow-wrap:anywhere]">{book.name}</h3>
          <p className="mt-1 text-xs leading-snug text-muted">{[book.subject, book.classLevel].filter(Boolean).join(" · ") || book.author || "No subject or class"}</p>
          <p className="mt-2 text-lg font-bold tabular-nums">{formatMoney(book.priceCents, book.currency)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-[13px] text-[#374151]">
          {campaign ? campaign.name : "Not in a campaign"} <span className="text-muted">· {campaign ? campaign.sub : "Add it to a campaign"}</span>
        </span>
        <Badge label={archived ? "Archived" : "Active"} tone={archived ? "gray" : "green"} />
      </div>
      <p className={`text-[13px] font-semibold ${stockColor}`}>{stockText}</p>
      <div className="mt-auto flex flex-wrap gap-2">
        {data.canSell && (
          <button
            type="button"
            disabled={noSell}
            title={sellWhy}
            onClick={() => open({ kind: "sell", bookId: book.id })}
            className="min-h-11 flex-[1_1_100%] rounded-lg bg-brand font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-[#9CA3AF]"
          >
            Sell Book
          </button>
        )}
        <button type="button" onClick={() => open({ kind: "viewBook", bookId: book.id })} className="min-h-11 flex-[1_1_70px] rounded-lg border border-border-strong bg-surface font-semibold hover:bg-app">
          View
        </button>
        {data.canManageBooks && (
          <>
            <button type="button" onClick={() => open({ kind: "editBook", bookId: book.id })} className="min-h-11 flex-[1_1_70px] rounded-lg border border-border-strong bg-surface font-semibold hover:bg-app">
              Edit
            </button>
            <button
              type="button"
              disabled={toggling}
              onClick={toggleArchive}
              className="min-h-11 flex-[1_1_80px] rounded-lg border border-dashed border-brand bg-surface text-[13px] font-semibold text-brand hover:bg-brand-tint disabled:opacity-60"
            >
              {toggling ? "Saving…" : archived ? "Restore" : "Archive"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Campaign card buttons (design B02)                                  */
/* ------------------------------------------------------------------ */

export function CampaignButtons({ campaignId, status, name }: { campaignId: string; status: string; name: string }) {
  const router = useRouter();
  const { data } = useBooksActions();
  const [pending, start] = useTransition();
  const canToggle = data.canManageCampaigns && ["open", "closed", "draft", "scheduled"].includes(status);
  const isOpen = status === "open";
  return (
    <div className="mt-auto flex flex-wrap gap-2">
      {canToggle && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const result = await setCampaignStatusAction(campaignId, isOpen ? "closed" : "open");
                if (!result.ok) {
                  showErrorToast(result.error?.message ?? "The campaign couldn't be updated.");
                  return;
                }
                showSuccessToast(isOpen ? `Ordering is closed: ${name}` : `Ordering is open: ${name}`);
                router.refresh();
              } catch {
                showErrorToast(NETWORK_ERROR_MESSAGE);
              }
            })
          }
          className={`min-h-11 flex-[1_1_120px] rounded-lg font-semibold disabled:opacity-60 ${isOpen ? "border border-border-strong bg-surface text-ink hover:bg-app" : "bg-brand text-white hover:bg-brand-hover"}`}
        >
          {pending ? "Saving…" : isOpen ? "Close Ordering" : "Open Ordering"}
        </button>
      )}
      <Link
        href={`/academy/books/orders?campaign=${campaignId}`}
        className="flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3 font-semibold !text-ink !no-underline hover:bg-app hover:!no-underline"
      >
        View orders
      </Link>
      {data.canManageCampaigns && (
        <ActionButton dialog={{ kind: "campaign", campaignId }} variant="secondary" className="flex-1">
          Edit
        </ActionButton>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payment verification                                                */
/* ------------------------------------------------------------------ */

export function VerifyButton({ paymentId, summary }: { paymentId: string; summary: string }) {
  const { confirm, data } = useBooksActions();
  if (!data.canManage) return null;
  return (
    <button
      type="button"
      onClick={() =>
        confirm({
          title: "Verify this payment?",
          body: `Confirm the money was received: ${summary}.`,
          label: "Verify Payment",
          success: "Payment verified",
          run: async () => {
            const result = await verifyPreorderPaymentAction(paymentId);
            return result.ok ? null : (result.error?.message ?? "The payment couldn't be verified.");
          },
        })
      }
      className="h-9 rounded-lg border border-brand px-3 text-sm font-semibold text-brand hover:bg-brand-tint"
    >
      Verify
    </button>
  );
}

export function ToneBadge({ badge }: { badge: { label: string; tone: Tone } }) {
  return <Badge label={badge.label} tone={badge.tone} />;
}

/** The "Record Payment" button on an order card (manage only). */
export function PayButton({ orderId, className = "" }: { orderId: string; className?: string }) {
  const { data } = useBooksActions();
  if (!data.canManage) return null;
  return (
    <ActionButton dialog={{ kind: "pay", orderId }} className={className}>
      Record Payment
    </ActionButton>
  );
}

export function ReceiveButton({ campaignId, bookId, primary }: { campaignId: string; bookId: string; primary: boolean }) {
  const { data } = useBooksActions();
  if (!data.canManageCampaigns) return null;
  return (
    <ActionButton dialog={{ kind: "receive", campaignId, bookId }} variant={primary ? "primary" : "secondary"} className="w-full">
      Receive Books
    </ActionButton>
  );
}

export function GatedAction({ need, ...props }: { need: "canManage" | "canManageCampaigns" | "canManageBooks" | "canSell" } & Parameters<typeof ActionButton>[0]) {
  const { data } = useBooksActions();
  if (!data[need]) return null;
  return <ActionButton {...props} />;
}
