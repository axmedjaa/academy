"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import { addBookSalePaymentAction, refundBookSaleAction } from "@/lib/academies/book-sales-actions";
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { centsToDollars, dollarsToCents } from "@/lib/ui/money";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

interface Props {
  sales: BookSaleListRow[];
  canManage: boolean;
}

type PanelMode = "payment" | "refund" | null;

export function BookSalesManager({ sales, canManage }: Props) {
  const router = useRouter();
  const [activeSaleId, setActiveSaleId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>(null);

  function openPanel(saleId: string, nextMode: PanelMode) {
    setActiveSaleId((current) => (current === saleId && mode === nextMode ? null : saleId));
    setMode(nextMode);
  }

  return (
    <Section>
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Buyer</th>
            <th className={th}>Book</th>
            <th className={th}>Qty</th>
            <th className={th}>Final amount</th>
            <th className={th}>Paid</th>
            <th className={th}>Remaining</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sales.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 9 : 8} className={`${td} text-center text-muted`}>
                No book sales yet.
              </td>
            </tr>
          ) : (
            sales.map((sale) => (
              <Fragment key={sale.id}>
                <tr className={trHover}>
                  <td className={td}>{sale.createdAt.toLocaleDateString()}</td>
                  <td className={`${td} font-medium`}>{sale.buyerType === "student" ? sale.studentName ?? "Student" : sale.otherBuyerName ?? "Other person"}</td>
                  <td className={td}>
                    {sale.bookName} × {sale.quantity}
                  </td>
                  <td className={td}>{sale.quantity}</td>
                  <td className={td}>{formatMoney(sale.finalAmountCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.netPaidCents, sale.currency)}</td>
                  <td className={td}>{formatMoney(sale.remainingCents, sale.currency)}</td>
                  <td className={td}>
                    <div className="flex flex-col gap-1">
                      <Badge label={sale.paymentStatus.replace("_", " ")} tone={getStatusTone(sale.paymentStatus)} />
                      {sale.totalRefundedCents > 0 && <Badge label="Refunded" tone="slate" />}
                    </div>
                  </td>
                  {canManage && (
                    <td className={td}>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" disabled={sale.remainingCents <= 0} onClick={() => openPanel(sale.id, "payment")}>
                          Record payment
                        </Button>
                        <Button type="button" variant="outline" className="px-2.5 py-1 text-xs" disabled={sale.netPaidCents <= 0} onClick={() => openPanel(sale.id, "refund")}>
                          Refund
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
                {activeSaleId === sale.id && mode && (
                  <tr>
                    <td colSpan={canManage ? 9 : 8} className="border-b border-border bg-app px-4 py-4">
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

function PaymentPanel({ sale, onDone }: { sale: BookSaleListRow; onDone: () => void }) {
  // Defaults to the full remaining balance, entered/displayed in dollars —
  // see lib/ui/money.ts's centsToDollars/dollarsToCents.
  const [amountDollars, setAmountDollars] = useState(() => centsToDollars(sale.remainingCents));
  const [method, setMethod] = useState<"cash" | "mobile_money">("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    const amount = dollarsToCents(amountDollars);
    if (amount === null || amount <= 0 || amount > sale.remainingCents) {
      setError(`Enter a valid amount, up to ${centsToDollars(sale.remainingCents)}.`);
      return;
    }
    setSubmitting(true);
    const result = await addBookSalePaymentAction({ bookSaleId: sale.id, amountCents: amount, method, reference: reference || undefined });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to record payment.");
      showErrorToast(result.error?.message ?? "Failed to record payment.");
      return;
    }
    showSuccessToast("Payment recorded.");
    onDone();
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
