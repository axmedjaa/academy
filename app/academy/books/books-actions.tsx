"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import type { BookBranchOption, BookStudentOption } from "@/lib/academies/book-orders";
import {
  BOOK_ORDER_PAYMENT_METHODS,
  BOOK_ORDER_PAYMENT_METHOD_LABEL,
  type BookOrderPaymentMethod,
  type BookOrderStatus,
} from "@/lib/academies/book-order-math";
import { createBookOrderAction, issueBooksAction, recordBookOrderPaymentAction, updateBookOrderDiscountAction } from "@/lib/academies/book-orders-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { dollarsToCents, formatMoney } from "@/lib/ui/money";
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
import { StudentPicker } from "@/app/academy/_shell/student-picker";
import { AddBookForm, EditBookForm, SellForm, type BookSuggestions } from "./books-client";
import { formatIsoDate, initials, plural, tileOf, todayIso } from "./books-view";

/**
 * Book Management actions. One provider in the Books layout owns every
 * dialog, so the hero, the section action button and each section's
 * buttons all open the same forms: Add / Edit Book, Sell Book, and the
 * order workflow — Create Order for a Student or an Other Buyer (with an
 * optional first payment), record the buyer's Payment against an order, and
 * Give Books. Each form
 * only collects input: the server action re-validates and recomputes
 * everything (permission, branch, totals, stock) and is the only authority.
 * Writes carry a fresh idempotency key per form, so a double click or a
 * retried request cannot save twice.
 */

/** An order, as the payment and issue forms need it. */
export interface OrderPick {
  id: string;
  orderNumber: number;
  buyerName: string;
  studentId: string | null;
  studentNumber: string | null;
  orderDate: string;
  status: BookOrderStatus;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  items: { id: string; bookId: string; bookName: string; quantity: number; quantityReceived: number; issuedQuantity: number }[];
}

export interface BooksClientData {
  /** Student / other-person book orders and their payments (Books "manage"). */
  canManageOrders: boolean;
  /** Issue books to students of the caller's branches. */
  canIssue: boolean;
  /** Catalogue edits (books.ts's own canManage). */
  canManageBooks: boolean;
  /** Ordinary sales (book-sales.ts's own canManage). */
  canSell: boolean;
  books: BookRecord[];
  coverUrls: Record<string, string>;
  orders: OrderPick[];
  students: BookStudentOption[];
  /** Branches an other-person order can belong to (caller's scope). */
  branches: BookBranchOption[];
  suggestions: BookSuggestions;
}

type Dialog =
  | { kind: "addBook" }
  | { kind: "editBook"; bookId: string }
  | { kind: "viewBook"; bookId: string }
  | { kind: "sell"; bookId?: string }
  | { kind: "order"; studentId?: string }
  | { kind: "pay"; orderId?: string }
  | { kind: "issue"; orderId: string }
  | { kind: "discount"; orderId: string };

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
  order: "Create Order",
  pay: "Record payment",
  issue: "Give books",
  discount: "Change discount",
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
      ? "The cover image is optional."
      : kind === "sell"
        ? "The book is in stock now. Stock goes down when the sale is saved."
        : kind === "order"
          ? "Books bought by a student or another buyer, at the book prices. Books are given once the order is fully paid and in stock."
          : kind === "pay"
            ? "Money the buyer paid the academy for this order (income). Partial payments are fine."
            : kind === "issue"
              ? "Only a fully paid order can be given, from books in stock."
              : kind === "discount"
                ? "The total can't go below what the buyer has already paid."
                : undefined;
  const width = kind === "order" ? 720 : kind === "sell" ? 640 : 560;

  return (
    <Ctx.Provider value={value}>
      {children}
      <DesignDialog open={dialog !== null} onOpenChange={(o) => !o && close()} title={kind ? DIALOG_TITLE[kind] : ""} description={description} width={width}>
        <div className="contents text-sm">
        {kind === "addBook" && <AddBookForm suggestions={data.suggestions} onCancel={close} onSaved={done} />}
        {kind === "editBook" && book && <EditBookForm book={book} coverUrl={data.coverUrls[book.id] ?? null} suggestions={data.suggestions} onCancel={close} onSaved={done} />}
        {kind === "viewBook" && book && <BookView book={book} onClose={close} onEdit={() => setDialog({ kind: "editBook", bookId: book.id })} />}
        {kind === "sell" && <SellBookForm initialBookId={dialog?.kind === "sell" ? dialog.bookId : undefined} onCancel={close} onDone={done} />}
        {kind === "order" && (
          <BookOrderForm
            initialStudentId={dialog?.kind === "order" ? dialog.studentId : undefined}
            onCancel={close}
            onSaved={(orderId) => {
              setDialog(null);
              if (orderId) router.push(`/academy/books/orders/${orderId}`);
              else router.refresh();
            }}
          />
        )}
        {kind === "pay" && <BookOrderPaymentForm initialOrderId={dialog?.kind === "pay" ? dialog.orderId : undefined} onCancel={close} onSaved={done} />}
        {kind === "discount" && dialog?.kind === "discount" && <OrderDiscountForm orderId={dialog.orderId} onCancel={close} onSaved={done} />}
        {kind === "issue" && dialog?.kind === "issue" && <IssueBooksForm orderId={dialog.orderId} onCancel={close} onSaved={done} />}
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
 * Issue Books): the form validates, then the summary is confirmed. */
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
  const onOrder = data.orders.filter((o) => o.status === "ordered" && o.items.some((i) => i.bookId === book.id)).length;
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
            <p className="mt-1 text-sm text-[#374151]">{plural(book.stockQuantity, "copy", "copies")} in stock</p>
            {onOrder > 0 && <p className="mt-0.5 text-xs text-muted">{plural(onOrder, "order is", "orders are")} waiting to be received.</p>}
          </div>
        </div>
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
                {b.name}
              </option>
            ))}
          </select>
        </DField>
        {sellable.length === 0 && <p className="mt-2 text-sm text-muted">No active book has copies in stock. Create an order instead.</p>}
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
        <SellForm key={book.id} book={book} studentOptions={studentOptions} branchOptions={data.branches} onCancel={onCancel} onDone={onDone} />
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
/* Create Order: a Student or an Other Buyer                           */
/* ------------------------------------------------------------------ */

interface OrderLine {
  key: string;
  bookId: string;
  quantity: string;
}

type BuyerType = "student" | "other_person";

/** Step 1 of Create Order: who is buying. Two large, plain choices. */
function BuyerTypeChoice({ onChoose }: { onChoose: (type: BuyerType) => void }) {
  const choices: { type: BuyerType; icon: string; title: string; sub: string }[] = [
    { type: "student", icon: "group", title: "Student", sub: "Already registered as a student in this academy." },
    { type: "other_person", icon: "user_plus", title: "Other buyer", sub: "Not a registered student: a parent, teacher, visitor or anyone else." },
  ];
  return (
    <fieldset>
      <legend className="mb-3 text-base font-bold text-ink">Who is buying these books?</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {choices.map((c) => (
          <button
            key={c.type}
            type="button"
            onClick={() => onChoose(c.type)}
            className="flex min-h-[88px] items-start gap-3 rounded-xl border border-border-strong bg-surface p-4 text-left transition-colors duration-150 hover:border-brand hover:bg-brand-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
              <Icon name={c.icon} width={20} height={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold text-ink">{c.title}</span>
              <span className="mt-0.5 block text-sm leading-snug text-muted">{c.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Create Order: first "Who is buying these books?" (Student or Other buyer),
 * then only that buyer's fields, the books and quantities, an optional
 * discount and an optional payment received now. "Review order" shows the
 * summary; "Save order" sends it. Every figure shown is a preview: the server
 * re-checks the buyer, prices every line from the book's current price and
 * recomputes the totals and the balance. One idempotency key per form, so a
 * double click can't save twice.
 */
function BookOrderForm({ initialStudentId, onCancel, onSaved }: { initialStudentId?: string; onCancel: () => void; onSaved: (orderId?: string) => void }) {
  const { data } = useBooksActions();
  const [buyerType, setBuyerType] = useState<BuyerType | null>(initialStudentId ? "student" : null);
  const [studentId, setStudentId] = useState(initialStudentId ?? "");
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [branchId, setBranchId] = useState(data.branches.length === 1 ? data.branches[0].id : "");
  const [orderDate, setOrderDate] = useState(todayIso);
  const [notes, setNotes] = useState("");
  const [discountType, setDiscountType] = useState<"none" | "fixed" | "percentage">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [lines, setLines] = useState<OrderLine[]>([{ key: newKey(), bookId: "", quantity: "1" }]);
  const [payNow, setPayNow] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<BookOrderPaymentMethod>("cash");
  const [payReference, setPayReference] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirmStep();
  const studentOptions = useMemo(
    () => data.students.map((s) => ({ id: s.id, fullName: s.fullName, studentNumber: s.studentNumber, phone: s.phone })),
    [data.students],
  );

  const student = data.students.find((s) => s.id === studentId);
  const orderable = data.books.filter((b) => b.status === "active");
  const bookOf = (id: string) => orderable.find((b) => b.id === id);
  const parsed = lines.map((line) => {
    const quantity = /^\d+$/.test(line.quantity.trim()) ? Number(line.quantity.trim()) : null;
    const book = bookOf(line.bookId);
    return { ...line, quantityN: quantity, book, lineCents: book && quantity !== null ? quantity * book.priceCents : null };
  });
  const currency = parsed.find((line) => line.book)?.book?.currency ?? orderable[0]?.currency ?? "USD";
  const subtotal = parsed.reduce((sum, line) => sum + (line.lineCents ?? 0), 0);
  const discount =
    discountType === "fixed"
      ? Math.min(dollarsToCents(discountValue) ?? 0, subtotal)
      : discountType === "percentage"
        ? Math.round((subtotal * Math.min(100, Number(discountValue) || 0)) / 100)
        : 0;
  const total = Math.max(0, subtotal - discount);
  const payCents = payNow ? dollarsToCents(payAmount) : 0;
  const paidNow = payNow && payCents !== null && payCents > 0 ? payCents : 0;
  const balance = Math.max(0, total - paidNow);
  const copies = parsed.reduce((sum, line) => sum + (line.quantityN ?? 0), 0);
  const m = (cents: number) => formatMoney(cents, currency);
  const setLine = (k: string, patch: Partial<OrderLine>) => setLines((current) => current.map((line) => (line.key === k ? { ...line, ...patch } : line)));
  const buyerLabel = buyerType === "student" ? (student?.fullName ?? "") : buyerName.trim();

  function check(): boolean {
    const e: Record<string, string> = {};
    if (buyerType === "student" && !studentId) e.studentId = "Choose a student.";
    if (buyerType === "other_person") {
      if (!buyerName.trim()) e.buyerName = "Enter the buyer's full name.";
      if (buyerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail.trim())) e.buyerEmail = "Enter a valid email address, or leave it empty.";
      if (data.branches.length > 1 && !branchId) e.branchId = "Choose the branch.";
    }
    if (!orderDate) e.orderDate = "Choose the order date.";
    else if (orderDate > todayIso()) e.orderDate = "The order date can't be in the future.";
    const chosen = new Set<string>();
    parsed.forEach((line, i) => {
      if (!line.book) e[`book-${i}`] = "Choose a book.";
      else if (chosen.has(line.bookId)) e[`book-${i}`] = "This book is already on the order.";
      chosen.add(line.bookId);
      if (line.quantityN === null || line.quantityN < 1) e[`qty-${i}`] = "Enter 1 or more.";
    });
    if (discountType === "fixed" && (dollarsToCents(discountValue) === null || (dollarsToCents(discountValue) ?? 0) < 0)) e.discountValue = "Enter the discount, for example 2.00.";
    if (discountType === "percentage") {
      const pct = Number(discountValue);
      if (!/^\d+$/.test(discountValue.trim()) || pct > 100) e.discountValue = "Enter a whole percentage from 0 to 100.";
    }
    if (payNow) {
      if (payCents === null || payCents <= 0) e.payAmount = "Enter the amount received, above 0.";
      else if (payCents > total) e.payAmount = `That is more than the order total of ${m(total)}.`;
      if (!paidOn) e.paidOn = "Choose the payment date.";
      else if (paidOn > todayIso()) e.paidOn = "The payment date can't be in the future.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  if (!buyerType) {
    return (
      <>
        <DialogBody>
          <BuyerTypeChoice onChoose={setBuyerType} />
        </DialogBody>
        <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
          <button type="button" onClick={onCancel} className="h-11 rounded-lg border border-border-strong bg-surface px-[18px] font-medium text-ink hover:bg-app">
            Cancel
          </button>
        </div>
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
          if (!check()) return;
          confirm.ask({ title: "Save this order?", body: null, label: "Save order" });
          return;
        }
        startTransition(async () => {
          try {
            const result = await createBookOrderAction({
              idempotencyKey: key,
              buyerType,
              studentId: buyerType === "student" ? studentId : undefined,
              buyerName: buyerType === "other_person" ? buyerName : undefined,
              buyerPhone: buyerType === "other_person" ? buyerPhone : undefined,
              buyerEmail: buyerType === "other_person" ? buyerEmail : undefined,
              branchId: buyerType === "other_person" ? branchId : undefined,
              orderDate,
              notes,
              items: parsed.map((line) => ({ bookId: line.bookId, quantity: line.quantityN ?? 0 })),
              discountType,
              discountValue: discountType === "none" ? 0 : discountType === "percentage" ? Number(discountValue) || 0 : (dollarsToCents(discountValue) ?? 0),
              payment: paidNow > 0 ? { amountCents: paidNow, method: payMethod, reference: payReference, paidOn } : undefined,
            });
            if (!result.ok) {
              confirm.back();
              setBanner(result.error?.message ?? "The order couldn't be saved.");
              return;
            }
            showSuccessToast(`Order saved for ${buyerLabel}: ${m(total)}${paidNow > 0 ? `, ${m(paidNow)} paid` : ""}.`);
            onSaved(result.id);
          } catch {
            confirm.back();
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        {confirm.step ? (
          <div className="flex flex-col gap-4">
            <ConfirmPanel title="Check the order, then save" body="Creating the order doesn't change stock. Books are given from Give Books once the order is fully paid." />
            <FormSummary
              items={[
                { label: buyerType === "student" ? "Student" : "Other buyer", value: buyerLabel + (buyerType === "student" && student ? ` (${student.studentNumber})` : "") },
                { label: "Books", value: plural(copies, "copy", "copies") },
                { label: "Order total", value: m(total) },
                { label: "Paid now", value: m(paidNow) },
                { label: "Balance", value: m(balance) },
              ]}
            />
            <div className="overflow-hidden rounded-xl border border-border">
              {parsed.map((line) => (
                <div key={line.key} className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {line.quantityN} × {line.book?.name}
                  </span>
                  <span className="font-semibold tabular-nums">{line.lineCents !== null ? m(line.lineCents) : "—"}</span>
                </div>
              ))}
              {discount > 0 && (
                <div className="flex items-center justify-between gap-3 border-t border-border px-3.5 py-2.5">
                  <span>Discount</span>
                  <span className="font-semibold tabular-nums">−{m(discount)}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-app px-3.5 py-2.5">
              <span className="text-sm">
                Buyer: <b>{buyerType === "student" ? "Student" : "Other buyer"}</b>
              </span>
              {!initialStudentId && (
                <button type="button" onClick={() => setBuyerType(null)} className="min-h-11 rounded-lg px-2 text-sm font-semibold text-brand hover:bg-brand-tint">
                  Change
                </button>
              )}
            </div>
            <FieldGrid>
              {buyerType === "student" ? (
                <>
                  <DField label="Student" name="studentId" required error={errors.studentId} full hint="Search by name, student number or phone.">
                    <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} required />
                  </DField>
                  {student && (
                    <div className="col-span-full grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border px-3.5 py-3 text-sm sm:grid-cols-4">
                      <div className="min-w-0">
                        <div className="text-xs text-muted">Name</div>
                        <div className="font-semibold [overflow-wrap:anywhere]">{student.fullName}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted">Student ID</div>
                        <div className="font-semibold tabular-nums">{student.studentNumber}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs text-muted">Branch</div>
                        <div className="font-semibold [overflow-wrap:anywhere]">{student.branchName}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs text-muted">Phone</div>
                        <div className="font-semibold [overflow-wrap:anywhere]">{student.phone ?? "—"}</div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <DField label="Full name" name="buyerName" required error={errors.buyerName} full>
                    <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} maxLength={200} autoComplete="off" className={controlClass(Boolean(errors.buyerName))} {...invalidProps("buyerName", errors.buyerName)} />
                  </DField>
                  <DField label="Phone (optional)" name="buyerPhone">
                    <input type="tel" value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} maxLength={40} placeholder="+252 63 400 0000" className={controlClass(false)} />
                  </DField>
                  <DField label="Email (optional)" name="buyerEmail" error={errors.buyerEmail}>
                    <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} maxLength={200} className={controlClass(Boolean(errors.buyerEmail))} {...invalidProps("buyerEmail", errors.buyerEmail)} />
                  </DField>
                  {data.branches.length > 1 && (
                    <DField label="Branch" name="branchId" required error={errors.branchId} full>
                      <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={controlClass(Boolean(errors.branchId))} {...invalidProps("branchId", errors.branchId)}>
                        <option value="">Choose a branch</option>
                        {data.branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </DField>
                  )}
                </>
              )}
              <DField label="Order date" name="orderDate" required error={errors.orderDate}>
                <input type="date" value={orderDate} max={todayIso()} onChange={(e) => setOrderDate(e.target.value)} className={controlClass(Boolean(errors.orderDate))} {...invalidProps("orderDate", errors.orderDate)} />
              </DField>
            </FieldGrid>

            <p className="mb-2 mt-5 text-[13px] font-semibold text-ink">Books</p>
            {orderable.length === 0 && <p className="mb-2 text-sm text-muted">Add a book to the catalogue first.</p>}
            <div className="flex flex-col gap-3">
              {parsed.map((line, i) => (
                <div key={line.key} className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,2fr)_90px_auto]">
                  <div className="col-span-2 sm:col-span-1">
                    <DField label="Book" name={`book-${i}`} required error={errors[`book-${i}`]}>
                      <select value={line.bookId} onChange={(e) => setLine(line.key, { bookId: e.target.value })} className={controlClass(Boolean(errors[`book-${i}`]))} {...invalidProps(`book-${i}`, errors[`book-${i}`])}>
                        <option value="">Choose a book</option>
                        {orderable.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </DField>
                    {line.book && (
                      // Shown once a book is chosen (the dropdown lists names only).
                      <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted">
                        <span
                          className={`font-semibold ${
                            line.book.stockQuantity === 0
                              ? "text-[#B91C1C]"
                              : line.quantityN !== null && line.quantityN > line.book.stockQuantity
                                ? "text-warning"
                                : "text-success"
                          }`}
                        >
                          {line.book.stockQuantity === 0 ? "Out of stock" : `${line.book.stockQuantity} in stock`}
                        </span>
                        <span>{m(line.book.priceCents)} each</span>
                      </p>
                    )}
                  </div>
                  <DField label="Quantity" name={`qty-${i}`} required error={errors[`qty-${i}`]}>
                    <input inputMode="numeric" value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} className={controlClass(Boolean(errors[`qty-${i}`]))} {...invalidProps(`qty-${i}`, errors[`qty-${i}`])} />
                  </DField>
                  <div className="flex items-end justify-between gap-3 sm:flex-col sm:items-end">
                    <span className="text-sm font-semibold tabular-nums">{line.lineCents !== null ? m(line.lineCents) : "—"}</span>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))} className="min-h-11 text-xs font-semibold text-[#B91C1C] hover:underline">
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLines((current) => [...current, { key: newKey(), bookId: "", quantity: "1" }])}
              className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 font-semibold text-ink hover:bg-app"
            >
              Add another book
            </button>

            <FieldGrid>
              <DField label="Discount" name="discountType">
                <select value={discountType} onChange={(e) => setDiscountType(e.target.value as typeof discountType)} className={controlClass(false)}>
                  <option value="none">No discount</option>
                  <option value="fixed">Fixed amount ({currency})</option>
                  <option value="percentage">Percentage</option>
                </select>
              </DField>
              {discountType !== "none" && (
                <DField label={discountType === "fixed" ? `Discount (${currency})` : "Discount (%)"} name="discountValue" required error={errors.discountValue}>
                  <input
                    inputMode="decimal"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === "fixed" ? "0.00" : "10"}
                    className={controlClass(Boolean(errors.discountValue))}
                    {...invalidProps("discountValue", errors.discountValue)}
                  />
                </DField>
              )}
              <DField label="Notes (optional)" name="notes" full>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className={controlClass(false)} />
              </DField>
            </FieldGrid>

            <p className="mb-2 mt-5 text-[13px] font-semibold text-ink">Payment</p>
            <MethodChips<"later" | "now">
              label="Payment"
              value={payNow ? "now" : "later"}
              onChange={(v) => setPayNow(v === "now")}
              options={[
                { value: "later", label: "No payment yet" },
                { value: "now", label: "Payment received now" },
              ]}
            />
            {payNow && (
              <FieldGrid>
                <DField label={`Amount received (${currency})`} name="payAmount" required error={errors.payAmount} hint={total > 0 ? `Order total ${m(total)}. Part payments are fine.` : undefined}>
                  <div className="flex gap-2">
                    <input inputMode="decimal" placeholder="0.00" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className={controlClass(Boolean(errors.payAmount))} {...invalidProps("payAmount", errors.payAmount)} />
                    {total > 0 && (
                      <button type="button" onClick={() => setPayAmount((total / 100).toFixed(2))} className="min-h-11 shrink-0 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-app">
                        Full amount
                      </button>
                    )}
                  </div>
                </DField>
                <DField label="Payment date" name="paidOn" required error={errors.paidOn}>
                  <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} className={controlClass(Boolean(errors.paidOn))} {...invalidProps("paidOn", errors.paidOn)} />
                </DField>
                <DField label="Payment method" name="payMethod" required group full>
                  <MethodChips value={payMethod} onChange={setPayMethod} options={BOOK_ORDER_PAYMENT_METHODS.map((pm) => ({ value: pm, label: BOOK_ORDER_PAYMENT_METHOD_LABEL[pm] }))} />
                </DField>
                <DField label="Payment reference (optional)" name="payReference" full>
                  <input value={payReference} onChange={(e) => setPayReference(e.target.value)} maxLength={200} placeholder="Receipt number or transaction ID" className={controlClass(false)} />
                </DField>
              </FieldGrid>
            )}

            <div className="mt-4">
              <FormSummary
                items={[
                  { label: "Subtotal", value: m(subtotal) },
                  { label: "Discount", value: m(discount) },
                  { label: "Order total", value: m(total) },
                  { label: "Paid now", value: m(paidNow) },
                  { label: "Balance", value: m(balance) },
                ]}
              />
            </div>
          </>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={confirm.step ? confirm.back : onCancel}
        cancelLabel={confirm.step ? "Go back" : "Cancel"}
        submitLabel={confirm.step ? "Save order" : "Review order"}
        pendingLabel="Saving…"
        pending={pending}
        disabled={orderable.length === 0}
      />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Book Payments (from the buyer)                                      */
/* ------------------------------------------------------------------ */

function MethodChips<T extends string>({ value, onChange, options, label = "Payment method" }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label?: string }) {
  return (
    <span role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
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

function BookOrderPaymentForm({ initialOrderId, onCancel, onSaved }: { initialOrderId?: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const payable = data.orders.filter((o) => o.status !== "cancelled" && o.outstandingCents > 0);
  const [orderId, setOrderId] = useState(initialOrderId && payable.some((o) => o.id === initialOrderId) ? initialOrderId : "");
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso);
  const [method, setMethod] = useState<BookOrderPaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirmStep();

  const order = payable.find((o) => o.id === orderId);
  const q = search.trim().toLowerCase();
  const options = payable.filter((o) => !q || `#${o.orderNumber} ${o.buyerName} ${o.studentNumber ?? ""}`.toLowerCase().includes(q) || o.id === orderId);
  const cents = dollarsToCents(amount);

  function check(): boolean {
    const e: Record<string, string> = {};
    if (!order) e.order = "Choose an order.";
    else if (cents === null || cents <= 0) e.amount = "Enter an amount above 0.";
    else if (cents > order.outstandingCents) e.amount = `That is more than the outstanding balance of ${formatMoney(order.outstandingCents, order.currency)}.`;
    if (!paidOn) e.paidOn = "Choose the payment date.";
    else if (paidOn > todayIso()) e.paidOn = "The payment date can't be in the future.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

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
            body: `${formatMoney(cents, order.currency)} from ${order.buyerName} by ${BOOK_ORDER_PAYMENT_METHOD_LABEL[method].toLowerCase()}. Outstanding after this payment: ${formatMoney(order.outstandingCents - cents, order.currency)}.`,
            label: "Record payment",
          });
          return;
        }
        if (!order || cents === null) return;
        startTransition(async () => {
          try {
            const result = await recordBookOrderPaymentAction({ idempotencyKey: key, orderId: order.id, amountCents: cents, method, reference, paidOn });
            if (!result.ok) {
              confirm.back();
              setBanner(result.error?.message ?? "The payment couldn't be recorded.");
              return;
            }
            const left = order.outstandingCents - cents;
            showSuccessToast(`${formatMoney(cents, order.currency)} recorded from ${order.buyerName}${left > 0 ? `. Outstanding ${formatMoney(left, order.currency)}` : ". Fully paid"}.`);
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
            <DField label="Order" name="order" required error={errors.order} full>
              {payable.length > 8 && (
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search order number, buyer or student number"
                  aria-label="Search orders"
                  className={`${controlClass(false)} mb-2`}
                />
              )}
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={controlClass(Boolean(errors.order))} {...invalidProps("order", errors.order)}>
                <option value="">{payable.length ? "Choose an order with a balance" : "No order has a balance to pay"}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.orderNumber} · {o.buyerName}
                    {o.studentNumber ? ` (${o.studentNumber})` : ""} · {formatIsoDate(o.orderDate)} · {formatMoney(o.outstandingCents, o.currency)} outstanding
                  </option>
                ))}
              </select>
            </DField>
            {order && (
              <div className="col-span-full">
                <FormSummary
                  items={[
                    { label: "Order total", value: formatMoney(order.totalCents, order.currency) },
                    { label: "Paid so far", value: formatMoney(order.paidCents, order.currency) },
                    { label: "Outstanding", value: formatMoney(order.outstandingCents, order.currency) },
                  ]}
                />
              </div>
            )}
            <DField label={`Amount paid (${order?.currency ?? "USD"})`} name="amount" required error={errors.amount}>
              <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className={controlClass(Boolean(errors.amount))} {...invalidProps("amount", errors.amount)} />
            </DField>
            <DField label="Payment date" name="paidOn" required error={errors.paidOn}>
              <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} className={controlClass(Boolean(errors.paidOn))} {...invalidProps("paidOn", errors.paidOn)} />
            </DField>
            <DField label="Payment method" name="method" required group full>
              <MethodChips value={method} onChange={setMethod} options={BOOK_ORDER_PAYMENT_METHODS.map((m) => ({ value: m, label: BOOK_ORDER_PAYMENT_METHOD_LABEL[m] }))} />
            </DField>
            <DField label="Payment reference (optional)" name="reference" full>
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} placeholder="Receipt number or transaction ID" className={controlClass(false)} />
            </DField>
          </FieldGrid>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={confirm.step ? confirm.back : onCancel}
        cancelLabel={confirm.step ? "Go back" : "Cancel"}
        submitLabel={confirm.step ? confirm.step.label : "Continue"}
        pendingLabel="Saving…"
        pending={pending}
        disabled={payable.length === 0}
      />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Give books for a fully paid request                                 */
/* ------------------------------------------------------------------ */

function IssueBooksForm({ orderId, onCancel, onSaved }: { orderId: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const order = data.orders.find((o) => o.id === orderId);
  const open = order ? order.items.filter((i) => i.quantity > i.issuedQuantity) : [];
  const [bookId, setBookId] = useState(open.length === 1 ? open[0].bookId : "");
  const [quantity, setQuantity] = useState(open.length === 1 ? String(open[0].quantity - open[0].issuedQuantity) : "1");
  const [issuedOn, setIssuedOn] = useState(todayIso);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();
  if (!order) return null;

  const fullyPaid = order.outstandingCents === 0;
  const choices = open.map((i) => {
    const stock = data.books.find((b) => b.id === i.bookId)?.stockQuantity ?? 0;
    const left = i.quantity - i.issuedQuantity;
    return { id: i.bookId, name: i.bookName, left, stock, max: Math.min(left, stock) };
  });
  const choice = choices.find((c) => c.id === bookId);
  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : null;

  function check(): boolean {
    const e: Record<string, string> = {};
    if (!choice) e.book = "Choose a book.";
    if (qty === null || qty < 1) e.quantity = "Enter 1 or more.";
    else if (choice && qty > choice.left) e.quantity = `Only ${choice.left} left to give on this order.`;
    else if (choice && qty > choice.stock) e.quantity = `Only ${plural(choice.stock, "copy", "copies")} in stock.`;
    if (!issuedOn) e.issuedOn = "Choose the date.";
    else if (issuedOn > todayIso()) e.issuedOn = "The date can't be in the future.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!fullyPaid || !check() || !choice || qty === null) return;
        startTransition(async () => {
          try {
            const result = await issueBooksAction({ idempotencyKey: key, orderId: order.id, bookId: choice.id, quantity: qty, issuedOn, notes });
            if (!result.ok) {
              setBanner(result.error?.message ?? "The books couldn't be given.");
              return;
            }
            showSuccessToast(`${plural(qty, "copy", "copies")} of ${choice.name} given to ${order.buyerName}.`);
            onSaved();
          } catch {
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        <FormSummary
          items={[
            { label: "Buyer", value: order.buyerName },
            { label: "Paid", value: `${formatMoney(order.paidCents, order.currency)} of ${formatMoney(order.totalCents, order.currency)}` },
            { label: "Payment", value: fullyPaid ? "Fully paid" : `${formatMoney(order.outstandingCents, order.currency)} outstanding` },
          ]}
        />
        {!fullyPaid ? (
          <p role="alert" className="mt-4 rounded-xl border border-[#F0CDD5] bg-brand-tint px-4 py-3 text-sm text-ink">
            Books can be given only when the order is fully paid. Record the remaining payment first.
          </p>
        ) : (
          <FieldGrid>
            <DField label="Book" name="book" required error={errors.book} full>
              <select value={bookId} onChange={(e) => setBookId(e.target.value)} className={controlClass(Boolean(errors.book))} {...invalidProps("book", errors.book)}>
                <option value="">{choices.length ? "Choose a book" : "Every book on this order was given"}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.left} to give, {c.stock} in stock)
                  </option>
                ))}
              </select>
            </DField>
            <DField label="Quantity" name="quantity" required error={errors.quantity} hint={choice ? `Up to ${choice.max}.` : undefined}>
              <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={controlClass(Boolean(errors.quantity))} {...invalidProps("quantity", errors.quantity)} />
            </DField>
            <DField label="Date given" name="issuedOn" required error={errors.issuedOn}>
              <input type="date" value={issuedOn} max={todayIso()} onChange={(e) => setIssuedOn(e.target.value)} className={controlClass(Boolean(errors.issuedOn))} {...invalidProps("issuedOn", errors.issuedOn)} />
            </DField>
            <DField label="Notes (optional)" name="notes" full hint="You are recorded as the staff member who gave the books.">
              <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className={controlClass(false)} />
            </DField>
          </FieldGrid>
        )}
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Give books" pendingLabel="Saving…" pending={pending} disabled={!fullyPaid || choices.length === 0 || choices.every((c) => c.max === 0)} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Change an order's discount                                          */
/* ------------------------------------------------------------------ */

function OrderDiscountForm({ orderId, onCancel, onSaved }: { orderId: string; onCancel: () => void; onSaved: () => void }) {
  const { data } = useBooksActions();
  const order = data.orders.find((o) => o.id === orderId);
  const [discountType, setDiscountType] = useState<"none" | "fixed" | "percentage">(order && order.discountCents > 0 ? "fixed" : "none");
  const [discountValue, setDiscountValue] = useState(order && order.discountCents > 0 ? (order.discountCents / 100).toFixed(2) : "");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!order) return null;

  const subtotal = order.subtotalCents;
  const fixedCents = dollarsToCents(discountValue);
  const pct = /^\d+$/.test(discountValue.trim()) ? Number(discountValue.trim()) : null;
  const discount =
    discountType === "fixed" ? Math.min(fixedCents ?? 0, subtotal) : discountType === "percentage" ? Math.round((subtotal * Math.min(100, pct ?? 0)) / 100) : 0;
  const total = Math.max(0, subtotal - discount);
  const m = (cents: number) => formatMoney(cents, order.currency);

  function check(): boolean {
    let e: string | null = null;
    if (discountType === "fixed" && (fixedCents === null || fixedCents < 0)) e = "Enter the discount, for example 2.00.";
    else if (discountType === "percentage" && (pct === null || pct > 100)) e = "Enter a whole percentage from 0 to 100.";
    else if (total < order!.paidCents) e = `The buyer has already paid ${m(order!.paidCents)}, so the total can't go below that.`;
    setError(e);
    return e === null;
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!check()) return;
        startTransition(async () => {
          try {
            const result = await updateBookOrderDiscountAction({
              orderId: order.id,
              discountType,
              discountValue: discountType === "none" ? 0 : discountType === "percentage" ? (pct ?? 0) : (fixedCents ?? 0),
            });
            if (!result.ok) {
              setBanner(result.error?.message ?? "The discount couldn't be saved.");
              return;
            }
            showSuccessToast(`Discount saved. Order total is now ${m(total)}.`);
            onSaved();
          } catch {
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Discount" name="discountType">
            <select value={discountType} onChange={(e) => setDiscountType(e.target.value as typeof discountType)} className={controlClass(false)}>
              <option value="none">No discount</option>
              <option value="fixed">Fixed amount ({order.currency})</option>
              <option value="percentage">Percentage</option>
            </select>
          </DField>
          {discountType !== "none" && (
            <DField label={discountType === "fixed" ? `Discount (${order.currency})` : "Discount (%)"} name="discountValue" required error={error ?? undefined}>
              <input
                inputMode="decimal"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountType === "fixed" ? "0.00" : "10"}
                className={controlClass(Boolean(error))}
                {...invalidProps("discountValue", error ?? undefined)}
              />
            </DField>
          )}
        </FieldGrid>
        {discountType === "none" && error && <p role="alert" className="mt-2 text-xs font-medium text-[#B91C1C]">{error}</p>}
        <div className="mt-4">
          <FormSummary
            items={[
              { label: "Subtotal", value: m(subtotal) },
              { label: "Discount", value: m(discount) },
              { label: "New total", value: m(total) },
              { label: "Already paid", value: m(order.paidCents) },
            ]}
          />
        </div>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Save discount" pendingLabel="Saving…" pending={pending} />
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
