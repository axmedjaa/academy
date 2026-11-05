"use client";

import Link from "next/link";
import { useState } from "react";
import { givePreorderBooksAction } from "@/lib/academies/book-preorders-actions";
import { Badge } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ActionButton, newKey, useBooksActions } from "./books-actions";
import type { Tone } from "./books-view";

export interface GiveLine {
  bookId: string;
  title: string;
  coverUrl: string | null;
  initials: string;
  ordered: number;
  given: number;
  /** Most that can be given now: min(remaining, campaign pool). */
  max: number;
}

export interface GiveRowData {
  orderId: string;
  reference: string;
  buyerName: string;
  /** Student number, or the other person's phone ("No phone"). */
  buyerId: string;
  /** Branch, prefixed with "Other person" for a non-student. */
  buyerSub: string;
  /**
   * Why books can't be given yet, or null when they can: the order must be
   * paid in full AND every payment on it verified.
   */
  hold: null | { kind: "unpaid"; outstanding: string; paymentLabel: string } | { kind: "unverified"; unverified: string };
  initials: string;
  campaignName: string;
  copies: number;
  given: number;
  ready: number;
  badge: { label: string; tone: Tone };
  lines: GiveLine[];
}

/**
 * One order on Give Books (design B08): the buyer (a student or another
 * person), progress, whether the books are ready, and — opened — each
 * book with − / + and Mark as Given. Books are given only for an order
 * paid in full with every payment verified: until then the row shows the
 * outstanding or unverified amount and why giving is blocked, with no
 * control to give. The quantity is capped by
 * what was ordered and by the undamaged copies received and not yet
 * given. The server enforces both rules again under a lock.
 */
export function GiveRow({ row, initiallyOpen }: { row: GiveRowData; initiallyOpen: boolean }) {
  const { data, confirm } = useBooksActions();
  const [open, setOpen] = useState(initiallyOpen);
  const [qty, setQty] = useState<Record<string, number>>({});
  const remaining = row.copies - row.given;
  const hold = row.hold;
  const tone =
    remaining === 0 ? "bg-[#EEF0F3] text-[#374151]" : hold ? "bg-[#FEF2F2] text-[#B91C1C]" : row.ready > 0 ? "bg-[#ECFDF3] text-[#166534]" : "bg-[#FEF3C7] text-[#78350F]";
  const readyText =
    remaining === 0
      ? "Nothing left to give"
      : hold?.kind === "unpaid"
        ? `Not paid in full: ${hold.outstanding} outstanding`
        : hold?.kind === "unverified"
          ? `Payment not verified: ${hold.unverified} to verify`
          : row.ready >= remaining
        ? `Ready to give ${row.ready} ${row.ready === 1 ? "book" : "books"}`
        : row.ready > 0
          ? `Ready to give ${row.ready} of ${remaining} remaining books`
          : "Not ready: books have not arrived yet";
  const toggleLabel = remaining === 0 ? (open ? "Hide books" : "View books") : open ? "Hide books" : "Give books";
  const pct = row.copies ? Math.round((row.given / row.copies) * 100) : 0;

  return (
    <article className="mb-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="grid grid-cols-1 items-center gap-4 p-4 md:grid-cols-[2.2fr_1.6fr_auto] md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-tint to-[#E9C3CC] font-bold text-brand">
            {row.initials}
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold leading-tight">{row.buyerName}</p>
            <p className="text-[13px] text-muted">
              {row.buyerId} · {row.buyerSub}
            </p>
            <p className="text-xs text-muted">
              {row.campaignName} · {row.reference}
            </p>
          </div>
        </div>
        <div className="min-w-0">
          <p className="font-semibold">
            {row.given} of {row.copies} {row.copies === 1 ? "book" : "books"} given
          </p>
          <p className="text-xs text-muted">{remaining === 0 ? "Nothing left to give" : `${remaining} ${remaining === 1 ? "book" : "books"} still to give`}</p>
          <span className={`mt-1.5 inline-flex h-[26px] items-center rounded-full px-2.5 text-xs font-semibold ${tone}`}>{readyText}</span>
          <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-[#F1F2F5]">
            <div className="h-full bg-[#166534]" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end">
          <Badge label={row.badge.label} tone={row.badge.tone} />
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`min-h-11 rounded-lg px-4 font-semibold ${remaining > 0 && !open ? "bg-brand text-white hover:bg-brand-hover" : "border border-border-strong bg-surface text-ink hover:bg-app"}`}
          >
            {toggleLabel}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-border bg-[#FAFBFC] px-4 py-4 md:px-5">
          {remaining > 0 && hold ? (
            <div role="alert" className="mb-3 flex flex-wrap items-start gap-3 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-sm text-[#991B1B]">
              <span className="mt-0.5 shrink-0">
                <Icon name="warning" width={18} height={18} />
              </span>
              {hold.kind === "unpaid" ? (
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    Books can&apos;t be given yet: {hold.paymentLabel.toLowerCase()}, {hold.outstanding} outstanding.
                  </p>
                  <p className="mt-0.5">Books are given only after the order is paid in full and every payment is verified. Record the remaining payment first.</p>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">Books can&apos;t be given yet: paid in full, but {hold.unverified} of the payments is not verified.</p>
                  <p className="mt-0.5">Books are given only after every payment on the order is verified. Confirm the money was received, then verify the payments.</p>
                </div>
              )}
              {data.canManage &&
                (hold.kind === "unpaid" ? (
                  <ActionButton dialog={{ kind: "pay", orderId: row.orderId }} className="shrink-0">
                    Record Payment
                  </ActionButton>
                ) : (
                  <Link
                    href={`/academy/books/orders/${row.orderId}`}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand px-4 font-semibold !text-white !no-underline hover:bg-brand-hover hover:!no-underline"
                  >
                    Verify payments
                  </Link>
                ))}
            </div>
          ) : (
            <div className="mb-3 flex items-start gap-2 text-sm text-[#374151]">
              <span className="mt-0.5 shrink-0 text-muted">
                <Icon name="info" width={18} height={18} />
              </span>
              <span>
                {remaining === 0
                  ? "Every book on this order has been given. Nothing more to give."
                  : "Paid in full and verified. Choose how many copies to give with − and +, then press Mark as Given and confirm. You can give some books now and the rest later."}
              </span>
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            {row.lines.map((l, i) => {
              const rem = l.ordered - l.given;
              const q = Math.max(1, Math.min(qty[l.bookId] ?? l.max, Math.max(l.max, 1)));
              const note =
                rem === 0
                  ? "All copies given"
                  : hold?.kind === "unpaid"
                    ? "Blocked until the order is paid in full"
                    : hold
                      ? "Blocked until every payment is verified"
                    : l.max < 1
                      ? "Cannot give yet: not received"
                      : l.max < rem
                        ? `Ready to give ${l.max} now. ${rem - l.max} not received yet`
                        : `Ready to give: ${l.max} in stock`;
              const noteColor = rem === 0 ? "text-[#374151]" : hold ? "text-[#B91C1C]" : l.max < 1 ? "text-[#92400E]" : "text-[#166534]";
              return (
                <div key={l.bookId} className={`grid grid-cols-1 items-center gap-3 p-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] ${i ? "border-t border-border" : ""}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-brand-tint to-[#E9C3CC] text-xs font-bold text-brand">
                      {l.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
                        <img src={l.coverUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        l.initials
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold [overflow-wrap:anywhere]">{l.title}</p>
                      <p className={`text-xs font-semibold ${noteColor}`}>{note}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ["Ordered", l.ordered],
                      ["Given", l.given],
                      ["Remaining", rem],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-app px-1 py-1.5">
                        <div className="text-[11px] text-muted">{label}</div>
                        <div className="font-bold tabular-nums">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {rem === 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#166534]">
                        <Icon name="check_circle" width={18} height={18} />
                        All given
                      </span>
                    ) : hold ? (
                      <span className="text-sm font-semibold text-[#B91C1C]">{hold.kind === "unpaid" ? "Waiting for full payment" : "Waiting for verification"}</span>
                    ) : l.max < 1 ? (
                      data.canManageCampaigns ? (
                        <Link href="/academy/books/receiving" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong px-3 text-sm font-semibold !text-ink !no-underline hover:bg-app">
                          Receive Books first
                        </Link>
                      ) : (
                        <span className="text-sm text-muted">Waiting for delivery</span>
                      )
                    ) : data.canManage ? (
                      <>
                        <span className="flex items-center gap-1.5">
                          <button
                            type="button"
                            aria-label="Fewer copies"
                            disabled={q <= 1}
                            onClick={() => setQty((cur) => ({ ...cur, [l.bookId]: Math.max(1, q - 1) }))}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-strong bg-surface text-lg font-semibold hover:bg-app disabled:opacity-40"
                          >
                            −
                          </button>
                          <span className="w-7 text-center font-bold tabular-nums" aria-live="polite">
                            {q}
                          </span>
                          <button
                            type="button"
                            aria-label="More copies"
                            disabled={q >= l.max}
                            onClick={() => setQty((cur) => ({ ...cur, [l.bookId]: Math.min(l.max, q + 1) }))}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-strong bg-surface text-lg font-semibold hover:bg-app disabled:opacity-40"
                          >
                            +
                          </button>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const key = newKey();
                            confirm({
                              title: "Mark as given?",
                              body: `Give ${q} ${q === 1 ? "copy" : "copies"} of ${l.title} to ${row.buyerName} (${row.buyerId}). The order is paid in full and verified.`,
                              label: "Mark as Given",
                              success: `Marked as given: ${q} × ${l.title} to ${row.buyerName}`,
                              run: async () => {
                                const result = await givePreorderBooksAction({ idempotencyKey: key, orderId: row.orderId, bookId: l.bookId, quantity: q });
                                if (!result.ok) return result.error?.message ?? "The books couldn't be marked as given.";
                                setQty((cur) => {
                                  const next = { ...cur };
                                  delete next[l.bookId];
                                  return next;
                                });
                                return null;
                              },
                            });
                          }}
                          className="min-h-11 rounded-lg bg-brand px-4 font-semibold text-white hover:bg-brand-hover"
                        >
                          Mark as Given
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-right">
            <Link href={`/academy/books/orders/${row.orderId}`} className="text-sm font-semibold">
              View order details
            </Link>
          </div>
        </div>
      )}
    </article>
  );
}
