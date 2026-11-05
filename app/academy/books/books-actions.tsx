"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import type { CampaignView, PreorderBranchOption, PreorderStudentOption } from "@/lib/academies/book-preorders";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABEL,
  PREORDER_PAYMENT_METHODS,
  PREORDER_PAYMENT_METHOD_LABEL,
  RECEIVABLE_STATUSES,
  computePreorderPricing,
  type CampaignStatus,
  type PreorderPaymentMethod,
} from "@/lib/academies/book-preorder-math";
import {
  createPreorderAction,
  recordPreorderPaymentAction,
  recordPreorderReceiptAction,
  saveCampaignAction,
} from "@/lib/academies/book-preorders-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { showSuccessToast } from "@/lib/ui/toast";
import { Badge } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  FormSummary,
  controlClass,
  invalidProps,
} from "@/app/academy/_shell/design-form";
import { AddBookForm, EditBookForm, SellForm, type BookSuggestions } from "./books-client";
import { buyerOf, buyerSearchText, campaignBadge, formatIsoDate, initials, plural, tileOf, todayIso } from "./books-view";
import { formatPreorderReference, referenceSequence } from "@/lib/academies/book-preorder-math";

/**
 * Book Management actions (design B01-B08 dialogs). One provider in the
 * Books layout owns every dialog, so the hero, the step bar's action
 * button and each section's buttons all open the same forms. Each form
 * only collects input: the server action re-validates and recomputes
 * everything (permission, branch, totals, limits, availability) and is the
 * only authority. Writes carry a fresh idempotency key per attempt, so a
 * double click or a retried request cannot save twice.
 */

export interface OrderPick {
  id: string;
  reference: string;
  campaignId: string;
  buyerType: "student" | "other_person";
  studentId: string | null;
  buyerName: string;
  studentNumber: string | null;
  buyerPhone: string | null;
  branchName: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface BooksClientData {
  /** Pre-orders: create orders, record/verify payments, give books. */
  canManage: boolean;
  /** Campaigns and receiving (all-branch access). */
  canManageCampaigns: boolean;
  /** Catalogue edits (books.ts's own canManage). */
  canManageBooks: boolean;
  /** Ordinary sales (book-sales.ts's own canManage). */
  canSell: boolean;
  books: BookRecord[];
  coverUrls: Record<string, string>;
  campaigns: CampaignView[];
  orders: OrderPick[];
  students: PreorderStudentOption[];
  /** Branches an other-person order can be recorded for (caller's scope). */
  branches: PreorderBranchOption[];
  suggestions: BookSuggestions;
}

type Dialog =
  | { kind: "addBook" }
  | { kind: "editBook"; bookId: string }
  | { kind: "viewBook"; bookId: string }
  | { kind: "sell"; bookId?: string }
  | { kind: "campaign"; campaignId?: string }
  | { kind: "order"; campaignId?: string }
  | { kind: "pay"; orderId?: string }
  | { kind: "receive"; campaignId?: string; bookId?: string };

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  label: string;
  /** Resolves to an error message, or null on success. */
  run: () => Promise<string | null>;
  success?: string;
}

interface BooksActions {
  data: BooksClientData;
  open: (dialog: Dialog) => void;
  confirm: (request: ConfirmRequest) => void;
}

const Ctx = createContext<BooksActions | null>(null);

export function useBooksActions(): BooksActions {
  const value = useContext(Ctx);
  if (!value) throw new Error("useBooksActions must be used inside BooksActionsProvider");
  return value;
}

export function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // RFC 4122 v4 fallback for older browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const DIALOG_TITLE: Record<Dialog["kind"], string> = {
  addBook: "Add Book",
  editBook: "Book details",
  viewBook: "Book details",
  sell: "Sell Book",
  campaign: "Campaign details",
  order: "Create Order",
  pay: "Record Payment",
  receive: "Receive Books",
};

export function BooksActionsProvider({ data, children }: { data: BooksClientData; children: ReactNode }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const done = useCallback(() => {
    setDialog(null);
    router.refresh();
  }, [router]);

  const value = useMemo<BooksActions>(() => ({ data, open: setDialog, confirm: setConfirmReq }), [data]);
  const kind = dialog?.kind;
  const book = dialog && "bookId" in dialog && dialog.bookId ? data.books.find((b) => b.id === dialog.bookId) : undefined;

  const description =
    kind === "addBook"
      ? "A cover image is required."
      : kind === "sell"
        ? "The book is in stock now. Stock goes down when the sale is saved."
        : kind === "campaign"
          ? "Tick the books students can order. The optional limit caps copies per book."
          : kind === "order"
            ? "Choose who is ordering, add books, then save the order."
            : kind === "receive"
              ? "Record a delivery from the supplier. Damaged copies are not added to usable stock."
              : undefined;
  const width = kind === "order" ? 1040 : kind === "sell" || kind === "campaign" ? 640 : 560;

  return (
    <Ctx.Provider value={value}>
      {children}
      <DesignDialog open={dialog !== null} onOpenChange={(o) => !o && close()} title={kind ? DIALOG_TITLE[kind] : ""} description={description} width={width}>
        <div className="contents text-sm">
        {kind === "addBook" && <AddBookForm suggestions={data.suggestions} onCancel={close} onSaved={done} />}
        {kind === "editBook" && book && <EditBookForm book={book} coverUrl={data.coverUrls[book.id] ?? null} suggestions={data.suggestions} onCancel={close} onSaved={done} />}
        {kind === "viewBook" && book && <BookView book={book} onClose={close} onEdit={() => setDialog({ kind: "editBook", bookId: book.id })} />}
        {kind === "sell" && <SellBookForm initialBookId={dialog?.kind === "sell" ? dialog.bookId : undefined} onCancel={close} onDone={done} />}
        {kind === "campaign" && <CampaignForm campaignId={dialog?.kind === "campaign" ? dialog.campaignId : undefined} onCancel={close} onSaved={done} />}
        {kind === "order" && <OrderForm initialCampaignId={dialog?.kind === "order" ? dialog.campaignId : undefined} onCancel={close} onSaved={done} />}
        {kind === "pay" && <PaymentForm initialOrderId={dialog?.kind === "pay" ? dialog.orderId : undefined} onCancel={close} onSaved={done} />}
        {kind === "receive" && (
          <ReceiveForm
            initialCampaignId={dialog?.kind === "receive" ? dialog.campaignId : undefined}
            initialBookId={dialog?.kind === "receive" ? dialog.bookId : undefined}
            onCancel={close}
            onSaved={done}
          />
        )}
        </div>
      </DesignDialog>
      <ConfirmDialog request={confirmReq} onClose={() => setConfirmReq(null)} onDone={() => router.refresh()} />
    </Ctx.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */

/** The design's "Go back / <action>" confirmation (alertdialog). */
function ConfirmDialog({ request, onClose, onDone }: { request: ConfirmRequest | null; onClose: () => void; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <DesignDialog
      open={request !== null}
      onOpenChange={(o) => {
        if (!o && !pending) {
          setError(null);
          onClose();
        }
      }}
      title={request?.title ?? ""}
    >
      {request && (
        <form
          className="flex min-h-0 flex-1 flex-col text-sm"
          role="alertdialog"
          aria-label={request.title}
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              let message: string | null;
              try {
                message = await request.run();
              } catch {
                message = NETWORK_ERROR_MESSAGE;
              }
              if (message) {
                setError(message);
                return;
              }
              setError(null);
              if (request.success) showSuccessToast(request.success);
              onClose();
              onDone();
            });
          }}
        >
          <DialogBody>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-brand">
                <Icon name="check_circle" />
              </span>
              <div className="text-sm leading-relaxed text-[#374151]">{request.body}</div>
            </div>
            <FormErrorBanner message={error} />
          </DialogBody>
          <DialogFooter onCancel={onClose} cancelLabel="Go back" submitLabel={request.label} pending={pending} />
        </form>
      )}
    </DesignDialog>
  );
}

/** Runs a confirm-then-save step inside a form dialog (Record Payment,
 * Receive Books): the form validates, then the summary is confirmed. */
function useConfirmStep() {
  const [step, setStep] = useState<{ title: string; body: ReactNode; label: string } | null>(null);
  return { step, ask: setStep, back: () => setStep(null) };
}

function ConfirmPanel({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-[#F0CDD5] bg-brand-tint p-4">
      <span className="mt-0.5 shrink-0 text-brand">
        <Icon name="check_circle" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-[#374151]">{body}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Book view                                                           */
/* ------------------------------------------------------------------ */

function BookCover({ book, url, size = "md" }: { book: BookRecord; url?: string | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-12 w-9 text-xs" : "h-[88px] w-16 text-xl";
  return (
    <span
      aria-hidden="true"
      className={`flex ${box} shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-brand-tint to-[#E9C3CC] font-bold text-brand shadow-[inset_-4px_0_0_rgba(133,0,25,0.18),0_2px_6px_rgba(17,24,39,0.12)]`}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        initials(book.name)
      )}
    </span>
  );
}

/** The design's small book tile: the cover when there is one, otherwise a
 * square in the subject's colour with its first two letters. */
export function SubjectTile({ book, url, size = "md" }: { book: BookRecord; url?: string | null; size?: "sm" | "md" }) {
  const tile = tileOf(book.subject, book.name);
  const box = size === "sm" ? "h-10 w-[34px] text-[10px]" : "h-[46px] w-[38px] text-[11px]";
  return (
    <span aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center overflow-hidden rounded-md font-bold text-white`} style={{ background: tile.color }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        tile.text
      )}
    </span>
  );
}

function BookView({ book, onClose, onEdit }: { book: BookRecord; onClose: () => void; onEdit: () => void }) {
  const { data } = useBooksActions();
  const campaigns = data.campaigns.filter((c) => c.books.some((b) => b.bookId === book.id));
  const meta = [book.subject, book.classLevel].filter(Boolean).join(" · ") || "No subject or class";
  return (
    <>
      <DialogBody>
        <div className="flex items-start gap-4">
          <BookCover book={book} url={data.coverUrls[book.id]} />
          <div className="min-w-0">
            <p className="text-lg font-bold leading-snug text-ink [overflow-wrap:anywhere]">{book.name}</p>
            <p className="mt-1 text-sm text-muted">{meta}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <b className="tabular-nums">{formatMoney(book.priceCents, book.currency)}</b>
              <Badge label={book.status === "active" ? "Active" : "Archived"} tone={book.status === "active" ? "green" : "gray"} />
            </div>
            <p className="mt-1 text-sm text-[#374151]">{book.stockQuantity} in stock for sale</p>
          </div>
        </div>
        <p className="mb-2 mt-5 text-[13px] font-semibold text-ink">Campaigns</p>
        {campaigns.length === 0 ? (
          <p className="text-sm text-muted">This book is not in any campaign yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {campaigns.map((c) => {
              const entry = c.books.find((b) => b.bookId === book.id)!;
              const badge = campaignBadge(c.status);
              return (
                <li key={c.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <span className="min-w-0">
                    <span className="block font-semibold">{c.name}</span>
                    <span className="block text-xs text-muted">{plural(entry.ordered, "copy", "copies")} ordered</span>
                  </span>
                  <Badge label={badge.label} tone={badge.tone} />
                </li>
              );
            })}
          </ul>
        )}
      </DialogBody>
      <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
        <button type="button" onClick={onClose} className="h-11 rounded-lg border border-border-strong bg-surface px-[18px] font-medium text-ink hover:bg-app">
          Close
        </button>
        {data.canManageBooks && (
          <button type="button" onClick={onEdit} className="h-11 rounded-lg bg-brand px-5 font-semibold text-white hover:bg-brand-hover">
            Edit book
          </button>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sell Book (existing sale flow, book chosen first)                   */
/* ------------------------------------------------------------------ */

/** Design B01 "Sell Book": choose a book in stock, then the unchanged
 * existing sale form (buyer type, student or other person, quantity,
 * discount, payment) records it through `createBookSaleAction`. */
function SellBookForm({ initialBookId, onCancel, onDone }: { initialBookId?: string; onCancel: () => void; onDone: () => void }) {
  const { data } = useBooksActions();
  const sellable = data.books.filter((b) => (b.status === "active" && b.stockQuantity > 0) || b.id === initialBookId);
  const [bookId, setBookId] = useState(initialBookId ?? "");
  const book = data.books.find((b) => b.id === bookId);
  const studentOptions = useMemo(
    () => data.students.map((s) => ({ id: s.id, fullName: s.fullName, studentNumber: s.studentNumber, phone: s.phone })),
    [data.students],
  );
  return (
    <>
      <div className="border-b border-border px-6 py-4">
        <DField label="Book" name="sellBook" required>
          <select value={bookId} onChange={(event) => setBookId(event.target.value)} className={controlClass(false)}>
            <option value="">Choose a book</option>
            {sellable.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}, {formatMoney(b.priceCents, b.currency)}, {b.stockQuantity} left
              </option>
            ))}
          </select>
        </DField>
        {sellable.length === 0 && <p className="mt-2 text-sm text-muted">No active book has copies in stock. Take a pre-order instead.</p>}
        {book && (
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-app px-3.5 py-3 text-sm">
            <div>
              <div className="text-xs text-muted">Current unit price</div>
              <div className="font-bold tabular-nums">{formatMoney(book.priceCents, book.currency)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Available stock</div>
              <div className={`font-bold tabular-nums ${book.stockQuantity <= 5 ? "text-warning" : "text-success"}`}>{book.stockQuantity} in stock</div>
            </div>
          </div>
        )}
      </div>
      {book ? (
        <SellForm key={book.id} book={book} studentOptions={studentOptions} onCancel={onCancel} onDone={onDone} />
      ) : (
        <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
          <button type="button" onClick={onCancel} className="h-11 rounded-lg border border-border-strong bg-surface px-[18px] font-medium text-ink hover:bg-app">
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Campaign                                                            */
/* ------------------------------------------------------------------ */

function CampaignForm({ campaignId, onCancel, onSaved }: { campaignId?: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const existing = campaignId ? data.campaigns.find((c) => c.id === campaignId) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [opensOn, setOpensOn] = useState(existing?.opensOn ?? "");
  const [closesOn, setClosesOn] = useState(existing?.closesOn ?? "");
  const [arrival, setArrival] = useState(existing?.expectedArrivalOn ?? "");
  const [status, setStatus] = useState<CampaignStatus>(existing?.status ?? "draft");
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    Object.fromEntries((existing?.books ?? []).map((b) => [b.bookId, b.quantityLimit ? String(b.quantityLimit) : ""])),
  );
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const q = search.trim().toLowerCase();
  const choices = data.books.filter(
    (b) => (b.status === "active" || b.id in selected) && (!q || `${b.name} ${b.subject ?? ""} ${b.classLevel ?? ""}`.toLowerCase().includes(q)),
  );

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Enter a campaign name.";
    if (!opensOn) e.opensOn = "Choose an opening date.";
    if (!closesOn) e.closesOn = "Choose a closing date.";
    else if (opensOn && closesOn < opensOn) e.closesOn = "Closing date must be on or after opening.";
    if (!arrival) e.arrival = "Choose an expected arrival.";
    else if (closesOn && arrival < closesOn) e.arrival = "Arrival must be on or after closing.";
    const ids = Object.keys(selected);
    if (!ids.length) e.books = "Select at least one book.";
    else if (ids.some((id) => selected[id] !== "" && !/^[1-9]\d*$/.test(selected[id].trim()))) e.books = "Limits must be whole numbers above 0, or left blank.";
    return e;
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const e = validate();
        setErrors(e);
        setBanner(Object.keys(e).length > 1 ? `${Object.keys(e).length} fields need attention. They are marked below.` : null);
        if (Object.keys(e).length) {
          window.setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus(), 40);
          return;
        }
        startTransition(async () => {
          try {
            const result = await saveCampaignAction(campaignId ?? null, {
              name: name.trim(),
              opensOn,
              closesOn,
              expectedArrivalOn: arrival,
              status,
              books: Object.entries(selected).map(([bookId, limit]) => ({ bookId, quantityLimit: limit.trim() ? Number(limit) : null })),
            });
            if (!result.ok) {
              setBanner(result.error?.message ?? "The campaign couldn't be saved.");
              return;
            }
            showSuccessToast(`Campaign saved: ${name.trim()}`);
            onSaved();
          } catch {
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Campaign name" name="name" required error={errors.name} full>
            <input type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Term 1 2027 books" className={controlClass(Boolean(errors.name))} {...invalidProps("name", errors.name)} />
          </DField>
          <DField label="Opens" name="opensOn" required error={errors.opensOn}>
            <input type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} className={controlClass(Boolean(errors.opensOn))} {...invalidProps("opensOn", errors.opensOn)} />
          </DField>
          <DField label="Closes" name="closesOn" required error={errors.closesOn}>
            <input type="date" value={closesOn} onChange={(e) => setClosesOn(e.target.value)} className={controlClass(Boolean(errors.closesOn))} {...invalidProps("closesOn", errors.closesOn)} />
          </DField>
          <DField label="Expected arrival" name="arrival" required error={errors.arrival}>
            <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} className={controlClass(Boolean(errors.arrival))} {...invalidProps("arrival", errors.arrival)} />
          </DField>
          <DField label="Status" name="status" hint="Students' orders can be taken only while the campaign is Open.">
            <select value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus)} className={controlClass(false)}>
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CAMPAIGN_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Books in this campaign" name="books" required error={errors.books} group full>
            <span className="relative block">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                <Icon name="search" width={18} height={18} />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search books"
                placeholder="Search books by title, subject or class"
                className={`${controlClass(false)} pl-10`}
              />
            </span>
            <span className="mt-2 block max-h-64 overflow-y-auto rounded-xl border border-border font-normal">
              {choices.length === 0 && <span className="block px-3.5 py-3 text-sm text-muted">No book matches your search.</span>}
              {choices.map((b, i) => {
                const on = b.id in selected;
                const entry = existing?.books.find((x) => x.bookId === b.id);
                return (
                  <span key={b.id} className={`flex flex-wrap items-center gap-3 px-3.5 py-2.5 ${i ? "border-t border-border" : ""}`}>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setSelected((cur) => {
                            const next = { ...cur };
                            if (on) delete next[b.id];
                            else next[b.id] = "";
                            return next;
                          })
                        }
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink [overflow-wrap:anywhere]">{b.name}</span>
                        <span className="block text-xs text-muted">
                          {[b.subject, b.classLevel, formatMoney(b.priceCents, b.currency), b.status !== "active" ? "Archived" : null].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </label>
                    {entry && <span className="text-xs text-muted">{plural(entry.ordered, "copy", "copies")} ordered</span>}
                    {on && (
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="No limit"
                        aria-label={`Order limit for ${b.name}`}
                        value={selected[b.id]}
                        onChange={(e) => setSelected((cur) => ({ ...cur, [b.id]: e.target.value }))}
                        className={`${controlClass(false)} !h-10 w-28`}
                      />
                    )}
                  </span>
                );
              })}
            </span>
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Save campaign" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Student order                                                       */
/* ------------------------------------------------------------------ */

function OrderForm({ initialCampaignId, onCancel, onSaved }: { initialCampaignId?: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const router = useRouter();
  const open = data.campaigns.filter((c) => c.status === "open");
  const [campaignId, setCampaignId] = useState(open.find((c) => c.id === initialCampaignId)?.id ?? open[0]?.id ?? "");
  const [buyerType, setBuyerType] = useState<"student" | "other_person">("student");
  const [studentId, setStudentId] = useState("");
  const [otherName, setOtherName] = useState("");
  const [otherPhone, setOtherPhone] = useState("");
  const [otherBranch, setOtherBranch] = useState(data.branches.length === 1 ? data.branches[0].id : "");
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(0);
  const [bookQuery, setBookQuery] = useState("");
  const [lines, setLines] = useState<{ bookId: string; quantity: number }[]>([]);
  const [discount, setDiscount] = useState("0");
  const [banner, setBanner] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const [pending, startTransition] = useTransition();

  const campaign = data.campaigns.find((c) => c.id === campaignId);
  const isOther = buyerType === "other_person";
  const student = isOther ? undefined : data.students.find((s) => s.id === studentId);
  const branch = data.branches.find((b) => b.id === otherBranch);
  const bookById = new Map(data.books.map((b) => [b.id, b]));
  const q = query.trim().toLowerCase();
  const pool = data.students.filter((s) => !q || `${s.fullName} ${s.studentNumber} ${s.branchName}`.toLowerCase().includes(q));
  const results = pool.slice(0, 8);
  const hasOrder = new Set(data.orders.filter((o) => o.campaignId === campaignId).map((o) => o.studentId));
  const dup = student ? data.orders.find((o) => o.studentId === student.id && o.campaignId === campaignId) : undefined;

  const orderCurrency = lines.length ? bookById.get(lines[0].bookId)?.currency : undefined;
  const bq = bookQuery.trim().toLowerCase();
  const campaignBooks = (campaign?.books ?? [])
    .map((entry) => ({ entry, book: bookById.get(entry.bookId) }))
    .filter((x): x is { entry: CampaignView["books"][number]; book: BookRecord } => Boolean(x.book && x.book.status === "active"))
    .filter((x) => !bq || `${x.book.name} ${x.book.subject ?? ""}`.toLowerCase().includes(bq));

  const discountPct = Number(discount);
  const discountErr = discount.trim() !== "" && (!/^\d+$/.test(discount.trim()) || discountPct > 100) ? "Enter a whole percentage between 0 and 100." : null;
  const priced = lines.map((l) => ({ ...l, unitPriceCents: bookById.get(l.bookId)?.priceCents ?? 0 }));
  const pricing = computePreorderPricing(priced, discountErr ? 0 : discountPct || 0);
  const currency = orderCurrency ?? "USD";
  const copies = lines.reduce((sum, l) => sum + l.quantity, 0);

  const leftFor = (entry: CampaignView["books"][number]) => (entry.quantityLimit === null ? Infinity : entry.quantityLimit - entry.ordered);
  const setQty = (bookId: string, quantity: number) =>
    setLines((cur) => (quantity <= 0 ? cur.filter((l) => l.bookId !== bookId) : cur.map((l) => (l.bookId === bookId ? { ...l, quantity } : l))));

  const buyerOk = isOther ? Boolean(otherName.trim() && branch) : Boolean(student);
  const buyerLabel = isOther ? otherName.trim() : (student?.fullName ?? "");
  const missing = [
    !buyerOk && (isOther ? "Enter the buyer name and choose a branch." : "Select a student."),
    !lines.length && "Add at least one book.",
    !campaign && "Choose an open campaign.",
  ]
    .filter(Boolean)
    .join(" ");
  const canSave = !missing && !discountErr;

  function save(next: boolean) {
    if (!canSave || !campaign) return;
    setBanner(null);
    startTransition(async () => {
      try {
        const result = await createPreorderAction({
          idempotencyKey: key,
          campaignId: campaign.id,
          buyerType,
          ...(isOther ? { buyerName: otherName.trim(), buyerPhone: otherPhone.trim(), branchId: otherBranch } : { studentId: student!.id }),
          discountPercent: discountPct || 0,
          lines: lines.map((l) => ({ bookId: l.bookId, quantity: l.quantity })),
        });
        if (!result.ok) {
          setBanner(result.error?.message ?? "The order couldn't be saved.");
          return;
        }
        showSuccessToast(`Saved ${result.reference} for ${buyerLabel}`);
        setKey(newKey());
        if (next) {
          setStudentId("");
          setOtherName("");
          setOtherPhone("");
          setQuery("");
          setLines([]);
          setDiscount("0");
          router.refresh();
        } else {
          onSaved();
          router.push(`/academy/books/orders/${result.id}`);
        }
      } catch {
        setBanner(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  if (open.length === 0) {
    return (
      <>
        <DialogBody>
          <div className="rounded-xl border border-border bg-app p-5 text-center">
            <p className="font-semibold">No campaign is open for orders</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[#4B5563]">Orders can be added to campaigns with the status Open. Create or open a campaign first.</p>
            <a href="/academy/books/pre-orders" className="mt-3 inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-4 font-semibold !text-ink no-underline hover:bg-app">
              Go to campaigns
            </a>
          </div>
        </DialogBody>
        <DialogFooter onCancel={onCancel} submitLabel="Save Order" disabled />
      </>
    );
  }

  const year = new Date().getFullYear();
  const nextReference = formatPreorderReference(year, data.orders.reduce((m, o) => Math.max(m, referenceSequence(o.reference, year)), 0) + 1);

  const qtyBtn = "flex h-9 w-9 items-center justify-center rounded-lg border border-border-strong bg-surface text-lg font-semibold text-ink hover:bg-app disabled:opacity-40";

  return (
    <>
      <DialogBody>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px] lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-xl border border-border p-4">
              <p className="mb-3 font-bold">1. Who is ordering?</p>
              <div role="radiogroup" aria-label="Buyer type" className="mb-3 inline-flex rounded-[10px] bg-[#EEF0F3] p-1">
                {(
                  [
                    ["student", "Student"],
                    ["other_person", "Other Person"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={buyerType === value}
                    onClick={() => setBuyerType(value)}
                    className={`h-10 rounded-lg px-[18px] font-semibold transition-colors duration-150 ${
                      buyerType === value ? "bg-surface text-brand shadow-[0_1px_2px_rgba(17,24,39,0.15)]" : "text-[#374151] hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {isOther ? (
                <div className="flex flex-col gap-3">
                  <label htmlFor="nwOn" className="flex flex-col gap-1.5 text-[13px] font-semibold">
                    <span>
                      Full name <span className="text-[#B91C1C]">*</span>
                    </span>
                    <input id="nwOn" type="text" autoComplete="off" maxLength={200} value={otherName} onChange={(e) => setOtherName(e.target.value)} placeholder="Hodan Ali" className={controlClass(false)} />
                  </label>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label htmlFor="nwOp" className="flex flex-col gap-1.5 text-[13px] font-semibold">
                      <span>
                        Phone number <span className="font-normal text-muted">(optional)</span>
                      </span>
                      <input id="nwOp" type="tel" maxLength={50} value={otherPhone} onChange={(e) => setOtherPhone(e.target.value)} placeholder="+252 63 400 0000" className={controlClass(false)} />
                    </label>
                    <label htmlFor="nwOb" className="flex flex-col gap-1.5 text-[13px] font-semibold">
                      <span>
                        Branch <span className="text-[#B91C1C]">*</span>
                      </span>
                      <select id="nwOb" value={otherBranch} onChange={(e) => setOtherBranch(e.target.value)} className={controlClass(false)}>
                        <option value="">Choose a branch</option>
                        {data.branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="text-xs text-muted">Other Person orders are for buyers who are not enrolled students, for example a parent.</p>
                </div>
              ) : student ? (
                <div className="flex items-center gap-3 rounded-xl bg-app px-3 py-2.5">
                  <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-tint to-[#E9C3CC] font-bold text-brand">
                    {initials(student.fullName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{student.fullName}</span>
                    <span className="block text-xs text-muted">
                      {student.studentNumber} · {student.branchName}
                    </span>
                  </span>
                  <button type="button" onClick={() => setStudentId("")} className="h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold hover:bg-app">
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <label htmlFor="nwStu" className="mb-1.5 block text-[13px] font-semibold">
                    Student name or ID
                  </label>
                  <span className="relative block">
                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                      <Icon name="search" width={18} height={18} />
                    </span>
                    <input
                      id="nwStu"
                      type="search"
                      autoComplete="off"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setHl(0);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && results[hl]) {
                          e.preventDefault();
                          setStudentId(results[hl].id);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setHl((h) => Math.min(results.length - 1, h + 1));
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setHl((h) => Math.max(0, h - 1));
                        }
                      }}
                      placeholder="Search by name or student ID"
                      className={`${controlClass(false)} pl-10`}
                    />
                  </span>
                  <div role="listbox" aria-label="Students" className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border">
                    {results.map((s, i) => (
                      <button
                        key={s.id}
                        type="button"
                        role="option"
                        aria-selected={i === hl}
                        onMouseEnter={() => setHl(i)}
                        onClick={() => setStudentId(s.id)}
                        className={`flex w-full items-center gap-3 px-3 py-2 text-left ${i ? "border-t border-border" : ""} ${i === hl ? "bg-brand-tint" : "bg-surface"}`}
                      >
                        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app text-xs font-bold text-brand">
                          {initials(s.fullName)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">{s.fullName}</span>
                          <span className="block text-xs text-muted">
                            {s.studentNumber} · {s.branchName}
                          </span>
                        </span>
                        {hasOrder.has(s.id) && <span className="text-xs font-semibold text-warning">Has an order</span>}
                      </button>
                    ))}
                    {results.length === 0 && <p className="px-3 py-3 text-sm text-muted">No student matches “{query}”. Only existing students can be selected.</p>}
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {pool.length > 8 ? `Showing 8 of ${pool.length} students. Keep typing to narrow the list.` : `${plural(pool.length, "student", "students")}. Use the arrow keys and Enter to pick quickly.`}
                  </p>
                </>
              )}
              <div className="mt-4">
                <label htmlFor="nwCamp" className="mb-1.5 block text-[13px] font-semibold">
                  Campaign
                </label>
                <select
                  id="nwCamp"
                  value={campaignId}
                  onChange={(e) => {
                    setCampaignId(e.target.value);
                    setLines([]);
                  }}
                  className={controlClass(false)}
                >
                  {open.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {campaign && (
                  <p className="mt-1.5 text-xs text-muted">
                    Orders close {formatIsoDate(campaign.closesOn)}. Books arrive about {formatIsoDate(campaign.expectedArrivalOn)}.
                  </p>
                )}
              </div>
              {!isOther && dup && (
                <div role="status" className="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-sm text-warning">
                  {student?.fullName} already has {dup.reference} in this campaign. You can still create another order.{" "}
                  <a href={`/academy/books/orders/${dup.id}`} className="font-semibold">
                    View order
                  </a>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-border p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="font-bold">2. Add Books</p>
                <span className="relative block w-full max-w-[220px]">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                    <Icon name="search" width={16} height={16} />
                  </span>
                  <input type="search" value={bookQuery} onChange={(e) => setBookQuery(e.target.value)} aria-label="Filter books" placeholder="Filter books" className={`${controlClass(false)} !h-10 pl-9`} />
                </span>
              </div>
              {campaignBooks.length === 0 && <p className="py-4 text-sm text-[#4B5563]">No books match this filter.</p>}
              {campaignBooks.map(({ entry, book }, i) => {
                const line = lines.find((l) => l.bookId === book.id);
                const left = leftFor(entry);
                const blocked = !line && orderCurrency !== undefined && book.currency !== orderCurrency;
                const canAdd = !line && !blocked && left > 0;
                return (
                  <div key={book.id} className={`flex items-center gap-3 py-2.5 ${i ? "border-t border-border" : ""} ${blocked || (left <= 0 && !line) ? "opacity-55" : ""}`}>
                    <SubjectTile book={book} url={data.coverUrls[book.id]} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold [overflow-wrap:anywhere]">{book.name}</p>
                      <p className="text-xs text-muted">{[book.subject, book.classLevel].filter(Boolean).join(" · ") || "—"}</p>
                      {blocked && <p className="text-xs font-semibold text-warning">Different currency from this order</p>}
                      {entry.quantityLimit !== null && (
                        <p className="text-xs text-muted">
                          {left <= 0
                            ? `Limit reached: ${entry.quantityLimit} of ${entry.quantityLimit} copies ordered`
                            : `${Math.max(left - (line?.quantity ?? 0), 0)} of ${entry.quantityLimit} copies left`}
                        </p>
                      )}
                    </div>
                    <span className="text-sm font-semibold tabular-nums">{formatMoney(book.priceCents, book.currency)}</span>
                    {line ? (
                      <span className="flex items-center gap-2">
                        <button type="button" className={qtyBtn} onClick={() => setQty(book.id, line.quantity - 1)} aria-label={`Decrease ${book.name}`}>
                          −
                        </button>
                        <span className="w-6 text-center font-semibold tabular-nums">{line.quantity}</span>
                        <button type="button" className={qtyBtn} disabled={line.quantity >= left} onClick={() => setQty(book.id, line.quantity + 1)} aria-label={`Increase ${book.name}`}>
                          +
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!canAdd}
                        onClick={() => setLines((cur) => [...cur, { bookId: book.id, quantity: 1 }])}
                        className="h-10 min-w-[58px] rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-app disabled:cursor-not-allowed disabled:text-muted"
                      >
                        Add
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          </div>

          <aside className="self-start rounded-xl border border-border bg-surface p-4 shadow-card md:sticky md:top-0">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-bold">Order summary</p>
              <span className="font-mono text-[13px] text-[#374151]">{nextReference}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted">Reference is fixed once the order is saved.</p>
            <div className="mt-3 rounded-lg bg-app px-3 py-2.5 text-sm">
              {buyerOk || (isOther && otherName.trim()) ? (
                <>
                  <span className="block font-semibold">{buyerLabel}</span>
                  <span className="block text-xs text-muted">
                    {isOther
                      ? ["Other person", otherPhone.trim() || null, branch?.name ?? null].filter(Boolean).join(" · ")
                      : `${student!.studentNumber} · ${student!.branchName}`}
                  </span>
                </>
              ) : (
                <span className="text-muted">{isOther ? "Enter the buyer name" : "No student selected"}</span>
              )}
            </div>
            <div className="mt-2">
              {lines.length === 0 && <p className="py-5 text-center text-sm text-muted">No books added yet. Use Add on the book list.</p>}
              {lines.map((l) => {
                const book = bookById.get(l.bookId)!;
                return (
                  <div key={l.bookId} className="border-b border-border py-2.5 last:border-b-0">
                    <div className="flex justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="block font-semibold [overflow-wrap:anywhere]">{book.name}</span>
                        <span className="block text-xs text-muted">{formatMoney(book.priceCents, book.currency)} each</span>
                      </span>
                      <span className="font-semibold tabular-nums">{formatMoney(book.priceCents * l.quantity, book.currency)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <button type="button" className={qtyBtn} onClick={() => setQty(l.bookId, l.quantity - 1)} aria-label={`Decrease ${book.name}`}>
                          −
                        </button>
                        <span className="w-6 text-center font-semibold tabular-nums">{l.quantity}</span>
                        <button
                          type="button"
                          className={qtyBtn}
                          disabled={l.quantity >= leftFor(campaign!.books.find((b) => b.bookId === l.bookId)!)}
                          onClick={() => setQty(l.bookId, l.quantity + 1)}
                          aria-label={`Increase ${book.name}`}
                        >
                          +
                        </button>
                      </span>
                      <button type="button" onClick={() => setQty(l.bookId, 0)} className="text-sm font-semibold text-brand hover:underline">
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-sm">
              <div className="flex justify-between">
                <span>Subtotal ({plural(copies, "copy", "copies")})</span>
                <span className="tabular-nums">{formatMoney(pricing.subtotalCents, currency)}</span>
              </div>
              <label htmlFor="nwDisc" className="flex items-center justify-between gap-2">
                <span className="whitespace-nowrap">Discount (%)</span>
                <input
                  id="nwDisc"
                  type="text"
                  inputMode="numeric"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className={`${controlClass(Boolean(discountErr))} !h-10 !w-24 text-right`}
                  {...invalidProps("nwDisc", discountErr ?? undefined)}
                />
              </label>
              {pricing.discountAmountCents > 0 && <p className="text-right text-xs text-muted">Discount: − {formatMoney(pricing.discountAmountCents, currency)}</p>}
              {discountErr && (
                <p id="fe-nwDisc" role="alert" className="text-xs font-medium text-[#B91C1C]">
                  {discountErr}
                </p>
              )}
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-border pt-3">
              <span>
                <span className="block font-bold">Order Total</span>
                <span className="block text-xs text-muted">after discount</span>
              </span>
              <span className="text-[22px] font-bold tabular-nums text-ink">{formatMoney(pricing.totalCents, currency)}</span>
            </div>
          </aside>
        </div>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
        {missing && <span className="mr-auto text-xs text-muted">{missing}</span>}
        <button type="button" onClick={onCancel} className="h-11 rounded-lg border border-border-strong bg-surface px-[18px] font-medium text-ink hover:bg-app">
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave || pending}
          onClick={() => save(true)}
          className="h-11 rounded-lg border border-border-strong bg-surface px-4 font-semibold text-ink hover:bg-app disabled:opacity-50"
        >
          Save and Create Next Order
        </button>
        <button type="button" disabled={!canSave || pending} onClick={() => save(false)} className="h-11 min-w-[120px] rounded-lg bg-brand px-5 font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
          {pending ? "Saving…" : "Save Order"}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Payment                                                             */
/* ------------------------------------------------------------------ */

function MethodChips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <span role="radiogroup" aria-label="Payment method" className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-11 rounded-lg border px-3.5 text-sm font-semibold transition-colors duration-150 ${value === o.value ? "border-brand bg-brand-tint text-brand" : "border-border-strong bg-surface text-ink hover:bg-app"}`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

const REF_PLACEHOLDER: Record<PreorderPaymentMethod, string> = {
  cash: "Receipt number or note",
  mobile_money: "Transaction ID",
  bank_transfer: "Transfer reference",
  other: "Reference or note",
};

function PaymentForm({ initialOrderId, onCancel, onSaved }: { initialOrderId?: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const [orderId, setOrderId] = useState(initialOrderId ?? "");
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso);
  const [method, setMethod] = useState<PreorderPaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirmStep();

  const order = data.orders.find((o) => o.id === orderId);
  const q = search.trim().toLowerCase();
  const results = data.orders
    .filter((o) => o.balanceCents > 0 && (!q || buyerSearchText(o).includes(q)))
    .slice(0, 5);
  const cents = dollarsToCents(amount);

  function check(): boolean {
    const e: Record<string, string> = {};
    if (!order) e.order = "Choose an order first.";
    else if (cents === null || cents <= 0) e.amount = "Enter an amount above 0.";
    else if (cents > order.balanceCents) e.amount = `Amount is more than the Remaining Balance of ${formatMoney(order.balanceCents, order.currency)}.`;
    if (!paidOn) e.paidOn = "Choose the payment date.";
    else if (paidOn > todayIso()) e.paidOn = "Payment date can't be in the future.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const after = order && cents && cents > 0 && cents <= order.balanceCents ? order.balanceCents - cents : null;

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirm.step) {
          if (!check() || !order || cents === null) return;
          confirm.ask({
            title: "Record this payment?",
            body: `${formatMoney(cents, order.currency)} by ${PREORDER_PAYMENT_METHOD_LABEL[method].toLowerCase()} from ${order.buyerName} for ${order.reference}. Remaining Balance after this payment: ${formatMoney(order.balanceCents - cents, order.currency)}.`,
            label: "Record Payment",
          });
          return;
        }
        if (!order || cents === null) return;
        startTransition(async () => {
          try {
            const result = await recordPreorderPaymentAction({ idempotencyKey: key, orderId: order.id, amountCents: cents, method, reference, paidOn });
            if (!result.ok) {
              confirm.back();
              setBanner(result.error?.message ?? "The payment couldn't be recorded.");
              return;
            }
            const left = result.balanceCents ?? 0;
            showSuccessToast(`${formatMoney(cents, order.currency)} recorded for ${order.reference}${left > 0 ? `. Remaining Balance ${formatMoney(left, order.currency)}` : ". Paid in full"}`);
            onSaved();
          } catch {
            confirm.back();
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        {confirm.step ? (
          <ConfirmPanel title={confirm.step.title} body={confirm.step.body} />
        ) : (
          <>
            {!order ? (
              <DField label="Select Order" name="order" required error={errors.order} group full>
                <input
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, student ID, phone or order number"
                  aria-label="Search orders"
                  className={controlClass(Boolean(errors.order))}
                  {...invalidProps("order", errors.order)}
                />
                <span className="mt-2 block overflow-hidden rounded-xl border border-border font-normal">
                  {results.map((o, i) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setOrderId(o.id);
                        setErrors({});
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-app ${i ? "border-t border-border" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{o.reference}</span>
                        <span className="block text-xs text-muted">
                          {o.buyerName} · {buyerOf(o).id}
                        </span>
                      </span>
                      <span className="text-right text-sm font-semibold tabular-nums">
                        {formatMoney(o.balanceCents, o.currency)}
                        <span className="block text-xs font-normal text-muted">remaining</span>
                      </span>
                    </button>
                  ))}
                  {results.length === 0 && <span className="block px-3.5 py-3 text-sm text-muted">No order with an outstanding balance matches.</span>}
                </span>
              </DField>
            ) : (
              <>
                <div className="mb-4 rounded-xl bg-app px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block font-bold">{order.reference}</span>
                      <span className="block text-sm text-muted">
                        {order.buyerName} · {buyerOf(order).sub}
                      </span>
                    </span>
                    {!initialOrderId && (
                      <button type="button" onClick={() => setOrderId("")} className="h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold hover:bg-surface">
                        Change
                      </button>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <div className="text-xs text-muted">Order Total</div>
                      <b className="tabular-nums">{formatMoney(order.totalCents, order.currency)}</b>
                    </div>
                    <div>
                      <div className="text-xs text-muted">Amount Paid so far</div>
                      <b className="tabular-nums">{formatMoney(order.paidCents, order.currency)}</b>
                    </div>
                    <div>
                      <div className="text-xs text-muted">Remaining Balance</div>
                      <b className="tabular-nums text-danger">{formatMoney(order.balanceCents, order.currency)}</b>
                    </div>
                  </div>
                </div>
                <FieldGrid>
                  <DField label={`Amount Paid (${order.currency})`} name="amount" required error={errors.amount}>
                    <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={controlClass(Boolean(errors.amount))} {...invalidProps("amount", errors.amount)} />
                  </DField>
                  <DField label="Payment date" name="paidOn" required error={errors.paidOn}>
                    <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} className={controlClass(Boolean(errors.paidOn))} {...invalidProps("paidOn", errors.paidOn)} />
                  </DField>
                  <div className="col-span-full flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => setAmount(centsToDollars(order.balanceCents))} className="h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold hover:bg-app">
                      Pay full balance ({formatMoney(order.balanceCents, order.currency)})
                    </button>
                    {after !== null && <span className="text-sm text-[#374151]">{after === 0 ? "Order will be fully paid" : `Remaining Balance after payment: ${formatMoney(after, order.currency)}`}</span>}
                  </div>
                  <DField label="Payment Method" name="method" group full>
                    <MethodChips value={method} onChange={setMethod} options={PREORDER_PAYMENT_METHODS.map((m) => ({ value: m, label: PREORDER_PAYMENT_METHOD_LABEL[m] }))} />
                  </DField>
                  <DField label="Reference or note" name="reference" hint="Optional." full>
                    <input type="text" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={REF_PLACEHOLDER[method]} className={controlClass(false)} />
                  </DField>
                </FieldGrid>
                <p className="mt-3 text-xs text-muted">
                  Payments are recorded as unverified until staff verify them. Books are given only after the order is paid in full and every payment is
                  verified. No online payment is taken.
                </p>
              </>
            )}
          </>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={confirm.step ? confirm.back : onCancel}
        cancelLabel={confirm.step ? "Go back" : "Cancel"}
        submitLabel="Record Payment"
        pendingLabel="Recording…"
        pending={pending}
        disabled={!order}
      />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Receive books                                                       */
/* ------------------------------------------------------------------ */

function ReceiveForm({ initialCampaignId, initialBookId, onCancel, onSaved }: { initialCampaignId?: string; initialBookId?: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const campaigns = data.campaigns.filter((c) => RECEIVABLE_STATUSES.includes(c.status) && c.books.length > 0);
  const [campaignId, setCampaignId] = useState(campaigns.find((c) => c.id === initialCampaignId)?.id ?? campaigns[0]?.id ?? "");
  const campaign = campaigns.find((c) => c.id === campaignId);
  const [bookId, setBookId] = useState(initialBookId && campaign?.books.some((b) => b.bookId === initialBookId) ? initialBookId : (campaign?.books[0]?.bookId ?? ""));
  const [received, setReceived] = useState("");
  const [damaged, setDamaged] = useState("0");
  const [receivedOn, setReceivedOn] = useState(todayIso);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirmStep();

  const entry = campaign?.books.find((b) => b.bookId === bookId);
  const book = data.books.find((b) => b.id === bookId);
  const r = /^\d+$/.test(received.trim()) ? Number(received) : NaN;
  const d = /^\d+$/.test(damaged.trim()) ? Number(damaged) : NaN;

  function check(): boolean {
    const e: Record<string, string> = {};
    if (!campaign || !entry) e.book = "Choose a book.";
    if (!(r > 0)) e.received = "Enter the quantity received.";
    if (Number.isNaN(d) || d < 0) e.damaged = "Enter 0 or more.";
    else if (r > 0 && d > r) e.damaged = "Cannot be more than the quantity received.";
    if (!receivedOn) e.receivedOn = "Choose the date.";
    else if (receivedOn > todayIso()) e.receivedOn = "Date received can't be in the future.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  if (campaigns.length === 0) {
    return (
      <>
        <DialogBody>
          <p className="text-sm text-[#4B5563]">There is no campaign to receive books for. Receiving is recorded against a campaign with books; create or schedule one first.</p>
        </DialogBody>
        <DialogFooter onCancel={onCancel} submitLabel="Receive Books" disabled />
      </>
    );
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirm.step) {
          if (!check() || !book) return;
          const usable = r - d;
          confirm.ask({
            title: "Add these books to the campaign stock?",
            body: `Receive ${plural(r, "copy", "copies")} of ${book.name}${d ? `, including ${d} damaged` : ""}. ${plural(usable, "usable copy", "usable copies")} will be available to give to students. Stock for ordinary sales does not change.`,
            label: "Receive Books",
          });
          return;
        }
        startTransition(async () => {
          try {
            const result = await recordPreorderReceiptAction({ idempotencyKey: key, campaignId, bookId, quantityReceived: r, damagedQuantity: d, receivedOn, note });
            if (!result.ok) {
              confirm.back();
              setBanner(result.error?.message ?? "The delivery couldn't be recorded.");
              return;
            }
            showSuccessToast(`Received ${plural(r, "copy", "copies")}, ${d} damaged`);
            onSaved();
          } catch {
            confirm.back();
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        {confirm.step ? (
          <ConfirmPanel title={confirm.step.title} body={confirm.step.body} />
        ) : (
          <FieldGrid>
            <DField label="Campaign" name="campaign" full>
              <select
                value={campaignId}
                onChange={(e) => {
                  setCampaignId(e.target.value);
                  setBookId(campaigns.find((c) => c.id === e.target.value)?.books[0]?.bookId ?? "");
                }}
                className={controlClass(false)}
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </DField>
            <DField label="Book" name="book" required error={errors.book} full>
              <select value={bookId} onChange={(e) => setBookId(e.target.value)} className={controlClass(Boolean(errors.book))} {...invalidProps("book", errors.book)}>
                {campaign?.books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    {data.books.find((x) => x.id === b.bookId)?.name ?? "Book"}
                  </option>
                ))}
              </select>
              {entry && (
                <span className="text-xs font-normal text-muted">
                  {campaign?.name}. Ordered {entry.ordered}, usable received so far {entry.usable}
                  {entry.damaged ? ` (${entry.damaged} damaged)` : ""}.
                </span>
              )}
            </DField>
            <DField label="Quantity Received" name="received" required error={errors.received}>
              <input type="text" inputMode="numeric" value={received} onChange={(e) => setReceived(e.target.value)} className={controlClass(Boolean(errors.received))} {...invalidProps("received", errors.received)} />
            </DField>
            <DField label="Damaged Copies" name="damaged" error={errors.damaged}>
              <input type="text" inputMode="numeric" value={damaged} onChange={(e) => setDamaged(e.target.value)} className={controlClass(Boolean(errors.damaged))} {...invalidProps("damaged", errors.damaged)} />
            </DField>
            <DField label="Date Received" name="receivedOn" required error={errors.receivedOn}>
              <input type="date" value={receivedOn} max={todayIso()} onChange={(e) => setReceivedOn(e.target.value)} className={controlClass(Boolean(errors.receivedOn))} {...invalidProps("receivedOn", errors.receivedOn)} />
            </DField>
            <DField label="Note" name="note" hint="Optional." full>
              <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={controlClass(false)} />
            </DField>
            <p className="col-span-full text-xs text-muted">
              Damaged copies are included in Quantity Received but are not added to usable stock. Remaining equals Quantity Ordered minus usable copies.
            </p>
          </FieldGrid>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={confirm.step ? confirm.back : onCancel}
        cancelLabel={confirm.step ? "Go back" : "Cancel"}
        submitLabel="Receive Books"
        pendingLabel="Saving…"
        pending={pending}
      />
    </form>
  );
}

/** Exposed for section buttons that only need to open a dialog. */
export function ActionButton({
  dialog,
  children,
  variant = "primary",
  className = "",
  disabled,
  title,
}: {
  dialog: Dialog;
  children: ReactNode;
  variant?: "primary" | "secondary" | "gold" | "ghost-light";
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const { open } = useBooksActions();
  const styles = {
    primary: "bg-brand text-white hover:bg-brand-hover border-0",
    secondary: "border border-border-strong bg-surface text-ink hover:bg-app",
    gold: "border-0 bg-[#F5B638] text-ink font-bold shadow-[0_2px_8px_rgba(0,0,0,0.2)] hover:bg-[#FFC65A]",
    "ghost-light": "border border-white/55 bg-white/[0.08] text-white hover:bg-white/[0.18]",
  }[variant];
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => open(dialog)}
      className={`inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export { BookCover, FormSummary };
