"use client";

import { useEffect } from "react";
import type { BookSaleReceiptPrintData } from "@/lib/academies/book-sale-receipt-print";
import { Button, LinkButton } from "@/app/academy/_shell/ui";
import sheetStyles from "@/app/academy/receipts/[id]/receipt-print.module.css";
import styles from "../../book-sale-receipt.module.css";

interface Props {
  data: BookSaleReceiptPrintData;
  /** Same one-click-print convention as the student-payment receipt's
   * `?autoprint=1` (receipt-print-view.tsx). */
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

function discountLabel(type: "none" | "fixed" | "percentage", value: number, currency: string): string {
  if (type === "none") return "—";
  if (type === "fixed") return formatMoney(value, currency);
  return `${value}%`;
}

export function BookSaleReceiptView({ data, autoPrint }: Props) {
  const { sale, academy, book, buyer, recordedByLabel, payments, generatedAt } = data;

  useEffect(() => {
    if (autoPrint) window.print();
    // Fires once, on mount — same convention as receipt-print-view.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusClass =
    sale.paymentStatus === "paid" ? styles.statusPaid : sale.paymentStatus === "partially_paid" ? styles.statusPartial : styles.statusUnpaid;
  const statusLabel = sale.paymentStatus === "paid" ? "Paid" : sale.paymentStatus === "partially_paid" ? "Partially Paid" : "Unpaid";

  return (
    <div className={sheetStyles.page}>
      <div className={`${sheetStyles.actions} ${sheetStyles.noPrint}`}>
        <LinkButton href="/academy/books/sales" variant="secondary">
          ← Back to Book Sales
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
            <h1>Book Sale Receipt</h1>
            <div className={sheetStyles.receiptNumber}>{sale.receiptNumber}</div>
          </div>
        </div>

        <div>
          <span className={statusClass}>{statusLabel}</span>
        </div>

        <dl className={sheetStyles.grid}>
          <div className={sheetStyles.field}>
            <dt>Sale Date</dt>
            <dd>{formatDate(sale.saleDate)}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Buyer</dt>
            <dd>{buyer.type === "student" ? buyer.studentName : buyer.name}</dd>
          </div>
          {buyer.type === "student" ? (
            <>
              <div className={sheetStyles.field}>
                <dt>Student Number</dt>
                <dd>{buyer.studentNumber ?? "—"}</dd>
              </div>
              <div className={sheetStyles.field}>
                <dt>Phone</dt>
                <dd>{buyer.phone ?? "—"}</dd>
              </div>
            </>
          ) : (
            <div className={sheetStyles.field}>
              <dt>Phone</dt>
              <dd>{buyer.phone ?? "—"}</dd>
            </div>
          )}
          <div className={sheetStyles.field}>
            <dt>Book</dt>
            <dd>{book.name}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>ISBN</dt>
            <dd>{book.isbn ?? "—"}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Quantity</dt>
            <dd>{sale.quantity}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Unit Price</dt>
            <dd>{formatMoney(sale.unitPriceCents, sale.currency)}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Subtotal</dt>
            <dd>{formatMoney(sale.subtotalCents, sale.currency)}</dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Discount</dt>
            <dd>
              {discountLabel(sale.discountType, sale.discountValue, sale.currency)}
              {sale.discountAmountCents > 0 ? ` (−${formatMoney(sale.discountAmountCents, sale.currency)})` : ""}
            </dd>
          </div>
          <div className={sheetStyles.field}>
            <dt>Recorded By</dt>
            <dd>{recordedByLabel}</dd>
          </div>
        </dl>

        <div className={sheetStyles.amountBlock}>
          <span className={sheetStyles.amountLabel}>Final Amount</span>
          <span className={sheetStyles.amountValue}>{formatMoney(sale.finalAmountCents, sale.currency)}</span>
        </div>

        <dl className={sheetStyles.grid}>
          <div className={sheetStyles.field}>
            <dt>Total Paid</dt>
            <dd>{formatMoney(sale.totalPaidCents, sale.currency)}</dd>
          </div>
          {sale.totalRefundedCents > 0 && (
            <div className={sheetStyles.field}>
              <dt>Total Refunded</dt>
              <dd>{formatMoney(sale.totalRefundedCents, sale.currency)}</dd>
            </div>
          )}
          <div className={sheetStyles.field}>
            <dt>Remaining</dt>
            <dd>{formatMoney(sale.remainingCents, sale.currency)}</dd>
          </div>
        </dl>

        <div>
          <p className={styles.sectionTitle}>Payments</p>
          {payments.length === 0 ? (
            <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>No payment has been recorded for this sale yet.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Recorded By</th>
                  <th className={sheetStyles.noPrint}>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{formatDate(payment.paidAt)}</td>
                    <td>{formatMoney(payment.amountCents, sale.currency)}</td>
                    <td>{METHOD_LABELS[payment.method]}</td>
                    <td>{payment.reference ?? "—"}</td>
                    <td>{payment.recordedByLabel}</td>
                    <td className={sheetStyles.noPrint}>
                      <a className={styles.link} href={`/academy/books/sales/${sale.id}/payments/${payment.id}/receipt`} target="_blank" rel="noreferrer">
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={sheetStyles.footer}>
          Printed {formatDateTime(generatedAt)} — {academy.name}
        </div>
      </div>
    </div>
  );
}
