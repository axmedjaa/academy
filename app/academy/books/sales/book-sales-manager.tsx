"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { addBookSalePaymentAction, refundBookSaleAction } from "@/lib/academies/book-sales-actions";
import { Badge, Button, ErrorMessage, Field, LinkButton, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { centsToDollars, dollarsToCents } from "@/lib/ui/money";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

function buyerName(sale: BookSaleListRow): string {
  return sale.buyerType === "student" ? (sale.studentName ?? "Student") : (sale.otherBuyerName ?? "Other person");
}

/** Cash never shows a reference (there's nothing to reference); mobile
 * money shows it when one was recorded, "—" otherwise — the display rule
 * from this task's own payment-method/reference requirement. */
function paymentReferenceDisplay(sale: BookSaleListRow): string {
  if (!sale.latestPaymentMethod) return "—";
  if (sale.latestPaymentMethod === "cash") return "—";
  return sale.latestPaymentReference ?? "—";
}

function paymentMethodLabel(method: "cash" | "mobile_money" | null): string {
  if (!method) return "—";
  return method === "cash" ? "Cash" : "Mobile money";
}

interface Props {
  sales: BookSaleListRow[];
  canManage: boolean;
}

type PanelMode = "payment" | "refund" | null;

interface Filters {
  dateFrom: string;
  dateTo: string;
  bookId: string;
  buyerType: "" | "student" | "other_person";
  buyerQuery: string;
  paymentStatus: "" | "unpaid" | "partially_paid" | "paid";
  method: "" | "cash" | "mobile_money";
  recordedBy: string;
}

const EMPTY_FILTERS: Filters = {
  dateFrom: "",
  dateTo: "",
  bookId: "",
  buyerType: "",
  buyerQuery: "",
  paymentStatus: "",
  method: "",
  recordedBy: "",
};

export function BookSalesManager({ sales, canManage }: Props) {
  const router = useRouter();
  const [activeSaleId, setActiveSaleId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // Derived option lists come straight from the already-fetched `sales` —
  // no extra server round trip just to populate filter dropdowns.
  const bookOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const sale of sales) byId.set(sale.bookId, sale.bookName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sales]);

  const staffOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const sale of sales) byId.set(sale.recordedBy, sale.recordedByLabel);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sales]);

  const filteredSales = useMemo(() => {
    const buyerQuery = filters.buyerQuery.trim().toLowerCase();
    const dateFrom = filters.dateFrom ? new Date(filters.dateFrom) : null;
    // End-of-day so a "to" date is inclusive of sales made that day.
    const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`) : null;

    return sales.filter((sale) => {
      if (dateFrom && sale.createdAt < dateFrom) return false;
      if (dateTo && sale.createdAt > dateTo) return false;
      if (filters.bookId && sale.bookId !== filters.bookId) return false;
      if (filters.buyerType && sale.buyerType !== filters.buyerType) return false;
      if (filters.paymentStatus && sale.paymentStatus !== filters.paymentStatus) return false;
      if (filters.method && sale.latestPaymentMethod !== filters.method) return false;
      if (filters.recordedBy && sale.recordedBy !== filters.recordedBy) return false;
      if (buyerQuery && !buyerName(sale).toLowerCase().includes(buyerQuery)) return false;
      return true;
    });
  }, [sales, filters]);

  const hasActiveFilters = Object.values(filters).some((value) => value !== "");

  function openPanel(saleId: string, nextMode: PanelMode) {
    setActiveSaleId((current) => (current === saleId && mode === nextMode ? null : saleId));
    setMode(nextMode);
  }

  return (
    <Section>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="From">
          <input type="date" className={inputClass} value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" className={inputClass} value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
        </Field>
        <Field label="Book">
          <select className={inputClass} value={filters.bookId} onChange={(e) => setFilters({ ...filters, bookId: e.target.value })}>
            <option value="">All books</option>
            {bookOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buyer type">
          <select className={inputClass} value={filters.buyerType} onChange={(e) => setFilters({ ...filters, buyerType: e.target.value as Filters["buyerType"] })}>
            <option value="">All</option>
            <option value="student">Student</option>
            <option value="other_person">Other person</option>
          </select>
        </Field>
        <Field label="Buyer name">
          <input
            type="search"
            placeholder="Search buyer…"
            className={inputClass}
            value={filters.buyerQuery}
            onChange={(e) => setFilters({ ...filters, buyerQuery: e.target.value })}
          />
        </Field>
        <Field label="Payment status">
          <select className={inputClass} value={filters.paymentStatus} onChange={(e) => setFilters({ ...filters, paymentStatus: e.target.value as Filters["paymentStatus"] })}>
            <option value="">All</option>
            <option value="unpaid">Unpaid</option>
            <option value="partially_paid">Partially paid</option>
            <option value="paid">Paid</option>
          </select>
        </Field>
        <Field label="Payment method">
          <select className={inputClass} value={filters.method} onChange={(e) => setFilters({ ...filters, method: e.target.value as Filters["method"] })}>
            <option value="">All</option>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile money</option>
          </select>
        </Field>
        <Field label="Recorded by">
          <select className={inputClass} value={filters.recordedBy} onChange={(e) => setFilters({ ...filters, recordedBy: e.target.value })}>
            <option value="">All staff</option>
            {staffOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {hasActiveFilters && (
        <div className="mb-4">
          <Button type="button" variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        </div>
      )}

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Buyer</th>
            <th className={th}>Buyer type</th>
            <th className={th}>Book</th>
            <th className={th}>Qty</th>
            <th className={th}>Subtotal</th>
            <th className={th}>Discount</th>
            <th className={th}>Final amount</th>
            <th className={th}>Paid</th>
            <th className={th}>Remaining</th>
            <th className={th}>Method</th>
            <th className={th}>Reference</th>
            <th className={th}>Status</th>
            <th className={th}>Recorded by</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sales.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 15 : 14} className={`${td} text-center text-muted`}>
                No book sales yet.
              </td>
            </tr>
          ) : filteredSales.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 15 : 14} className={`${td} text-center text-muted`}>
                No sales match these filters.
              </td>
            </tr>
          ) : (
            filteredSales.map((sale) => (
              <Fragment key={sale.id}>
                <tr className={trHover}>
                  <td className={td}>{sale.createdAt.toLocaleDateString()}</td>
                  <td className={`${td} font-medium`}>{buyerName(sale)}</td>
                  <td className={td}>{sale.buyerType === "student" ? "Student" : "Other person"}</td>
                  <td className={td}>
                    {sale.bookName} × {sale.quantity}
                  </td>
                  <td className={td}>{sale.quantity}</td>
                  <td className={td}>{formatMoney(sale.subtotalCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.discountAmountCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.finalAmountCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.netPaidCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.remainingCents, sale.currency)}</td>
                  <td className={td}>{paymentMethodLabel(sale.latestPaymentMethod)}</td>
                  <td className={td}>{paymentReferenceDisplay(sale)}</td>
                  <td className={td}>
                    <div className="flex flex-col gap-1">
                      <Badge label={sale.paymentStatus.replace("_", " ")} tone={getStatusTone(sale.paymentStatus)} />
                      {sale.totalRefundedCents > 0 && <Badge label="Refunded" tone="slate" />}
                    </div>
                  </td>
                  <td className={td}>{sale.recordedByLabel}</td>
                  {canManage && (
                    <td className={`${td} text-right`}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Actions for sale to ${buyerName(sale)}`}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                          >
                            <Icon name="more" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem disabled={sale.remainingCents <= 0} onClick={() => openPanel(sale.id, "payment")}>
                            Record payment
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={sale.netPaidCents <= 0} onClick={() => openPanel(sale.id, "refund")}>
                            Refund
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <a href={`/academy/books/sales/${sale.id}/receipt`} target="_blank" rel="noreferrer">
                              View receipt
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a href={`/academy/books/sales/${sale.id}/receipt?autoprint=1`} target="_blank" rel="noreferrer">
                              Print receipt
                            </a>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
                {activeSaleId === sale.id && mode && (
                  <tr>
                    <td colSpan={canManage ? 15 : 14} className="border-b border-border bg-app px-4 py-4">
                      {mode === "payment" ? (
                        <PaymentPanel sale={sale} onDone={() => { setActiveSaleId(null); router.refresh(); }} />
                      ) : (
                        <RefundPanel sale={sale} onDone={() => { setActiveSaleId(null); router.refresh(); }} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}

/** Local "now" formatted for a `datetime-local` input's default value. */
function nowForDateTimeLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function PaymentPanel({ sale, onDone }: { sale: BookSaleListRow; onDone: () => void }) {
  // Defaults to the full remaining balance, entered/displayed in dollars —
  // see lib/ui/money.ts's centsToDollars/dollarsToCents.
  const [amountDollars, setAmountDollars] = useState(() => centsToDollars(sale.remainingCents));
  const [method, setMethod] = useState<"cash" | "mobile_money">("cash");
  const [reference, setReference] = useState("");
  const [paidAtLocal, setPaidAtLocal] = useState(() => nowForDateTimeLocal());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Set once this payment is recorded — switches to a confirmation state
   * with an immediate link to THIS payment's own receipt (distinct from
   * the sale's overall receipt — see the "Receipt for multiple payments"
   * requirement this satisfies: "Payment received now" must never be
   * conflated with "Total paid"). */
  const [justRecordedPaymentId, setJustRecordedPaymentId] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    const amount = dollarsToCents(amountDollars);
    if (amount === null || amount <= 0 || amount > sale.remainingCents) {
      setError(`Enter a valid amount, up to ${centsToDollars(sale.remainingCents)}.`);
      return;
    }
    setSubmitting(true);
    const result = await addBookSalePaymentAction({
      bookSaleId: sale.id,
      amountCents: amount,
      method,
      reference: reference || undefined,
      paidAt: paidAtLocal ? new Date(paidAtLocal) : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to record payment.");
      showErrorToast(result.error?.message ?? "Failed to record payment.");
      return;
    }
    showSuccessToast("Payment recorded.");
    if (result.paymentId) {
      setJustRecordedPaymentId(result.paymentId);
    } else {
      onDone();
    }
  }

  if (justRecordedPaymentId) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-control border border-border bg-surface p-3 text-sm">
        <span className="font-medium text-ink">Payment recorded.</span>
        <LinkButton
          href={`/academy/books/sales/${sale.id}/payments/${justRecordedPaymentId}/receipt`}
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          target="_blank"
        >
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
      <Field label={`Amount (USD, max ${centsToDollars(sale.remainingCents)})`}>
        <input
          type="number"
          min={0.01}
          step="0.01"
          max={sale.remainingCents / 100}
          className={inputClass}
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
        />
      </Field>
      <Field label="Method">
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
      <div className="sm:col-span-3">
        <Button type="button" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Recording..." : "Record payment"}
        </Button>
      </div>
    </div>
  );
}

function RefundPanel({ sale, onDone }: { sale: BookSaleListRow; onDone: () => void }) {
  // Defaults to the full net-paid amount, entered/displayed in dollars —
  // see lib/ui/money.ts's centsToDollars/dollarsToCents.
  const [amountDollars, setAmountDollars] = useState(() => centsToDollars(sale.netPaidCents));
  const [reason, setReason] = useState("");
  const [returnedQuantity, setReturnedQuantity] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    const amount = dollarsToCents(amountDollars);
    const returned = Number(returnedQuantity);
    if (amount === null || amount <= 0 || amount > sale.netPaidCents) {
      setError(`Enter a valid refund amount, up to ${centsToDollars(sale.netPaidCents)}.`);
      return;
    }
    if (!reason.trim()) {
      setError("A refund reason is required.");
      return;
    }
    setSubmitting(true);
    const result = await refundBookSaleAction({ bookSaleId: sale.id, amountCents: amount, reason: reason.trim(), returnedQuantity: returned });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to process refund.");
      showErrorToast(result.error?.message ?? "Failed to process refund.");
      return;
    }
    showSuccessToast("Refund recorded.");
    onDone();
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label={`Refund amount (USD, max ${centsToDollars(sale.netPaidCents)})`}>
        <input
          type="number"
          min={0.01}
          step="0.01"
          max={sale.netPaidCents / 100}
          className={inputClass}
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
        />
      </Field>
      <Field label={`Returned quantity (max ${sale.quantity})`}>
        <input type="number" min={0} max={sale.quantity} className={inputClass} value={returnedQuantity} onChange={(e) => setReturnedQuantity(e.target.value)} />
      </Field>
      <Field label="Reason" className="sm:col-span-1">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && (
        <div className="sm:col-span-3">
          <ErrorMessage message={error} />
        </div>
      )}
      <div className="sm:col-span-3">
        <Button type="button" variant="danger" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Processing..." : "Confirm refund"}
        </Button>
      </div>
    </div>
  );
}
