"use client";

import { useEffect } from "react";
import type { ReceiptPrintData } from "@/lib/academies/receipt-print";
import { Button, LinkButton } from "@/app/academy/_shell/ui";
import styles from "./receipt-print.module.css";

interface Props {
  data: ReceiptPrintData;
  /** From the payment history's own "View receipt" link (`?autoprint=1`),
   * same one-click-print convention as the certificate print page. */
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

const METHOD_LABELS: Record<ReceiptPrintData["payment"]["method"], string> = {
  cash: "Cash",
  mobile_money: "Mobile Money",
  bank_transfer: "Bank Transfer",
};

/**
 * The receipt reflects the payment's CURRENT state (verification report
 * §9's "should reflect the immediate payment state") — a reversed or
 * rejected payment's receipt still opens (the receipt row itself is never
 * deleted, per Phase 4's no-hard-delete rule), but is clearly marked VOID
 * rather than presented as if it were still a valid proof of payment; only
 * an "approved" payment's receipt prints/downloads normally.
 */
export function ReceiptPrintView({ data, autoPrint }: Props) {
  const { receipt, academy, student, payment, description, recordedByLabel } = data;
  const isVoid = payment.status !== "approved";

  useEffect(() => {
    if (autoPrint && !isVoid) {
      window.print();
    }
    // Only ever fires once, on mount — same convention as
    // certificate-print-view.tsx's identical effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.page}>
      <div className={`${styles.actions} ${styles.noPrint}`}>
        <LinkButton href="/academy/finance" variant="secondary">
          ← Back to Finance
        </LinkButton>
        <div className="flex-1" />
        <Button type="button" disabled={isVoid} onClick={() => window.print()}>
          Print Receipt
        </Button>
      </div>

      {isVoid && (
        <p className={`${styles.noPrint} text-sm text-danger`} style={{ maxWidth: "148mm", width: "100%" }}>
          This payment is currently <strong>{payment.status.replace("_", " ")}</strong>, not approved — the receipt
          below is void and printing is disabled.
        </p>
      )}

      <div className={styles.sheet}>
        <div className={styles.header}>
          <div>
            {academy.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL, same convention as certificate-print-view.tsx.
              <img src={academy.logoUrl} alt={academy.name} className={styles.logo} />
            )}
            <div className={styles.academyName}>{academy.name}</div>
            <p className={styles.academyMeta}>
              {[academy.address, academy.phone, academy.email, academy.website, academy.registrationNumber && `Reg. ${academy.registrationNumber}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className={styles.receiptTitle}>
            <h1>Receipt</h1>
            <div className={styles.receiptNumber}>{receipt.receiptNumber}</div>
          </div>
        </div>

        {isVoid && <div className={styles.voidBanner}>Void — {payment.status.replace("_", " ")}</div>}

        <dl className={styles.grid}>
          <div className={styles.field}>
            <dt>Student</dt>
            <dd>{student.fullName}</dd>
          </div>
          <div className={styles.field}>
            <dt>Student ID</dt>
            <dd>{student.studentNumber}</dd>
          </div>
          <div className={styles.field}>
            <dt>Payment Date</dt>
            <dd>{formatDate(payment.receivedAt)}</dd>
          </div>
          <div className={styles.field}>
            <dt>Payment Method</dt>
            <dd>{METHOD_LABELS[payment.method]}</dd>
          </div>
          <div className={styles.field}>
            <dt>Reference</dt>
            <dd>{payment.reference ?? "—"}</dd>
          </div>
          <div className={styles.field}>
            <dt>Recorded By</dt>
            <dd>{recordedByLabel}</dd>
          </div>
          <div className={styles.field} style={{ gridColumn: "1 / -1" }}>
            <dt>Course / Program / Charge</dt>
            <dd>{description}</dd>
          </div>
        </dl>

        <div className={styles.amountBlock}>
          <span className={styles.amountLabel}>Amount Received</span>
          <span className={styles.amountValue}>{formatMoney(payment.amountCents, payment.currency)}</span>
        </div>

        {payment.notes && (
          <dl className={styles.notesBlock}>
            <dt>Notes</dt>
            <dd>{payment.notes}</dd>
          </dl>
        )}

        <div className={styles.footer}>
          Issued {formatDateTime(receipt.issuedAt)} — {academy.name}
        </div>
      </div>
    </div>
  );
}
