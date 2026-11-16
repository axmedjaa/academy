"use client";

import { useState, useTransition } from "react";
import { issueReceiptAction } from "@/lib/academies/student-payments-actions";
import { useRouter } from "next/navigation";
import { partiallyReverseStudentPaymentAction, reverseStudentPaymentAction } from "@/lib/academies/finance-reversals-actions";
import { formatDate } from "@/lib/ui/date";
import { dollarsToCents, formatMoney } from "@/lib/ui/money";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, LinkButton, trHover } from "@/app/academy/_shell/ui";
import { DataTable, StatRow, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ActionDialog, DField, ReasonField, controlClass, invalidProps } from "@/app/academy/_shell/design-form";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentAvatar } from "../student-avatar";
import type { PaymentHistoryRow } from "./student-detail";

/** Rows per page (design `T` tables page at six). */
const PAGE_ROWS = 6;


/** Design `methodChip`: label, icon and tint per method. */
const METHOD: Record<PaymentHistoryRow["method"], { label: string; icon: string; className: string }> = {
  cash: { label: "Cash", icon: "cash", className: "bg-brand-tint text-brand" },
  mobile_money: { label: "Mobile money", icon: "phone", className: "bg-[rgba(245,182,56,0.28)] text-ink" },
  bank_transfer: { label: "Bank transfer", icon: "bank", className: "bg-[#EEF2F6] text-[#374151]" },
};

/** Design `pStatus` wording: an approved payment reads "Posted". */
const STATUS: Record<PaymentHistoryRow["status"], { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  approved: { label: "Posted", tone: "green" },
  pending_approval: { label: "Pending approval", tone: "amber" },
  rejected: { label: "Rejected", tone: "red" },
  reversed: { label: "Reversed", tone: "slate" },
};

const ROW_ACTION =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";
const PAGER_BUTTON =
  "h-10 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Payments tab (design A02, the academy `payRows` table): Date, Student
 * (who paid and who recorded it), Applies to, Method, Amount, Status and
 * the row's actions — Receipt, plus Reverse / Reverse part for those allowed.
 * Reference and notes stay on the row under "Applies to". Stacks into one
 * card per payment where the seven columns do not fit (design: below
 * about 1,030px of content), and pages at six rows.
 */
export function PaymentHistoryPanel({
  rows,
  studentName,
  photoUrl,
  canManagePayments,
  canReversePayments,
  currentUserId,
}: {
  rows: PaymentHistoryRow[];
  studentName: string;
  photoUrl: string | null;
  canManagePayments: boolean;
  canReversePayments: boolean;
  currentUserId: string;
}) {
  const [page, setPage] = useState(1);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [, startIssue] = useTransition();
  const [issuedReceipts, setIssuedReceipts] = useState<Map<string, { id: string; receiptNumber: string }>>(new Map());
  const [changed, setChanged] = useState<Map<string, PaymentHistoryRow["status"]>>(new Map());
  const router = useRouter();
  const [acting, setActing] = useState<{ row: PaymentHistoryRow; mode: "reverse" | "adjust" } | null>(null);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const current = Math.min(page, pages);
  const first = (current - 1) * PAGE_ROWS;
  const shown = rows.slice(first, first + PAGE_ROWS);

  function issueReceipt(paymentId: string) {
    setIssuingId(paymentId);
    startIssue(async () => {
      const result = await issueReceiptAction(paymentId);
      setIssuingId(null);
      if (!result.ok) {
        showErrorToast(result.error.message);
        return;
      }
      setIssuedReceipts((prev) => new Map(prev).set(paymentId, { id: result.receiptId, receiptNumber: result.receiptNumber }));
      showSuccessToast("Receipt issued.");
    });
  }

  if (rows.length === 0) {
    return (
      <div className="mb-8 rounded-card border border-border bg-surface px-4 py-10 text-center text-sm text-muted shadow-card">
        No payments to show yet.
      </div>
    );
  }

  return (
    <>
      <DataTable stackBelow={1040}>
        <thead>
          <tr>
            <th className={rtTh}>Date</th>
            <th className={rtTh}>Student</th>
            <th className={rtTh}>Applies to</th>
            <th className={rtTh}>Method</th>
            <th className={`${rtTh} text-right`}>Amount</th>
            <th className={rtTh}>Status</th>
            <th className={rtTh}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const status = changed.get(row.paymentId) ?? row.status;
            const method = METHOD[row.method];
            const issued = issuedReceipts.get(row.paymentId);
            const receiptId = issued?.id ?? row.receiptId;
            const receiptNumber = issued?.receiptNumber ?? row.receiptNumber;
            const selfRecorded = row.recordedBy === currentUserId;
            // A Manager can correct any payment; anyone who records payments
            // can correct one they recorded (the server enforces the same).
            // A payment a refund came out of can't be reversed or adjusted
            // (the server refuses it too).
            const reversible =
              status === "approved" && row.refundedCents === 0 && (canReversePayments || (canManagePayments && selfRecorded));
            return (
              <tr key={row.paymentId}>
                <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Date">
                  {formatDate(row.receivedAt)}
                </td>
                <td className={rtTd} data-label="Student">
                  <span className="flex items-center gap-3">
                    <StudentAvatar fullName={studentName} photoUrl={photoUrl} sizeClassName="h-10 w-10" textClassName="text-sm" />
                    <span className="min-w-0">
                      <span className="block font-semibold text-brand [overflow-wrap:anywhere]">{studentName}</span>
                      <span className="block text-xs text-muted">Recorded by {row.recordedByLabel}</span>
                    </span>
                  </span>
                </td>
                <td className={`${rtTd} min-w-[180px]`} data-label="Applies to" title={row.description}>
                  {/* One stacked block, so card mode keeps the lines under each other. */}
                  <span className="flex min-w-0 flex-col">
                  <span className="block text-ink [overflow-wrap:anywhere]">{row.appliesTo}</span>
                  {row.appliesToDetail && (
                    <span className="block text-xs tabular-nums text-muted [overflow-wrap:anywhere]">{row.appliesToDetail}</span>
                  )}
                  {row.reference && <span className="block text-xs text-muted [overflow-wrap:anywhere]">Ref {row.reference}</span>}
                  {row.refundedCents > 0 && (
                    <span className="block text-xs font-semibold text-[#9A5B00]">
                      {formatMoney(row.refundedCents, row.currency)} refunded on withdrawal
                    </span>
                  )}
                  {row.notes && <span className="block text-xs italic text-muted [overflow-wrap:anywhere]">{row.notes}</span>}
                  </span>
                </td>
                <td className={rtTd} data-label="Method">
                  <span
                    className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-2 pr-3 text-[13px] font-semibold ${method.className}`}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/70" aria-hidden="true">
                      <Icon name={method.icon} width={14} height={14} />
                    </span>
                    {method.label}
                  </span>
                </td>
                <td className={`${rtTd} whitespace-nowrap text-right font-semibold tabular-nums`} data-label="Amount">
                  {formatMoney(row.amountCents, row.currency)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={STATUS[status].label} tone={STATUS[status].tone} />
                </td>
                <td className={rtTd} data-actions="">
                  <span className="flex flex-wrap justify-end gap-2">
                    {receiptId ? (
                      <LinkButton href={`/academy/receipts/${receiptId}`} variant="secondary" className={ROW_ACTION} target="_blank">
                        <Icon name="receipt_long" width={16} height={16} />
                        {receiptNumber ? `Receipt ${receiptNumber}` : "Receipt"}
                      </LinkButton>
                    ) : canManagePayments && status === "approved" ? (
                      <button type="button" className={ROW_ACTION} disabled={issuingId === row.paymentId} onClick={() => issueReceipt(row.paymentId)}>
                        <Icon name="receipt_long" width={16} height={16} />
                        {issuingId === row.paymentId ? "Issuing…" : "Issue receipt"}
                      </button>
                    ) : (
                      <span className="text-xs text-muted">No receipt</span>
                    )}
                    {reversible && (
                      <>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          onClick={() => setActing({ row, mode: "reverse" })}
                        >
                          <Icon name="autorenew" width={16} height={16} />
                          Reverse
                        </button>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          onClick={() => setActing({ row, mode: "adjust" })}
                        >
                          Reverse part
                        </button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {pages > 1 && (
        <nav aria-label="Payment history pages" className="mb-8 mt-[-1rem] flex items-center justify-between gap-2">
          <button type="button" className={PAGER_BUTTON} onClick={() => setPage(current - 1)} disabled={current <= 1}>
            Previous
          </button>
          <span className="text-[13px] text-[#374151]">
            Page {current} of {pages} · {rows.length} payments
          </span>
          <button type="button" className={PAGER_BUTTON} onClick={() => setPage(current + 1)} disabled={current >= pages}>
            Next
          </button>
        </nav>
      )}

      {acting && (
        <ActionDialog
          key={`${acting.row.paymentId}-${acting.mode}`}
          open
          onOpenChange={(open) => !open && setActing(null)}
          title={acting.mode === "reverse" ? "Reverse payment" : "Reverse part of payment"}
          description={
            acting.mode === "reverse"
              ? "The original stays on record and a linked reversal is added. A reason is required."
              : "Only the amount you enter is reversed. The rest stays posted as a new payment on the same date, paying the same fees. A reason is required."
          }
          summary={[
            { label: "Payment", value: `${formatDate(acting.row.receivedAt)} · ${formatMoney(acting.row.amountCents, acting.row.currency)}` },
            { label: "Applies to", value: acting.row.appliesTo },
          ]}
          submitLabel={acting.mode === "reverse" ? "Reverse payment" : "Reverse part"}
          pendingLabel="Reversing…"
          danger
          rules={[
            ...(acting.mode === "adjust"
              ? [
                  {
                    name: "amount",
                    label: "Amount to reverse",
                    required: true,
                    check: (value: string) => {
                      const cents = dollarsToCents(value);
                      if (cents === null || cents <= 0) return "Enter the amount to reverse, for example 1.00.";
                      if (cents >= acting.row.amountCents) {
                        return "Must be less than the payment. To reverse all of it, use Reverse.";
                      }
                      return null;
                    },
                  },
                ]
              : []),
            { name: "reason", label: "Reason", required: true },
          ]}
          run={async (data) => {
            const reason = String(data.get("reason") ?? "").trim();
            const result =
              acting.mode === "adjust"
                ? await partiallyReverseStudentPaymentAction(acting.row.paymentId, reason, dollarsToCents(String(data.get("amount") ?? ""))!)
                : await reverseStudentPaymentAction(acting.row.paymentId, reason);
            return result.ok ? null : result.error.message;
          }}
          onDone={() => {
            setChanged((prev) => new Map(prev).set(acting.row.paymentId, "reversed"));
            showSuccessToast(acting.mode === "adjust" ? "Part reversed. The rest stays posted." : "Payment reversed.");
            setActing(null);
            // Shows the new remainder payment, the reversal row and updated totals.
            router.refresh();
          }}
        >
          {({ errors, blur }) => (
            <>
              {acting.mode === "adjust" && (
                <DField label={`Amount to reverse (${acting.row.currency})`} name="amount" required error={errors.amount}>
                  <input
                    name="amount"
                    inputMode="decimal"
                    placeholder="0.00"
                    onBlur={blur("amount")}
                    className={controlClass(Boolean(errors.amount))}
                    {...invalidProps("amount", errors.amount)}
                  />
                </DField>
              )}
              <ReasonField errors={errors} blur={blur} />
            </>
          )}
        </ActionDialog>
      )}
    </>
  );
}

export interface RefundHistoryRow {
  id: string;
  refundedAt: Date;
  appliesTo: string;
  method: PaymentHistoryRow["method"];
  amountCents: number;
  currency: string;
  reference: string | null;
  reason: string;
  recordedByLabel: string;
  /** How many original payments the refund was recorded against. */
  paymentCount: number;
}

/**
 * Refunds recorded when the student withdrew from a course — money the
 * academy returned, listed apart from payments so a refund is never read
 * as money received or as a reversal. Hidden when there are none.
 */
/**
 * Paid / Refunded / Net for this student: posted payments, minus every
 * refund given back (course or program, on withdrawal). The payments
 * themselves stay posted — a refund is its own record — so the net is the
 * money the academy actually kept. One line per currency.
 */
export function PaymentTotalsStrip({ payments, refunds }: { payments: PaymentHistoryRow[]; refunds: RefundHistoryRow[] }) {
  const byCurrency = new Map<string, { paid: number; refunded: number; posted: number; refundCount: number }>();
  const entry = (currency: string) => {
    let row = byCurrency.get(currency);
    if (!row) {
      row = { paid: 0, refunded: 0, posted: 0, refundCount: 0 };
      byCurrency.set(currency, row);
    }
    return row;
  };
  for (const payment of payments) {
    if (payment.status !== "approved") continue;
    const row = entry(payment.currency);
    row.paid += payment.amountCents;
    row.posted += 1;
  }
  for (const refund of refunds) {
    const row = entry(refund.currency);
    row.refunded += refund.amountCents;
    row.refundCount += 1;
  }
  if (byCurrency.size === 0) return null;
  const totals = [...byCurrency.entries()];
  const line = (pick: (row: { paid: number; refunded: number }) => number) =>
    totals.map(([currency, row]) => formatMoney(pick(row), currency)).join(" + ");
  const posted = totals.reduce((n, [, row]) => n + row.posted, 0);
  const refundCount = totals.reduce((n, [, row]) => n + row.refundCount, 0);
  return (
    <StatRow
      items={[
        { label: "Paid", value: line((row) => row.paid), hint: `${posted} posted`, icon: "payments" },
        {
          label: "Refunded",
          value: line((row) => row.refunded),
          hint: refundCount === 0 ? "no refunds" : `${refundCount} refund${refundCount === 1 ? "" : "s"}`,
          icon: "autorenew",
        },
        { label: "Net paid", value: line((row) => row.paid - row.refunded), hint: "paid minus refunds", icon: "bank" },
      ]}
    />
  );
}

export function RefundHistoryPanel({ rows }: { rows: RefundHistoryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="refund-history" className="mb-8">
      <h2 id="refund-history" className="mb-3 text-base font-semibold text-ink">
        Refunds <span className="font-normal text-muted">({rows.length})</span>
      </h2>
      <DataTable stackBelow={760}>
        <thead>
          <tr>
            <th className={`${rtTh} whitespace-nowrap`}>Returned on</th>
            <th className={rtTh}>Course</th>
            <th className={rtTh}>Method</th>
            <th className={`${rtTh} text-right`}>Amount</th>
            <th className={rtTh}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const method = METHOD[row.method];
            return (
              <tr key={row.id} className={trHover}>
                <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Returned on">
                  {formatDate(row.refundedAt)}
                  <span className="block text-xs text-muted">Recorded by {row.recordedByLabel}</span>
                </td>
                <td className={rtTd} data-label="Course">
                  <span className="flex min-w-0 flex-col">
                    <span>{row.appliesTo}</span>
                    <span className="text-xs text-muted">
                      From {row.paymentCount} payment{row.paymentCount === 1 ? "" : "s"}
                      {row.reference ? ` · Ref. ${row.reference}` : ""}
                    </span>
                  </span>
                </td>
                <td className={`${rtTd} whitespace-nowrap`} data-label="Method">
                  <span className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-2 pr-3 text-[13px] font-semibold ${method.className}`}>
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/70" aria-hidden="true">
                      <Icon name={method.icon} width={14} height={14} />
                    </span>
                    {method.label}
                  </span>
                </td>
                <td className={`${rtTd} whitespace-nowrap text-right font-semibold tabular-nums`} data-label="Amount">
                  {formatMoney(row.amountCents, row.currency)}
                  <span className="block text-xs font-normal text-muted">Refunded</span>
                </td>
                <td className={rtTd} data-label="Reason">
                  {row.reason}
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </section>
  );
}
