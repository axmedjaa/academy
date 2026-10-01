"use client";

import { useEffect } from "react";
import type { BookSaleReceiptPayment, BookSaleReceiptPrintData } from "@/lib/academies/book-sale-receipt-print";
import { Button, LinkButton } from "@/app/academy/_shell/ui";
import sheetStyles from "@/app/academy/receipts/[id]/receipt-print.module.css";
import styles from "../../../../book-sale-receipt.module.css";

interface Props {
  data: BookSaleReceiptPrintData;
  payment: BookSaleReceiptPayment;
  autoPrint: boolean;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

const METHOD_LABELS: Record<"cash" | "mobile_money", string> = { cash: "Cash", mobile_money: "Mobile Money" };

/**
 * A single payment event's receipt — NEVER the whole sale. Always shows
 * "Payment Received Now" (this payment's own amount) distinctly from
 * "Total Paid" (the running total AS OF this payment, from
 * `payment.runningTotalPaidCents` — already computed server-side so this
 * component never needs to re-derive it, and can never accidentally sum
 * wrong). This is what satisfies "never claim the full sale amount was
 * received" for a partially-paid sale.
 */
export function BookSalePaymentReceiptView({ data, payment, autoPrint }: Props) {
  const { sale, academy, book, buyer, generatedAt } = data;

  useEffect(() => {
    if (autoPrint) window.print();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={sheetStyles.page}>
      <div className={`${sheetStyles.actions} ${sheetStyles.noPrint}`}>
        <LinkButton href={`/academy/books/sales/${sale.id}/receipt`} variant="secondary">
          ← Back to Sale Receipt
        </LinkButton>
        <div className="flex-1" />
        <Button type="button" onClick={() => window.print()}>
          Print Receipt
        </Button>
      </div>

      <div className={sheetStyles.sheet}>
        <div className={sheetStyles.header}>
          <div>
            {academy.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL, same convention as receipt-print-view.tsx.
              <img src={academy.logoUrl} alt={academy.name} className={sheetStyles.logo} />
            )}
            <div className={sheetStyles.academyName}>{academy.name}</div>
            <p className={sheetStyles.academyMeta}>
              {[academy.address, academy.phone, academy.email, academy.website, academy.registrationNumber && `Reg. ${academy.registrationNumber}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className={sheetStyles.receiptTitle}>
            <h1>Payment Receipt</h1>
            <div className={sheetStyles.receiptNumber}>
              {sale.receiptNumber} · Payment {payment.ordinal}
            </div>
          </div>
        </div>

        <dl className={sheetStyles.grid}>
          <div className={sheetStyles.field}>
            <dt>Payment Date</dt>
            <dd>{formatDate(payment.paidAt)}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Buyer</dt>
            <dd>{buyer.type === "student" ? buyer.studentName : buyer.name}</dd>
          </div>
          {buyer.type === "student" && (
            <div className={sheetStyles.field}>
              <dt>Student Number</dt>
              <dd>{buyer.studentNumber ?? "—"}</dd>
            </div>
          )}
          <div className={sheetStyles.field}>
            <dt>Book</dt>
            <dd>
              {book.name} × {sale.quantity}
            </dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Payment Method</dt>
            <dd>{METHOD_LABELS[payment.method]}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Reference</dt>
            <dd>{payment.reference ?? "—"}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Recorded By</dt>
            <dd>{payment.recordedByLabel}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Final Sale Amount</dt>
            <dd>{formatMoney(sale.finalAmountCents, sale.currency)}</dd>
          </div>
        </dl>

        <div className={sheetStyles.amountBlock}>
          <span className={sheetStyles.amountLabel}>Payment Received Now</span>
          <span className={sheetStyles.amountValue}>{formatMoney(payment.amountCents, sale.currency)}</span>
        </div>

        <dl className={sheetStyles.grid}>
          <div className={sheetStyles.field}>
            <dt>Total Paid (as of this payment)</dt>
            <dd>{formatMoney(payment.runningTotalPaidCents, sale.currency)}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Remaining (as of this payment)</dt>
            <dd>{formatMoney(payment.remainingAfterCents, sale.currency)}</dd>
          </div>
        </dl>

        <p style={{ fontSize: "0.7rem", color: "#6b7280" }}>
          This receipt reflects only the payment recorded on {formatDate(payment.paidAt)}. The sale&apos;s current
          totals may differ if further payments or refunds have since been recorded — see the full{" "}
          <a className={styles.link} href={`/academy/books/sales/${sale.id}/receipt`}>
            sale receipt
          </a>
          .
        </p>

        <div className={sheetStyles.footer}>
          Printed {formatDateTime(generatedAt)} — {academy.name}
        </div>
      </div>
    </div>
  );
}
