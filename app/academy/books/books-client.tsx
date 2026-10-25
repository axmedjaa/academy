"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BookRecord } from "@/lib/academies/books";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { getStockStatus } from "@/lib/academies/book-stock";
import {
  confirmBookCoverUploadAction,
  createBookAction,
  requestBookCoverUploadUrlAction,
  requestNewBookCoverUploadUrlAction,
  updateBookAction,
} from "@/lib/academies/books-actions";
import { addBookSalePaymentAction, createBookSaleAction, refundBookSaleAction } from "@/lib/academies/book-sales-actions";
import { MAX_RASTER_IMAGE_SIZE_BYTES, RASTER_IMAGE_ACCEPT_ATTRIBUTE, isRasterImageContentType } from "@/lib/storage/upload-policy";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, Button } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN, ROW_BTN_DANGER, ROW_BTN_PRIMARY } from "@/app/academy/_shell/page-blocks";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import {
  ActionDialog,
  ChoiceChips,
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  FormSummary,
  ReasonField,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

/**
 * Books client pieces (design A16). Every write is the existing books /
 * book-sales server action (permission, academy scope, stock and balance
 * rules, audit), so these only collect input and show the result.
 */

const BOOK_METHODS = [
  { value: "cash", label: "Cash", icon: "cash" },
  { value: "mobile_money", label: "Mobile money", icon: "phone" },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** "now" for a datetime-local input, in the browser's own time zone. */
function localNow(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function uploadCoverFile(url: string, file: File): Promise<void> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((response) => {
    if (!response.ok) throw new Error(`The cover upload was rejected by storage (HTTP ${response.status}).`);
  });
}

function coverProblem(file: File): string | null {
  if (!isRasterImageContentType(file.type)) return "The cover must be a JPEG, PNG, WebP or AVIF image.";
  if (file.size > MAX_RASTER_IMAGE_SIZE_BYTES) return "The cover must be 10 MB or smaller.";
  return null;
}

const STOCK_LABEL = { in_stock: "In stock", low_stock: "Low stock", out_of_stock: "Out of stock" } as const;
const STOCK_TONE = { in_stock: "green", low_stock: "amber", out_of_stock: "red" } as const;

export function StockBadge({ quantity, inactive }: { quantity: number; inactive?: boolean }) {
  if (inactive) return <Badge label="Inactive" tone="gray" />;
  const status = getStockStatus(quantity);
  return <Badge label={STOCK_LABEL[status]} tone={STOCK_TONE[status]} />;
}

/* ------------------------------------------------------------------ */
/* Add book                                                            */
/* ------------------------------------------------------------------ */

const amountRule = (name: string, label: string, allowZero = false): DesignFormRule => ({
  name,
  label,
  required: true,
  check: (value) => {
    const cents = dollarsToCents(value);
    return cents === null || (!allowZero && cents <= 0) ? `Enter ${label.toLowerCase().replace(/ \(usd\)/, "")}, for example 15.00.` : null;
  },
});

const BOOK_RULES: DesignFormRule[] = [
  { name: "coverKey", label: "Cover image", required: true, check: () => null },
  { name: "name", label: "Title", required: true },
  amountRule("priceDollars", "Price (USD)", true),
  {
    name: "stockQuantity",
    label: "Opening stock",
    required: true,
    check: (value) => (/^\d+$/.test(value.trim()) ? null : "Enter a whole number of copies, for example 20."),
  },
];

export function AddBookButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
        <Icon name="book" width={18} height={18} />
        Add book
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Add book" description="A cover image is required.">
        {open && (
          <AddBookForm
            onCancel={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
    </>
  );
}

function AddBookForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(BOOK_RULES);
  const [pending, startTransition] = useTransition();
  // The cover goes to storage as soon as it is chosen (before the book row
  // exists; see requestNewBookCoverUploadUrl). Create is allowed only once
  // the upload has finished and returned its key.
  const [coverKey, setCoverKey] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  async function chooseCover(file: File | undefined) {
    if (!file) return;
    const problem = coverProblem(file);
    setCoverError(problem);
    if (problem) return;
    setCoverUploading(true);
    setCoverKey(null);
    try {
      const requested = await requestNewBookCoverUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size });
      if (!requested.ok || !requested.uploadUrl || !requested.key) {
        setCoverError(requested.error?.message ?? "The cover upload couldn't start.");
        return;
      }
      await uploadCoverFile(requested.uploadUrl, file);
      setCoverKey(requested.key);
      setCoverPreview(URL.createObjectURL(file));
      // Re-check once the hidden key field has re-rendered.
      window.setTimeout(blur("coverKey"), 0);
    } catch (err) {
      setCoverError(err instanceof Error && !/fetch/i.test(err.message) ? err.message : NETWORK_ERROR_MESSAGE);
    } finally {
      setCoverUploading(false);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(
        (data) => {
          if (coverUploading) {
            setCoverError("Wait for the cover to finish uploading.");
            return false;
          }
          return validate(data);
        },
        (data) =>
          startTransition(async () => {
            const text = (name: string) => String(data.get(name) ?? "").trim() || undefined;
            try {
              const result = await createBookAction({
                name: String(data.get("name") ?? "").trim(),
                author: text("author"),
                isbn: text("isbn"),
                category: text("category"),
                description: text("description"),
                priceCents: dollarsToCents(String(data.get("priceDollars") ?? ""))!,
                stockQuantity: Number(data.get("stockQuantity")),
                coverRef: coverKey!,
              });
              if (!result.ok) {
                showServerError(result.error?.message ?? "The book couldn't be added.", [
                  [/name|title/i, "name"],
                  [/price/i, "priceDollars"],
                  [/stock/i, "stockQuantity"],
                  [/isbn/i, "isbn"],
                ]);
                return;
              }
              showSuccessToast("Book added.");
              onSaved();
            } catch {
              showServerError(NETWORK_ERROR_MESSAGE, []);
            }
          }),
      )}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Cover image" name="coverKey" required error={coverError ?? (errors.coverKey ? "Choose a cover image." : undefined)} full>
            <input type="hidden" name="coverKey" value={coverKey ?? ""} />
            <span className="flex items-center gap-3.5">
              <span className="flex h-[88px] w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-brand-tint to-[#E9C3CC] text-xs font-semibold text-brand">
                {coverPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local object URL preview of the chosen file.
                  <img src={coverPreview} alt="Cover preview" className="h-full w-full object-cover" />
                ) : (
                  "Cover"
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="relative inline-flex h-11 w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-brand px-3.5 text-sm font-semibold text-brand hover:bg-brand-tint">
                  <Icon name="upload" width={16} height={16} />
                  {coverUploading ? "Uploading…" : coverKey ? "Change image" : "Choose image"}
                  <input
                    type="file"
                    accept={RASTER_IMAGE_ACCEPT_ATTRIBUTE}
                    disabled={coverUploading}
                    onChange={(event) => chooseCover(event.target.files?.[0])}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    {...invalidProps("coverKey", coverError ?? errors.coverKey)}
                  />
                </span>
                <span className="text-xs font-normal text-muted">JPEG, PNG, WebP or AVIF, up to 10 MB.</span>
              </span>
            </span>
          </DField>
          <DField label="Title" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              maxLength={300}
              placeholder="Introduction to Web Development"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Author" name="author" hint="Optional.">
            <input type="text" name="author" maxLength={200} className={controlClass(false)} />
          </DField>
          <DField label="ISBN" name="isbn" error={errors.isbn} hint="Optional.">
            <input type="text" name="isbn" maxLength={50} placeholder="978-0-00-000000-0" className={controlClass(Boolean(errors.isbn))} />
          </DField>
          <DField label="Price (USD)" name="priceDollars" required error={errors.priceDollars}>
            <input
              type="text"
              inputMode="decimal"
              name="priceDollars"
              placeholder="0.00"
              onBlur={blur("priceDollars")}
              className={controlClass(Boolean(errors.priceDollars))}
              {...invalidProps("priceDollars", errors.priceDollars)}
            />
          </DField>
          <DField label="Opening stock" name="stockQuantity" required error={errors.stockQuantity}>
            <input
              type="text"
              inputMode="numeric"
              name="stockQuantity"
              placeholder="20"
              onBlur={blur("stockQuantity")}
              className={controlClass(Boolean(errors.stockQuantity))}
              {...invalidProps("stockQuantity", errors.stockQuantity)}
            />
          </DField>
          <DField label="Category" name="category" hint="Optional.">
            <input type="text" name="category" maxLength={100} placeholder="Textbook" className={controlClass(false)} />
          </DField>
          <DField label="Description" name="description" hint="Optional." full>
            <textarea name="description" rows={2} maxLength={2000} className={controlClass(false, true)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Add book" pendingLabel="Adding…" pending={pending} disabled={coverUploading} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Book card                                                           */
/* ------------------------------------------------------------------ */

export function BookCard({
  book,
  coverUrl,
  canManage,
  studentOptions,
}: {
  book: BookRecord;
  coverUrl: string | null;
  canManage: boolean;
  studentOptions: StudentPickerOption[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [toggling, startToggle] = useTransition();
  const [selling, setSelling] = useState(false);
  const [preview, setPreview] = useState(false);
  const inactive = book.status !== "active";
  const sellBlocked = inactive ? "This book is inactive." : book.stockQuantity === 0 ? "Out of stock." : null;

  async function changeCover(file: File | undefined) {
    if (!file) return;
    const problem = coverProblem(file);
    if (problem) return showErrorToast(problem);
    setUploading(true);
    try {
      const requested = await requestBookCoverUploadUrlAction(book.id, { contentType: file.type, fileSizeBytes: file.size });
      if (!requested.ok || !requested.uploadUrl || !requested.key) {
        showErrorToast(requested.error?.message ?? "The cover upload couldn't start.");
        return;
      }
      await uploadCoverFile(requested.uploadUrl, file);
      const confirmed = await confirmBookCoverUploadAction(book.id, requested.key);
      if (!confirmed.ok) {
        showErrorToast(confirmed.error?.message ?? "The cover couldn't be verified.");
        return;
      }
      showSuccessToast("Cover updated.");
      router.refresh();
    } catch (err) {
      showErrorToast(err instanceof Error && !/fetch/i.test(err.message) ? err.message : NETWORK_ERROR_MESSAGE);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function toggleStatus() {
    startToggle(async () => {
      try {
        const next = inactive ? "active" : "inactive";
        const result = await updateBookAction(book.id, { status: next });
        if (!result.ok) {
          showErrorToast(result.error?.message ?? "The book couldn't be updated.");
          return;
        }
        showSuccessToast(next === "active" ? "Book activated." : "Book deactivated.");
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const sub = [book.author, book.isbn ? `ISBN ${book.isbn}` : null].filter(Boolean).join(" · ");

  return (
    <article className={`flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-[18px] shadow-card ${inactive ? "opacity-80" : ""}`}>
      <div className="flex items-start gap-4">
        <button
          type="button"
          onClick={() => coverUrl && setPreview(true)}
          disabled={!coverUrl}
          aria-label={coverUrl ? `View the cover of ${book.name}` : undefined}
          className="flex h-[104px] w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-brand-tint to-[#E9C3CC] text-xl font-bold text-brand shadow-[inset_-4px_0_0_rgba(133,0,25,0.18),0_2px_6px_rgba(17,24,39,0.12)] disabled:cursor-default"
        >
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL.
            <img src={coverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(book.name)
          )}
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{book.name}</h3>
          {sub && <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">{sub}</p>}
          <p className="mt-2 text-lg font-bold tabular-nums text-ink">{formatMoney(book.priceCents, book.currency)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm ${book.stockQuantity === 0 ? "font-semibold text-danger" : "text-ink"}`}>
          {book.stockQuantity === 0 ? "Out of stock" : `${book.stockQuantity} in stock`}
        </span>
        <StockBadge quantity={book.stockQuantity} inactive={inactive} />
      </div>
      {canManage && (
        <div className="mt-auto flex flex-wrap gap-2">
          <button
            type="button"
            className={`${ROW_BTN_PRIMARY} flex-1 justify-center`}
            disabled={Boolean(sellBlocked)}
            title={sellBlocked ?? undefined}
            onClick={() => setSelling(true)}
          >
            <Icon name="cash" width={16} height={16} />
            Sell
          </button>
          <button type="button" className={`${ROW_BTN} flex-1 justify-center`} disabled={toggling} onClick={toggleStatus}>
            {toggling ? "Saving…" : inactive ? "Activate" : "Deactivate"}
          </button>
          <label className={`${ROW_BTN} relative w-full cursor-pointer justify-center border-dashed !text-brand`}>
            <Icon name="upload" width={16} height={16} />
            {uploading ? "Uploading…" : coverUrl ? "Change cover" : "Add cover"}
            <input
              ref={fileRef}
              type="file"
              accept={RASTER_IMAGE_ACCEPT_ATTRIBUTE}
              disabled={uploading}
              onChange={(event) => changeCover(event.target.files?.[0])}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label={`${coverUrl ? "Change" : "Add"} the cover of ${book.name}`}
            />
          </label>
        </div>
      )}

      <DesignDialog open={selling} onOpenChange={setSelling} title="Sell book" description="Price is calculated from the book's current price." width={640}>
        {selling && (
          <SellForm
            book={book}
            studentOptions={studentOptions}
            onCancel={() => setSelling(false)}
            onDone={() => {
              setSelling(false);
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
      {coverUrl && (
        <DesignDialog open={preview} onOpenChange={setPreview} title={book.name} description="Book cover">
          <DialogBody>
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL. */}
            <img src={coverUrl} alt={`Cover of ${book.name}`} className="mx-auto max-h-[65vh] rounded-lg object-contain" />
          </DialogBody>
        </DesignDialog>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Sell                                                                */
/* ------------------------------------------------------------------ */

function SellForm({
  book,
  studentOptions,
  onCancel,
  onDone,
}: {
  book: BookRecord;
  studentOptions: StudentPickerOption[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [buyerType, setBuyerType] = useState<"student" | "other_person">("student");
  const [studentId, setStudentId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [discountType, setDiscountType] = useState<"none" | "fixed" | "percentage">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [paid, setPaid] = useState("");
  const [paidAt] = useState(localNow);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity) : 0;
  const subtotal = book.priceCents * qty;
  const discount =
    discountType === "fixed"
      ? Math.min(dollarsToCents(discountValue) ?? 0, subtotal)
      : discountType === "percentage"
        ? Math.round((subtotal * Math.min(100, Number(discountValue) || 0)) / 100)
        : 0;
  const total = Math.max(0, subtotal - discount);

  const rules: DesignFormRule[] = [
    ...(buyerType === "student"
      ? [{ name: "studentId", label: "Student", required: true, kind: "select" as const }]
      : [{ name: "otherBuyerName", label: "Buyer name", required: true }]),
    {
      name: "quantity",
      label: "Quantity",
      required: true,
      check: (value) => {
        const n = /^\d+$/.test(value.trim()) ? Number(value) : 0;
        return n < 1 ? "Enter at least 1 copy." : n > book.stockQuantity ? `Only ${book.stockQuantity} in stock.` : null;
      },
    },
    ...(discountType === "none"
      ? []
      : [
          {
            name: "discountValue",
            label: "Discount",
            required: true,
            check: (value: string) =>
              discountType === "percentage"
                ? Number(value) >= 0 && Number(value) <= 100 && value.trim() !== ""
                  ? null
                  : "Enter a percentage from 0 to 100."
                : dollarsToCents(value) === null
                  ? "Enter the discount, for example 2.00."
                  : null,
          },
        ]),
    {
      name: "paidDollars",
      label: "Paid now",
      check: (value) => {
        if (value.trim() === "") return null;
        const cents = dollarsToCents(value);
        return cents === null ? "Enter the amount paid, for example 15.00." : cents > total ? "Paid now can't be more than the total." : null;
      },
    },
  ];
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(rules);

  if (saleId) {
    return (
      <>
        <DialogBody>
          <div className="flex items-start gap-3 rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] p-4 text-sm text-[#166534]">
            <Icon name="check_circle" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Sale recorded.</p>
              <p className="mt-1">The receipt is ready to print.</p>
            </div>
          </div>
        </DialogBody>
        <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
          <Link href={`/academy/books/sales/${saleId}/receipt`} target="_blank" className={`${ROW_BTN} h-11`}>
            <Icon name="receipt_long" width={16} height={16} />
            View receipt
          </Link>
          <button type="button" onClick={onDone} className="h-11 min-w-[120px] rounded-lg bg-brand px-5 font-semibold text-white hover:bg-brand-hover">
            Done
          </button>
        </div>
      </>
    );
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) =>
        startTransition(async () => {
          const paidCents = String(data.get("paidDollars") ?? "").trim() === "" ? 0 : dollarsToCents(String(data.get("paidDollars")))!;
          const text = (name: string) => String(data.get(name) ?? "").trim() || undefined;
          try {
            const result = await createBookSaleAction({
              bookId: book.id,
              buyerType,
              studentId: buyerType === "student" ? studentId : undefined,
              otherBuyerName: buyerType === "other_person" ? text("otherBuyerName") : undefined,
              otherBuyerPhone: buyerType === "other_person" ? text("otherBuyerPhone") : undefined,
              quantity: qty,
              discountType,
              discountValue:
                discountType === "none" ? 0 : discountType === "percentage" ? Number(discountValue) || 0 : (dollarsToCents(discountValue) ?? 0),
              amountPaidCents: paidCents,
              method: paidCents > 0 ? (String(data.get("method")) as "cash" | "mobile_money") : undefined,
              reference: text("reference"),
              paidAt: paidCents > 0 && data.get("paidAt") ? new Date(String(data.get("paidAt"))) : undefined,
            });
            if (!result.ok) {
              showServerError(result.error?.message ?? "The sale couldn't be recorded.", [
                [/student/i, "studentId"],
                [/buyer name/i, "otherBuyerName"],
                [/stock|quantity/i, "quantity"],
                [/discount|percentage/i, "discountValue"],
                [/amount|paid|method/i, "paidDollars"],
              ]);
              return;
            }
            showSuccessToast("Sale recorded.");
            if (result.saleId) setSaleId(result.saleId);
            else onDone();
          } catch {
            showServerError(NETWORK_ERROR_MESSAGE, []);
          }
        }),
      )}
    >
      <DialogBody>
        <FormSummary
          items={[
            { label: "Book", value: book.name },
            { label: "Unit price", value: formatMoney(book.priceCents, book.currency) },
            { label: "In stock", value: book.stockQuantity },
            { label: "Total", value: formatMoney(total, book.currency) },
          ]}
        />
        <FieldGrid>
          <DField label="Buyer" name="buyerType" group full>
            <ChoiceChips
              name="buyerType"
              defaultValue="student"
              onChange={(value) => setBuyerType(value as "student" | "other_person")}
              options={[
                { value: "student", label: "Student", icon: "group" },
                { value: "other_person", label: "Other person", icon: "user_plus" },
              ]}
            />
          </DField>
          {buyerType === "student" ? (
            <DField label="Student" name="studentId" required error={errors.studentId} full>
              <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} required />
            </DField>
          ) : (
            <>
              <DField label="Buyer name" name="otherBuyerName" required error={errors.otherBuyerName}>
                <input
                  type="text"
                  name="otherBuyerName"
                  maxLength={200}
                  onBlur={blur("otherBuyerName")}
                  className={controlClass(Boolean(errors.otherBuyerName))}
                  {...invalidProps("otherBuyerName", errors.otherBuyerName)}
                />
              </DField>
              <DField label="Buyer phone" name="otherBuyerPhone" hint="Optional.">
                <input type="tel" name="otherBuyerPhone" maxLength={40} placeholder="+252 63 400 0000" className={controlClass(false)} />
              </DField>
            </>
          )}
          <DField label="Quantity" name="quantity" required error={errors.quantity} hint={`${book.stockQuantity} in stock.`}>
            <input
              type="text"
              inputMode="numeric"
              name="quantity"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              onBlur={blur("quantity")}
              className={controlClass(Boolean(errors.quantity))}
              {...invalidProps("quantity", errors.quantity)}
            />
          </DField>
          <DField label="Discount" name="discountType">
            <select
              name="discountType"
              value={discountType}
              onChange={(event) => setDiscountType(event.target.value as typeof discountType)}
              className={controlClass(false)}
            >
              <option value="none">No discount</option>
              <option value="fixed">Fixed amount (USD)</option>
              <option value="percentage">Percentage</option>
            </select>
          </DField>
          {discountType !== "none" && (
            <DField label={discountType === "fixed" ? "Discount (USD)" : "Discount (%)"} name="discountValue" required error={errors.discountValue}>
              <input
                type="text"
                inputMode="decimal"
                name="discountValue"
                value={discountValue}
                onChange={(event) => setDiscountValue(event.target.value)}
                onBlur={blur("discountValue")}
                placeholder={discountType === "fixed" ? "0.00" : "10"}
                className={controlClass(Boolean(errors.discountValue))}
                {...invalidProps("discountValue", errors.discountValue)}
              />
            </DField>
          )}
          <DField label="Paid now (USD)" name="paidDollars" error={errors.paidDollars} hint="Leave empty for an unpaid sale.">
            <span className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                name="paidDollars"
                value={paid}
                onChange={(event) => setPaid(event.target.value)}
                onBlur={blur("paidDollars")}
                placeholder="0.00"
                className={controlClass(Boolean(errors.paidDollars))}
                {...invalidProps("paidDollars", errors.paidDollars)}
              />
              <button
                type="button"
                onClick={() => setPaid(centsToDollars(total))}
                className="h-11 shrink-0 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-app"
              >
                Full
              </button>
            </span>
          </DField>
          <DField label="Payment date" name="paidAt">
            <input type="datetime-local" name="paidAt" defaultValue={paidAt} className={controlClass(false)} />
          </DField>
          <DField label="Paid by" name="method" group>
            <ChoiceChips name="method" defaultValue="cash" options={BOOK_METHODS} />
          </DField>
          <DField label="Reference" name="reference" hint="Optional.">
            <input type="text" name="reference" maxLength={200} placeholder="Transaction number" className={controlClass(false)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Record sale" pendingLabel="Recording…" pending={pending} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Sale actions                                                        */
/* ------------------------------------------------------------------ */

export function SaleActions({ sale, canManage }: { sale: BookSaleListRow; canManage: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"payment" | "refund" | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const money = (cents: number) => formatMoney(cents, sale.currency);
  const buyer = sale.buyerType === "student" ? (sale.studentName ?? "Student") : (sale.otherBuyerName ?? "Other person");
  const close = () => {
    setMode(null);
    setPaymentId(null);
  };

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {canManage && sale.remainingCents > 0 && (
        <button type="button" className={ROW_BTN_PRIMARY} onClick={() => setMode("payment")}>
          <Icon name="cash" width={16} height={16} />
          Record payment
        </button>
      )}
      {canManage && sale.netPaidCents > 0 && (
        <button type="button" className={ROW_BTN_DANGER} onClick={() => setMode("refund")}>
          <Icon name="autorenew" width={16} height={16} />
          Refund
        </button>
      )}
      <Link href={`/academy/books/sales/${sale.id}/receipt`} target="_blank" className={ROW_BTN}>
        <Icon name="receipt_long" width={16} height={16} />
        Receipt
      </Link>

      <ActionDialog
        open={mode === "payment" && !paymentId}
        onOpenChange={(open) => !open && close()}
        title="Record sale payment"
        description="Book sale payments are cash or mobile money."
        summary={[
          { label: "Sale", value: `${sale.bookName} × ${sale.quantity}` },
          { label: "Buyer", value: buyer },
          { label: "Balance", value: money(sale.remainingCents) },
        ]}
        submitLabel="Record payment"
        pendingLabel="Recording…"
        rules={[
          {
            name: "amountDollars",
            label: "Amount (USD)",
            required: true,
            check: (value) => {
              const cents = dollarsToCents(value);
              return cents === null || cents <= 0
                ? "Enter an amount above zero."
                : cents > sale.remainingCents
                  ? `The balance is ${money(sale.remainingCents)}.`
                  : null;
            },
          },
        ]}
        run={async (data) => {
          try {
            const result = await addBookSalePaymentAction({
              bookSaleId: sale.id,
              amountCents: dollarsToCents(String(data.get("amountDollars") ?? ""))!,
              method: String(data.get("method")) as "cash" | "mobile_money",
              reference: String(data.get("reference") ?? "").trim() || undefined,
              paidAt: data.get("paidAt") ? new Date(String(data.get("paidAt"))) : undefined,
            });
            if (!result.ok) return result.error?.message ?? "The payment couldn't be recorded.";
            showSuccessToast("Payment recorded.");
            if (result.paymentId) setPaymentId(result.paymentId);
            else close();
            router.refresh();
            return null;
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => undefined}
      >
        {({ errors, blur }) => (
          <>
            <DField label="Amount (USD)" name="amountDollars" required error={errors.amountDollars}>
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                defaultValue={centsToDollars(sale.remainingCents)}
                onBlur={blur("amountDollars")}
                className={controlClass(Boolean(errors.amountDollars))}
                {...invalidProps("amountDollars", errors.amountDollars)}
              />
            </DField>
            <DField label="Payment date" name="paidAt">
              <input type="datetime-local" name="paidAt" defaultValue={localNow()} className={controlClass(false)} />
            </DField>
            <DField label="Paid by" name="method" group>
              <ChoiceChips name="method" defaultValue="cash" options={BOOK_METHODS} />
            </DField>
            <DField label="Reference" name="reference" hint="Optional.">
              <input type="text" name="reference" maxLength={200} className={controlClass(false)} />
            </DField>
          </>
        )}
      </ActionDialog>

      <DesignDialog open={paymentId !== null} onOpenChange={(open) => !open && close()} title="Payment recorded">
        <DialogBody>
          <p className="text-sm text-ink">This payment has its own receipt, separate from the sale&apos;s overall receipt.</p>
        </DialogBody>
        <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
          {paymentId && (
            <Link href={`/academy/books/sales/${sale.id}/payments/${paymentId}/receipt`} target="_blank" className={`${ROW_BTN} h-11`}>
              <Icon name="receipt_long" width={16} height={16} />
              Payment receipt
            </Link>
          )}
          <button type="button" onClick={close} className="h-11 min-w-[120px] rounded-lg bg-brand px-5 font-semibold text-white hover:bg-brand-hover">
            Done
          </button>
        </div>
      </DesignDialog>

      <ActionDialog
        open={mode === "refund"}
        onOpenChange={(open) => !open && close()}
        title="Refund sale"
        description="Money and returned copies are independent. A reason is required."
        summary={[
          { label: "Sale", value: `${sale.bookName} × ${sale.quantity}` },
          { label: "Buyer", value: buyer },
          { label: "Paid (net of refunds)", value: money(sale.netPaidCents) },
        ]}
        submitLabel="Confirm refund"
        pendingLabel="Refunding…"
        danger
        rules={[
          {
            name: "amountDollars",
            label: "Refund amount (USD)",
            required: true,
            check: (value) => {
              const cents = dollarsToCents(value);
              return cents === null || cents <= 0
                ? "Enter an amount above zero."
                : cents > sale.netPaidCents
                  ? `At most ${money(sale.netPaidCents)} can be refunded.`
                  : null;
            },
          },
          {
            name: "returnedQuantity",
            label: "Copies returned",
            check: (value) => {
              const n = value.trim() === "" ? 0 : /^\d+$/.test(value.trim()) ? Number(value) : -1;
              return n < 0 || n > sale.quantity ? `Enter 0 to ${sale.quantity}.` : null;
            },
          },
          { name: "reason", label: "Reason", required: true },
        ]}
        run={async (data) => {
          try {
            const result = await refundBookSaleAction({
              bookSaleId: sale.id,
              amountCents: dollarsToCents(String(data.get("amountDollars") ?? ""))!,
              returnedQuantity: Number(String(data.get("returnedQuantity") ?? "").trim() || 0),
              reason: String(data.get("reason") ?? "").trim(),
            });
            return result.ok ? null : (result.error?.message ?? "The refund couldn't be recorded.");
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => {
          showSuccessToast("Refund recorded.");
          close();
          router.refresh();
        }}
      >
        {({ errors, blur }) => (
          <>
            <DField label="Refund amount (USD)" name="amountDollars" required error={errors.amountDollars}>
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                defaultValue={centsToDollars(sale.netPaidCents)}
                onBlur={blur("amountDollars")}
                className={controlClass(Boolean(errors.amountDollars))}
                {...invalidProps("amountDollars", errors.amountDollars)}
              />
            </DField>
            <DField label="Copies returned" name="returnedQuantity" error={errors.returnedQuantity} hint="Returned copies go back into stock.">
              <input
                type="text"
                inputMode="numeric"
                name="returnedQuantity"
                defaultValue="0"
                onBlur={blur("returnedQuantity")}
                className={controlClass(Boolean(errors.returnedQuantity))}
                {...invalidProps("returnedQuantity", errors.returnedQuantity)}
              />
            </DField>
            <ReasonField errors={errors} blur={blur} placeholder="Wrong edition sold" />
          </>
        )}
      </ActionDialog>
    </span>
  );
}
