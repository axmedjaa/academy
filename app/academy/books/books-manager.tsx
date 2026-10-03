"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import {
  confirmBookCoverUploadAction,
  createBookAction,
  requestBookCoverUploadUrlAction,
  requestNewBookCoverUploadUrlAction,
  updateBookAction,
} from "@/lib/academies/books-actions";
import { createBookSaleAction } from "@/lib/academies/book-sales-actions";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import { Badge, Button, ErrorMessage, Field, FormDialog, LinkButton, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { dollarsToCents } from "@/lib/ui/money";

const ALLOWED_COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_COVER_SIZE_BYTES = 5 * 1024 * 1024;

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

interface Props {
  books: BookRecord[];
  coverUrls: Record<string, string | null>;
  canManage: boolean;
  studentOptions: StudentPickerOption[];
}

interface NewBookForm {
  name: string;
  description: string;
  author: string;
  isbn: string;
  category: string;
  /** Entered in dollars (e.g. "10", "5.55") — converted to cents via
   * lib/ui/money.ts's dollarsToCents right before the action call, never
   * interpreted as raw cents. */
  priceDollars: string;
  stockQuantity: string;
}

const EMPTY_NEW_BOOK: NewBookForm = { name: "", description: "", author: "", isbn: "", category: "", priceDollars: "", stockQuantity: "" };

export function BooksManager({ books, coverUrls, canManage, studentOptions }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newBook, setNewBook] = useState<NewBookForm>(EMPTY_NEW_BOOK);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The new book's cover is uploaded to R2 as soon as a file is chosen
  // (before "Create book" is even clicked) — see requestNewBookCoverUploadUrl's
  // own doc comment for why this can happen before the book row exists.
  // `coverKey` only becomes non-null once the upload is confirmed in R2,
  // which is what "Create book" is gated on below.
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverKey, setCoverKey] = useState<string | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  const [sellingBookId, setSellingBookId] = useState<string | null>(null);

  const visibleBooks = books.filter((book) => {
    const q = search.trim().toLowerCase();
    if (q === "") return true;
    return (
      book.name.toLowerCase().includes(q) ||
      (book.isbn?.toLowerCase().includes(q) ?? false) ||
      (book.author?.toLowerCase().includes(q) ?? false)
    );
  });

  function resetAddForm() {
    setNewBook(EMPTY_NEW_BOOK);
    setShowAddForm(false);
    setCoverPreviewUrl(null);
    setCoverKey(null);
    setCoverError(null);
    if (coverFileInputRef.current) coverFileInputRef.current.value = "";
  }

  async function handleCoverFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCoverError(null);
    if (!ALLOWED_COVER_TYPES.includes(file.type)) {
      setCoverError("Cover must be JPEG, PNG, or WebP.");
      return;
    }
    if (file.size > MAX_COVER_SIZE_BYTES) {
      setCoverError("Cover must be 5 MB or smaller.");
      return;
    }
    setCoverUploading(true);
    setCoverKey(null);
    const requested = await requestNewBookCoverUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size });
    if (!requested.ok || !requested.uploadUrl || !requested.key) {
      setCoverUploading(false);
      setCoverError(requested.error?.message ?? "Failed to start cover upload.");
      return;
    }
    try {
      await uploadCoverFile(requested.uploadUrl, file);
    } catch (err) {
      setCoverUploading(false);
      setCoverError(err instanceof Error ? err.message : "Cover upload failed.");
      return;
    }
    setCoverUploading(false);
    setCoverKey(requested.key);
    setCoverPreviewUrl(URL.createObjectURL(file));
  }

  async function handleCreateBook() {
    setCreateError(null);
    const priceCents = dollarsToCents(newBook.priceDollars);
    const stockQuantity = Number(newBook.stockQuantity);
    if (!newBook.name.trim() || priceCents === null || !Number.isFinite(stockQuantity)) {
      setCreateError("Book name, price, and stock quantity are required.");
      return;
    }
    if (!coverKey) {
      setCreateError("A cover image is required before the book can be created.");
      return;
    }
    setCreating(true);
    const result = await createBookAction({
      name: newBook.name.trim(),
      description: newBook.description.trim() || undefined,
      author: newBook.author.trim() || undefined,
      isbn: newBook.isbn.trim() || undefined,
      category: newBook.category.trim() || undefined,
      priceCents,
      stockQuantity,
      coverRef: coverKey,
    });
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error?.message ?? "Failed to create book.");
      showErrorToast(result.error?.message ?? "Failed to create book.");
      return;
    }
    showSuccessToast("Book created.");
    resetAddForm();
    router.refresh();
  }

  return (
    <Section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          placeholder="Search books…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={`${inputClass} max-w-xs`}
        />
        {canManage && (
          <Button type="button" onClick={() => (showAddForm ? resetAddForm() : setShowAddForm(true))}>
            {showAddForm ? "Cancel" : "Add book"}
          </Button>
        )}
      </div>

      {canManage && showAddForm && (
        <div className="mb-6 rounded-card border border-border bg-app p-4">
          <h2 className="text-sm font-semibold text-ink">Add book</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Cover image (required)" className="sm:col-span-2">
              <div className="flex items-center gap-3">
                <div className="flex h-16 w-12 items-center justify-center overflow-hidden rounded border border-border bg-surface">
                  {coverPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, never uploaded anywhere else.
                    <img src={coverPreviewUrl} alt="Cover preview" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-muted">No cover</span>
                  )}
                </div>
                <div>
                  <label className="cursor-pointer text-sm text-brand hover:underline">
                    {coverUploading ? "Uploading..." : coverKey ? "Change image" : "Choose image"}
                    <input
                      ref={coverFileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={coverUploading}
                      onChange={handleCoverFileChange}
                    />
                  </label>
                  <p className="mt-1 text-xs text-muted">JPEG, PNG, or WebP, up to 5 MB. Every new book needs a cover.</p>
                  {coverError && <p className="mt-1 text-xs text-danger">{coverError}</p>}
                </div>
              </div>
            </Field>
            <Field label="Name">
              <input className={inputClass} value={newBook.name} onChange={(e) => setNewBook({ ...newBook, name: e.target.value })} />
            </Field>
            <Field label="Author (optional)">
              <input className={inputClass} value={newBook.author} onChange={(e) => setNewBook({ ...newBook, author: e.target.value })} />
            </Field>
            <Field label="Price (USD)">
              <input type="number" min={0} step="0.01" placeholder="0.00" className={inputClass} value={newBook.priceDollars} onChange={(e) => setNewBook({ ...newBook, priceDollars: e.target.value })} />
            </Field>
            <Field label="Stock quantity">
              <input type="number" min={0} className={inputClass} value={newBook.stockQuantity} onChange={(e) => setNewBook({ ...newBook, stockQuantity: e.target.value })} />
            </Field>
            <Field label="ISBN (optional)">
              <input className={inputClass} value={newBook.isbn} onChange={(e) => setNewBook({ ...newBook, isbn: e.target.value })} />
            </Field>
            <Field label="Category (optional)">
              <input className={inputClass} value={newBook.category} onChange={(e) => setNewBook({ ...newBook, category: e.target.value })} />
            </Field>
            <Field label="Description (optional)" className="sm:col-span-2">
              <textarea className={inputClass} rows={2} value={newBook.description} onChange={(e) => setNewBook({ ...newBook, description: e.target.value })} />
            </Field>
          </div>
          {createError && (
            <div className="mt-3">
              <ErrorMessage message={createError} />
            </div>
          )}
          <Button type="button" className="mt-3" disabled={creating || coverUploading || !coverKey} onClick={handleCreateBook}>
            {creating ? "Creating..." : "Create book"}
          </Button>
        </div>
      )}

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Cover</th>
            <th className={th}>Name</th>
            <th className={th}>Price</th>
            <th className={th}>Stock</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {visibleBooks.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 6 : 5} className={`${td} text-center text-muted`}>
                No books to show.
              </td>
            </tr>
          ) : (
            visibleBooks.map((book) => (
              <BookRow
                key={book.id}
                book={book}
                coverUrl={coverUrls[book.id] ?? null}
                canManage={canManage}
                studentOptions={studentOptions}
                isSelling={sellingBookId === book.id}
                onToggleSell={() => setSellingBookId((current) => (current === book.id ? null : book.id))}
                onDone={() => {
                  setSellingBookId(null);
                  router.refresh();
                }}
              />
            ))
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}

function uploadCoverFile(url: string, file: File): Promise<void> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((response) => {
    if (!response.ok) throw new Error(`The cover upload was rejected by storage (HTTP ${response.status}).`);
  });
}

interface RowProps {
  book: BookRecord;
  coverUrl: string | null;
  canManage: boolean;
  studentOptions: StudentPickerOption[];
  isSelling: boolean;
  onToggleSell: () => void;
  onDone: () => void;
}

function BookRow({ book, coverUrl, canManage, studentOptions, isSelling, onToggleSell, onDone }: RowProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  // Full-view preview, same pattern as the student photo preview in
  // app/academy/students/students-list.tsx — only ever opened by clicking
  // an actual cover thumbnail (see the button below), never for a "No
  // cover" placeholder.
  const [previewOpen, setPreviewOpen] = useState(false);

  async function handleCoverChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_COVER_TYPES.includes(file.type)) {
      showErrorToast("Cover must be JPEG, PNG, or WebP.");
      return;
    }
    if (file.size > MAX_COVER_SIZE_BYTES) {
      showErrorToast("Cover must be 5 MB or smaller.");
      return;
    }
    setUploading(true);
    const requested = await requestBookCoverUploadUrlAction(book.id, { contentType: file.type, fileSizeBytes: file.size });
    if (!requested.ok || !requested.uploadUrl || !requested.key) {
      setUploading(false);
      showErrorToast(requested.error?.message ?? "Failed to start cover upload.");
      return;
    }
    try {
      await uploadCoverFile(requested.uploadUrl, file);
    } catch (err) {
      setUploading(false);
      showErrorToast(err instanceof Error ? err.message : "Cover upload failed.");
      return;
    }
    const confirmed = await confirmBookCoverUploadAction(book.id, requested.key);
    setUploading(false);
    if (!confirmed.ok) {
      showErrorToast(confirmed.error?.message ?? "Failed to verify cover upload.");
      return;
    }
    showSuccessToast("Cover updated.");
    if (fileInputRef.current) fileInputRef.current.value = "";
    router.refresh();
  }

  async function handleToggleStatus() {
    setTogglingStatus(true);
    const nextStatus = book.status === "active" ? "inactive" : "active";
    const result = await updateBookAction(book.id, { status: nextStatus });
    setTogglingStatus(false);
    if (!result.ok) {
      showErrorToast(result.error?.message ?? "Failed to update book.");
      return;
    }
    showSuccessToast(nextStatus === "active" ? "Book activated." : "Book deactivated.");
    router.refresh();
  }

  return (
    <>
      <tr className={trHover}>
        <td className={td}>
          <div className="flex h-12 w-10 items-center justify-center overflow-hidden rounded border border-border bg-surface">
            {coverUrl ? (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                aria-label={`View ${book.name}'s cover`}
                className="block h-full w-full overflow-hidden transition-opacity duration-150 hover:opacity-90 motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL, same convention as academy-logo-upload.tsx. */}
                <img src={coverUrl} alt={`${book.name} cover`} className="h-full w-full object-cover" />
              </button>
            ) : (
              <span className="text-[10px] text-muted">No cover</span>
            )}
          </div>
          {canManage && (
            <label className="mt-1 block cursor-pointer text-[11px] text-brand hover:underline">
              {uploading ? "Uploading..." : "Change cover"}
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={uploading} onChange={handleCoverChange} />
            </label>
          )}
        </td>
        <td className={`${td} font-medium`}>
          {book.name}
          {book.author && <div className="text-xs text-muted">{book.author}</div>}
        </td>
        <td className={td}>{formatMoney(book.priceCents, book.currency)}</td>
        <td className={td}>{book.stockQuantity === 0 ? <span className="text-danger">Out of stock</span> : book.stockQuantity}</td>
        <td className={td}>
          <Badge label={book.status} tone={getStatusTone(book.status)} />
        </td>
        {canManage && (
          <td className={td}>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" disabled={book.status !== "active" || book.stockQuantity === 0} onClick={onToggleSell}>
                {isSelling ? "Cancel" : "Buy"}
              </Button>
              <Button type="button" variant="outline" className="px-2.5 py-1 text-xs" disabled={togglingStatus} onClick={handleToggleStatus}>
                {book.status === "active" ? "Deactivate" : "Activate"}
              </Button>
            </div>
          </td>
        )}
      </tr>
      {/* Mobile responsiveness fix: this used to render as a second <tr>
       * inside this table — but TableWrap's table has `min-w-[640px]` and
       * `overflow-x-auto`, so a form embedded in one of its cells inherited
       * that same horizontal scroll, forcing a phone user to scroll
       * sideways just to see/use the Buy form's own fields. A dialog
       * escapes the table's scroll container entirely (Radix portals its
       * content to the document body), so it's centered and full-width-
       * minus-margins on any screen size regardless of how wide the table
       * itself is. */}
      <FormDialog
        open={isSelling}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onToggleSell();
        }}
        title={`Buy — ${book.name}`}
        className="max-w-xl"
      >
        <SellForm book={book} studentOptions={studentOptions} onDone={onDone} onCancel={onToggleSell} />
      </FormDialog>
      {coverUrl && (
        <FormDialog open={previewOpen} onOpenChange={setPreviewOpen} title={`${book.name}'s cover`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL, same convention as academy-logo-upload.tsx. */}
          <img src={coverUrl} alt={`${book.name} cover`} className="max-h-[70vh] w-full rounded-md object-contain" />
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
          </div>
        </FormDialog>
      )}
    </>
  );
}

/** Local "now" formatted for a `datetime-local` input's default value. */
function nowForDateTimeLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function SellForm({
  book,
  studentOptions,
  onDone,
  onCancel,
}: {
  book: BookRecord;
  studentOptions: StudentPickerOption[];
  onDone: () => void;
  /** Closes the dialog without recording anything — the row's own toggle
   * (now that this form lives in a dialog, it needs its own visible
   * Cancel button rather than relying on the row's "Buy"/"Cancel" label
   * alone, same Save/Cancel pair convention as every other FormDialog
   * form in this app). */
  onCancel: () => void;
}) {
  const [buyerType, setBuyerType] = useState<"student" | "other_person">("student");
  const [studentId, setStudentId] = useState("");
  const [otherBuyerName, setOtherBuyerName] = useState("");
  const [otherBuyerPhone, setOtherBuyerPhone] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [discountType, setDiscountType] = useState<"none" | "fixed" | "percentage">("none");
  // For discountType "fixed" this is entered in DOLLARS (converted via
  // dollarsToCents below); for "percentage" it's a plain 0-100 number, not
  // a money amount at all, so it's never run through dollarsToCents.
  const [discountValue, setDiscountValue] = useState("0");
  /** Entered in dollars — see handleSubmit's dollarsToCents conversion. */
  const [amountPaidDollars, setAmountPaidDollars] = useState("");
  const [method, setMethod] = useState<"cash" | "mobile_money">("cash");
  const [reference, setReference] = useState("");
  /** The payment's transaction date — maps to bookSalePayments.paidAt
   * (already a schema column; only ever applied when a payment is actually
   * recorded now). Defaults to "now" but can be backdated, e.g. entering a
   * sale from a paper log. */
  const [paidAtLocal, setPaidAtLocal] = useState(() => nowForDateTimeLocal());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Set once the sale is recorded — switches this form over to a
   * confirmation state with an immediate "View Receipt" link (book sales
   * have no approval step, so the receipt exists the instant the sale
   * does — see lib/academies/book-sale-receipt-print.ts's module comment). */
  const [justCreatedSaleId, setJustCreatedSaleId] = useState<string | null>(null);

  const qty = Math.max(0, Number(quantity) || 0);
  const subtotalCents = book.priceCents * qty;
  const discountAmountCents =
    discountType === "fixed"
      ? Math.min(dollarsToCents(discountValue) ?? 0, subtotalCents)
      : discountType === "percentage"
        ? Math.round((subtotalCents * (Number(discountValue) || 0)) / 100)
        : 0;
  const finalAmountCents = Math.max(0, subtotalCents - discountAmountCents);

  async function handleSubmit() {
    setError(null);

    let discountValueCents = 0;
    if (discountType === "fixed") {
      const parsedDiscount = dollarsToCents(discountValue);
      if (parsedDiscount === null) {
        setError("Enter a valid discount amount.");
        return;
      }
      discountValueCents = parsedDiscount;
    }

    const paid = amountPaidDollars.trim() === "" ? 0 : dollarsToCents(amountPaidDollars);
    if (paid === null) {
      setError("Enter a valid amount paid.");
      return;
    }
    setSubmitting(true);
    const result = await createBookSaleAction({
      bookId: book.id,
      buyerType,
      studentId: buyerType === "student" ? studentId || undefined : undefined,
      otherBuyerName: buyerType === "other_person" ? otherBuyerName || undefined : undefined,
      otherBuyerPhone: buyerType === "other_person" ? otherBuyerPhone || undefined : undefined,
      quantity: qty,
      discountType,
      discountValue: discountType === "none" ? 0 : discountType === "percentage" ? Number(discountValue) || 0 : discountValueCents,
      amountPaidCents: paid,
      method: paid > 0 ? method : undefined,
      reference: reference || undefined,
      paidAt: paid > 0 && paidAtLocal ? new Date(paidAtLocal) : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to record sale.");
      showErrorToast(result.error?.message ?? "Failed to record sale.");
      return;
    }
    showSuccessToast("Sale recorded.");
    if (result.saleId) {
      // Stay open on a confirmation state (rather than immediately calling
      // onDone, which would collapse this row) so the receipt is reachable
      // in the same place the sale was just recorded — no need to scroll
      // down and relocate the row in the refreshed table.
      setJustCreatedSaleId(result.saleId);
    } else {
      onDone();
    }
  }

  if (justCreatedSaleId) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-control border border-border bg-surface p-3 text-sm">
        <span className="font-medium text-ink">Sale recorded.</span>
        <LinkButton href={`/academy/books/sales/${justCreatedSaleId}/receipt`} variant="secondary" className="px-2.5 py-1 text-xs" target="_blank">
          View Receipt
        </LinkButton>
        <div className="flex-1" />
        <Button type="button" variant="outline" className="px-2.5 py-1 text-xs" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label="Buyer type">
        <select className={inputClass} value={buyerType} onChange={(e) => setBuyerType(e.target.value as typeof buyerType)}>
          <option value="student">Student</option>
          <option value="other_person">Other person</option>
        </select>
      </Field>
      {buyerType === "student" ? (
        <Field label="Student" className="sm:col-span-2">
          <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} />
        </Field>
      ) : (
        <>
          <Field label="Buyer name">
            <input className={inputClass} value={otherBuyerName} onChange={(e) => setOtherBuyerName(e.target.value)} />
          </Field>
          <Field label="Buyer phone (optional)">
            <input className={inputClass} value={otherBuyerPhone} onChange={(e) => setOtherBuyerPhone(e.target.value)} />
          </Field>
        </>
      )}

      <Field label={`Quantity (max ${book.stockQuantity})`}>
        <input type="number" min={1} max={book.stockQuantity} className={inputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </Field>
      <Field label="Discount type">
        <select className={inputClass} value={discountType} onChange={(e) => setDiscountType(e.target.value as typeof discountType)}>
          <option value="none">None</option>
          <option value="fixed">Fixed amount (USD)</option>
          <option value="percentage">Percentage</option>
        </select>
      </Field>
      {discountType !== "none" && (
        <Field label={discountType === "fixed" ? "Discount (USD)" : "Discount (%)"}>
          <input
            type="number"
            min={0}
            step={discountType === "fixed" ? "0.01" : undefined}
            max={discountType === "percentage" ? 100 : undefined}
            placeholder={discountType === "fixed" ? "0.00" : undefined}
            className={inputClass}
            value={discountValue}
            onChange={(e) => setDiscountValue(e.target.value)}
          />
        </Field>
      )}

      <div className="sm:col-span-3 rounded-control border border-border bg-surface p-3 text-sm">
        <div className="flex justify-between">
          <span className="text-muted">Unit price</span>
          <span>{formatMoney(book.priceCents, book.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Subtotal</span>
          <span>{formatMoney(subtotalCents, book.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Discount</span>
          <span>-{formatMoney(discountAmountCents, book.currency)}</span>
        </div>
        <div className="flex justify-between font-semibold text-ink">
          <span>Final amount</span>
          <span>{formatMoney(finalAmountCents, book.currency)}</span>
        </div>
      </div>

      <Field label="Amount paid now (USD, 0.00 for unpaid)">
        <input type="number" min={0} step="0.01" placeholder="0.00" className={inputClass} value={amountPaidDollars} onChange={(e) => setAmountPaidDollars(e.target.value)} />
      </Field>
      <Field label="Payment method">
        <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="cash">Cash</option>
          <option value="mobile_money">Mobile money</option>
        </select>
      </Field>
      <Field label="Reference (optional)">
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Payment date">
        <input type="datetime-local" className={inputClass} value={paidAtLocal} onChange={(e) => setPaidAtLocal(e.target.value)} />
      </Field>

      {error && (
        <div className="sm:col-span-3">
          <ErrorMessage message={error} />
        </div>
      )}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="button" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Recording..." : "Buy"}
        </Button>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
