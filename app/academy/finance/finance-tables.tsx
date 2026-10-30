"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { StudentPaymentRecord } from "@/lib/academies/student-payments";
import type { IncomeRecordRecord } from "@/lib/academies/income-records";
import type { ExpenseRecordRecord } from "@/lib/academies/expense-records";
import { issueReceiptAction } from "@/lib/academies/student-payments-actions";
import {
  adjustExpenseRecordAction,
  adjustIncomeRecordAction,
  adjustStudentPaymentAction,
  reverseExpenseRecordAction,
  reverseIncomeRecordAction,
  reverseStudentPaymentAction,
} from "@/lib/academies/finance-reversals-actions";
import {
  approveExpenseAction,
  rejectExpenseAction,
  submitExpenseForApprovalAction,
} from "@/lib/academies/expense-records-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { dollarsToCents, formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";
import { getStatusTone } from "@/lib/ui/status";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, trHover } from "@/app/academy/_shell/ui";
import { DataTable, PersonCell, ROW_BTN, ROW_BTN_DANGER, ROW_BTN_PRIMARY, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import {
  ActionDialog,
  DField,
  ReasonField,
  controlClass,
  invalidProps,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { categoryChip, methodChip } from "./finance-chips";

/**
 * Finance tab tables with their row actions (design A13). Every action is
 * the existing server action, which re-checks role, academy scope, state
 * and the self-reversal rule; a disabled button here only explains the
 * rule up front (its title says why).
 */


const REASON_RULES: DesignFormRule[] = [{ name: "reason", label: "Reason", required: true }];
const ADJUST_RULES: DesignFormRule[] = [
  {
    name: "amountDollars",
    label: "Corrected amount (USD)",
    required: true,
    check: (value) => (dollarsToCents(value) === null ? "Enter the corrected amount, for example 25.00." : null),
  },
  { name: "reason", label: "Reason", required: true },
];

type Correction = { mode: "reverse" | "adjust"; id: string; label: string; amount: string };

/** Runs a direct-call action; resolves to an error message or null. */
async function call(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>): Promise<string | null> {
  try {
    const result = await action();
    return result.ok ? null : result.error.message;
  } catch {
    return NETWORK_ERROR_MESSAGE;
  }
}

function CorrectionDialog({
  correction,
  noun,
  onClose,
  reverse,
  adjust,
  switchable = false,
}: {
  correction: Correction | null;
  noun: "payment" | "income" | "expense";
  onClose: () => void;
  reverse: (id: string, reason: string) => Promise<string | null>;
  adjust: (id: string, reason: string, cents: number) => Promise<string | null>;
  /** One "Reverse" row action (design `pay` table) that offers both
   * corrections inside the dialog: reverse in full, or adjust the amount. */
  switchable?: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<{ id: string; mode: Correction["mode"] } | null>(null);
  const mode = switchable && chosen && chosen.id === correction?.id ? chosen.mode : correction?.mode;
  const adjusting = mode === "adjust";
  return (
    <ActionDialog
      open={correction !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`${adjusting ? "Adjust" : "Reverse"} ${noun}`}
      description={
        adjusting
          ? "The original is reversed and a corrected record is added in its place. A reason is required."
          : "The original stays on record and a linked reversal is added. A reason is required."
      }
      summary={correction ? [{ label: noun === "payment" ? "Payment" : "Record", value: correction.label }, { label: "Amount", value: correction.amount }] : undefined}
      submitLabel={adjusting ? `Adjust ${noun}` : `Reverse ${noun}`}
      pendingLabel={adjusting ? "Adjusting…" : "Reversing…"}
      danger={!adjusting}
      rules={adjusting ? ADJUST_RULES : REASON_RULES}
      run={(data) => {
        const reason = String(data.get("reason") ?? "").trim();
        if (!correction) return Promise.resolve(null);
        return adjusting
          ? adjust(correction.id, reason, dollarsToCents(String(data.get("amountDollars") ?? ""))!)
          : reverse(correction.id, reason);
      }}
      onDone={() => {
        showSuccessToast(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${adjusting ? "adjusted" : "reversed"}.`);
        onClose();
        router.refresh();
      }}
    >
      {({ errors, blur }) => (
        <>
          {switchable && correction && (
            <DField label="Correction" name="correctionMode" group full>
              <span role="radiogroup" aria-label="Correction" className="flex flex-wrap gap-2">
                {(
                  [
                    ["reverse", "Reverse in full"],
                    ["adjust", "Adjust amount"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app has-[:checked]:border-brand has-[:checked]:bg-brand-tint has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30"
                  >
                    <input
                      type="radio"
                      name="correctionMode"
                      value={value}
                      checked={mode === value}
                      onChange={() => setChosen({ id: correction.id, mode: value })}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </span>
            </DField>
          )}
          {adjusting && (
            <DField label="Corrected amount (USD)" name="amountDollars" required error={errors.amountDollars}>
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                placeholder="0.00"
                onBlur={blur("amountDollars")}
                className={controlClass(Boolean(errors.amountDollars))}
                {...invalidProps("amountDollars", errors.amountDollars)}
              />
            </DField>
          )}
          <ReasonField errors={errors} blur={blur} placeholder="Entered twice by mistake" />
        </>
      )}
    </ActionDialog>
  );
}

function CorrectionButtons({ onReverse, onAdjust }: { onReverse: () => void; onAdjust: () => void }) {
  return (
    <>
      <button type="button" className={ROW_BTN_DANGER} onClick={onReverse}>
        <Icon name="autorenew" width={16} height={16} />
        Reverse
      </button>
      <button type="button" className={ROW_BTN} onClick={onAdjust}>
        Adjust
      </button>
    </>
  );
}

const ledgerStatus = (status: string, isReversalRow: boolean) =>
  isReversalRow ? "Reversal" : status === "posted" || status === "approved" ? (status === "posted" ? "Posted" : "Approved") : status;
const ledgerTone = (status: string, isReversalRow: boolean) => (isReversalRow ? "slate" : getStatusTone(status));

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface PaymentRow {
  payment: StudentPaymentRecord;
  studentName: string;
  studentNumber: string;
  photoUrl: string | null;
  recordedByName: string;
  appliesTo: string;
  /** e.g. "3 fee periods" when one payment was split across several. */
  appliesToDetail?: string | null;
  receipt: { id: string; number: string } | null;
  /** Refunded out of this payment on a course withdrawal. */
  refundedCents?: number;
}

/** Design `pStatus`: Posted / Reversed (and the legacy approval states). */
const PAYMENT_STATUS_LABEL: Record<string, string> = {
  approved: "Posted",
  reversed: "Reversed",
  pending_approval: "Pending approval",
  rejected: "Rejected",
};

export function PaymentsTable({
  rows,
  canManage,
  canReverse,
  currentUserId,
  footer,
}: {
  rows: PaymentRow[];
  canManage: boolean;
  canReverse: boolean;
  currentUserId: string;
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [issuing, startIssuing] = useTransition();
  const [issuingId, setIssuingId] = useState<string | null>(null);

  function issueReceipt(paymentId: string) {
    setIssuingId(paymentId);
    startIssuing(async () => {
      try {
        const result = await issueReceiptAction(paymentId);
        if (!result.ok) showErrorToast(result.error.message);
        else {
          showSuccessToast(`Receipt ${result.receiptNumber} issued.`);
          router.refresh();
        }
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
      setIssuingId(null);
    });
  }

  return (
    <>
      {/* Design `pay` table columns: 64px 1.5fr 1fr 150px 90px 100px 220px.
          Its own card rule (px total + 110 per fr + gaps + padding) puts the
          switch to cards at ~1,030px of content, hence stackBelow 1040. */}
      <DataTable stackBelow={1040} footer={footer}>
        <thead>
          <tr>
            <th className={`${rtTh} whitespace-nowrap`}>Date</th>
            {/* Design 1.5fr : 1fr between Student and Applies to. */}
            <th className={`${rtTh} w-[24%]`}>Student</th>
            <th className={`${rtTh} w-[16%] whitespace-nowrap`}>Applies to</th>
            <th className={rtTh}>Method</th>
            <th className={`${rtTh} text-right`}>Amount</th>
            <th className={rtTh}>Status</th>
            <th className={rtTh}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ payment, studentName, photoUrl, recordedByName, appliesTo, appliesToDetail, receipt, refundedCents = 0 }) => {
            const reversalRow = payment.reversedPaymentId !== null;
            const posted = payment.status === "approved" && !reversalRow;
            const self = payment.recordedBy === currentUserId;
            const label = `${studentName}, ${formatMoney(payment.amountCents, payment.currency)}`;
            return (
              <tr key={payment.id} className={trHover}>
                <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Date">
                  {formatDate(payment.receivedAt)}
                </td>
                <td className={rtTd} data-label="Student">
                  <PersonCell
                    name={studentName}
                    sub={`Recorded by ${recordedByName}`}
                    href={`/academy/students/${payment.studentId}`}
                    photoUrl={photoUrl}
                  />
                </td>
                <td className={`${rtTd} break-words`} data-label="Applies to">
                  <span className="flex min-w-0 flex-col">
                    <span>{appliesTo}</span>
                    {appliesToDetail && <span className="text-xs text-muted">{appliesToDetail}</span>}
                    {payment.reference && <span className="break-all text-xs text-muted">Ref. {payment.reference}</span>}
                    {refundedCents > 0 && (
                      <span className="text-xs font-semibold text-[#9A5B00]">
                        {formatMoney(refundedCents, payment.currency)} refunded on withdrawal
                      </span>
                    )}
                  </span>
                </td>
                <td className={`${rtTd} whitespace-nowrap`} data-label="Method">
                  {methodChip(payment.method)}
                </td>
                <td className={`${rtTd} whitespace-nowrap text-right font-semibold tabular-nums`} data-label="Amount">
                  {formatMoney(payment.amountCents, payment.currency)}
                </td>
                <td className={`${rtTd} whitespace-nowrap`} data-label="Status">
                  <Badge
                    label={reversalRow ? "Reversal" : (PAYMENT_STATUS_LABEL[payment.status] ?? payment.status)}
                    tone={reversalRow ? "slate" : getStatusTone(payment.status)}
                  />
                </td>
                <td className={`${rtTd} text-right`} data-actions="">
                  <span className="inline-flex flex-wrap items-center justify-end gap-2 whitespace-nowrap min-[1100px]:flex-nowrap">
                    {receipt ? (
                      <Link href={`/academy/receipts/${receipt.id}`} className={ROW_BTN} title={`Receipt ${receipt.number}`}>
                        <Icon name="receipt_long" width={16} height={16} />
                        Receipt
                      </Link>
                    ) : canManage && payment.status === "approved" ? (
                      <button type="button" className={ROW_BTN} disabled={issuing} onClick={() => issueReceipt(payment.id)}>
                        <Icon name="receipt_long" width={16} height={16} />
                        {issuingId === payment.id ? "Issuing…" : "Issue receipt"}
                      </button>
                    ) : null}
                    {/* A Manager can correct any payment; anyone who records
                        payments can correct a payment they recorded. The
                        server enforces the same rule on the locked row. */}
                    {/* A payment a refund came out of can't be reversed or
                        adjusted (the server refuses it too). */}
                    {posted && refundedCents === 0 && (canReverse || (canManage && self)) && (
                      <button
                        type="button"
                        className={ROW_BTN_DANGER}
                        title="Reverse in full, or adjust the amount"
                        onClick={() => setCorrection({ mode: "reverse", id: payment.id, label, amount: formatMoney(payment.amountCents, payment.currency) })}
                      >
                        <Icon name="autorenew" width={16} height={16} />
                        Reverse
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <CorrectionDialog
        correction={correction}
        noun="payment"
        switchable
        onClose={() => setCorrection(null)}
        reverse={(id, reason) => call(() => reverseStudentPaymentAction(id, reason))}
        adjust={(id, reason, cents) => call(() => adjustStudentPaymentAction(id, reason, cents))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Income                                                              */
/* ------------------------------------------------------------------ */

export function IncomeTable({
  rows,
  canReverse,
}: {
  rows: { record: IncomeRecordRecord; recordedByName: string }[];
  canReverse: boolean;
}) {
  const [correction, setCorrection] = useState<Correction | null>(null);
  return (
    <>
      <DataTable stackBelow={900}>
        <thead>
          <tr>
            <th className={rtTh}>Category</th>
            <th className={rtTh}>Description</th>
            <th className={rtTh}>Date</th>
            <th className={`${rtTh} text-right`}>Amount</th>
            <th className={rtTh}>Status</th>
            {canReverse && (
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ record, recordedByName }) => {
            const reversalRow = record.reversedRecordId !== null;
            const amount = formatMoney(record.amountCents, record.currency);
            return (
              <tr key={record.id} className={trHover}>
                <td className={rtTd} data-label="Category">
                  {categoryChip(record.category)}
                </td>
                <td className={rtTd} data-label="Description">
                  {record.description ?? <span className="text-muted">No description</span>}
                  <span className="block text-xs text-muted">Recorded by {recordedByName}</span>
                </td>
                <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Date">
                  {formatDate(record.createdAt)}
                </td>
                <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="Amount">
                  {amount}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={ledgerStatus(record.status, reversalRow)} tone={ledgerTone(record.status, reversalRow)} />
                </td>
                {canReverse && (
                  <td className={`${rtTd} text-right`} data-actions="">
                    {record.status === "posted" && !reversalRow && (
                      <span className="inline-flex flex-wrap items-center justify-end gap-2">
                        <CorrectionButtons
                          onReverse={() => setCorrection({ mode: "reverse", id: record.id, label: record.category, amount })}
                          onAdjust={() => setCorrection({ mode: "adjust", id: record.id, label: record.category, amount })}
                        />
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <CorrectionDialog
        correction={correction}
        noun="income"
        onClose={() => setCorrection(null)}
        reverse={(id, reason) => call(() => reverseIncomeRecordAction(id, reason))}
        adjust={(id, reason, cents) => call(() => adjustIncomeRecordAction(id, reason, cents))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export function ExpensesTable({
  rows,
  canCreate,
  canApprove,
  canSelfApprove,
  currentUserId,
}: {
  rows: { record: ExpenseRecordRecord; submittedByName: string }[];
  canCreate: boolean;
  canApprove: boolean;
  canSelfApprove: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseRecordRecord | null>(null);
  const [busy, startBusy] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function lifecycle(id: string, action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>, done: string) {
    setBusyId(id);
    startBusy(async () => {
      const message = await call(action);
      if (message) showErrorToast(message);
      else {
        showSuccessToast(done);
        router.refresh();
      }
      setBusyId(null);
    });
  }

  return (
    <>
      <DataTable stackBelow={900}>
        <thead>
          <tr>
            <th className={rtTh}>Category</th>
            <th className={rtTh}>Description</th>
            <th className={rtTh}>Submitted by</th>
            <th className={rtTh}>Date</th>
            <th className={`${rtTh} text-right`}>Amount</th>
            <th className={rtTh}>Status</th>
            <th className={rtTh}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ record, submittedByName }) => {
            const reversalRow = record.reversedRecordId !== null;
            const own = record.submittedBy === currentUserId;
            const canDecide = canApprove || (canSelfApprove && own);
            const amount = formatMoney(record.amountCents, record.currency);
            const working = busy && busyId === record.id;
            return (
              <tr key={record.id} className={trHover}>
                <td className={rtTd} data-label="Category">
                  {categoryChip(record.category)}
                </td>
                <td className={rtTd} data-label="Description">
                  {record.description ?? <span className="text-muted">No description</span>}
                  {record.status === "rejected" && record.rejectionReason && (
                    <span className="block text-xs text-[#B91C1C]">Rejected: {record.rejectionReason}</span>
                  )}
                </td>
                <td className={rtTd} data-label="Submitted by">
                  <PersonCell name={submittedByName} />
                </td>
                <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Date">
                  {formatDate(record.createdAt)}
                </td>
                <td className={`${rtTd} text-right font-semibold tabular-nums`} data-label="Amount">
                  {amount}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={ledgerStatus(record.status, reversalRow)} tone={ledgerTone(record.status, reversalRow)} />
                </td>
                <td className={`${rtTd} text-right`} data-actions="">
                  <span className="inline-flex flex-wrap items-center justify-end gap-2">
                    {canCreate && record.status === "draft" && (
                      <button
                        type="button"
                        className={ROW_BTN_PRIMARY}
                        disabled={working}
                        onClick={() => lifecycle(record.id, () => submitExpenseForApprovalAction(record.id), "Expense submitted for approval.")}
                      >
                        <Icon name="upload" width={16} height={16} />
                        {working ? "Submitting…" : "Submit for approval"}
                      </button>
                    )}
                    {canDecide && record.status === "pending_approval" && (
                      <>
                        <button
                          type="button"
                          className={ROW_BTN_PRIMARY}
                          disabled={working}
                          onClick={() => lifecycle(record.id, () => approveExpenseAction(record.id), "Expense approved.")}
                        >
                          <Icon name="check_circle" width={16} height={16} />
                          {working ? "Approving…" : "Approve"}
                        </button>
                        <button type="button" className={ROW_BTN_DANGER} disabled={working} onClick={() => setRejecting(record)}>
                          Reject
                        </button>
                      </>
                    )}
                    {/* Approvers correct any approved expense; whoever submitted
                        one can correct their own (enforced on the server). */}
                    {(canApprove || (canCreate && own)) && record.status === "approved" && !reversalRow && (
                      <CorrectionButtons
                        onReverse={() => setCorrection({ mode: "reverse", id: record.id, label: record.category, amount })}
                        onAdjust={() => setCorrection({ mode: "adjust", id: record.id, label: record.category, amount })}
                      />
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      <CorrectionDialog
        correction={correction}
        noun="expense"
        onClose={() => setCorrection(null)}
        reverse={(id, reason) => call(() => reverseExpenseRecordAction(id, reason))}
        adjust={(id, reason, cents) => call(() => adjustExpenseRecordAction(id, reason, cents))}
      />
      <ActionDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title="Reject expense"
        description="The expense is not paid out. The person who submitted it sees the reason."
        summary={
          rejecting
            ? [
                { label: "Expense", value: rejecting.category },
                { label: "Amount", value: formatMoney(rejecting.amountCents, rejecting.currency) },
              ]
            : undefined
        }
        submitLabel="Reject expense"
        pendingLabel="Rejecting…"
        danger
        rules={REASON_RULES}
        run={(data) => (rejecting ? call(() => rejectExpenseAction(rejecting.id, String(data.get("reason") ?? "").trim())) : Promise.resolve(null))}
        onDone={() => {
          showSuccessToast("Expense rejected.");
          setRejecting(null);
          router.refresh();
        }}
      >
        {({ errors, blur }) => <ReasonField errors={errors} blur={blur} placeholder="No receipt attached" />}
      </ActionDialog>
    </>
  );
}
