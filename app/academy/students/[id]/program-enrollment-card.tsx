"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ProgramRefundPosition, StudentProgramEnrollment } from "@/lib/academies/program-enrollments";
import {
  getProgramRefundPositionAction,
  recordProgramPaymentAction,
  withdrawFromProgramAction,
} from "@/lib/academies/program-enrollments-actions";
import { formatDate } from "@/lib/ui/date";
import { dollarsToCents, formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { showSuccessToast } from "@/lib/ui/toast";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { Badge, Button, Section } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChangeFeeButton } from "@/app/academy/finance/fee-periods/change-fee";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
} from "@/app/academy/_shell/design-form";

/**
 * A student's complete-program enrollment (migration 0049): the program and
 * its batch, the included courses (each with its own instructor and dates —
 * academic only, no course fees), and the ONE program fee: fee, discount,
 * final fee, monthly installments with their status, paid / outstanding,
 * payment history with receipts. Staff who may take money can record a
 * payment (applied to the oldest unpaid installments first); staff who may
 * manage enrollments can withdraw the student, optionally recording a refund
 * of money already returned. Every action is re-checked on the server.
 */

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "bank_transfer", label: "Bank transfer" },
] as const;
type Method = (typeof METHODS)[number]["value"];
const methodLabel = (value: string) => METHODS.find((option) => option.value === value)?.label ?? value;

const STATUS_BADGE: Record<string, { label: string; tone: "green" | "amber" | "gray" | "red" | "blue" | "slate" }> = {
  paid: { label: "Fully paid", tone: "green" },
  partially_paid: { label: "Partially paid", tone: "amber" },
  unpaid: { label: "Unpaid", tone: "gray" },
  overdue: { label: "Overdue", tone: "red" },
};

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function RecordProgramPaymentDialog({
  enrollment,
  open,
  onOpenChange,
}: {
  enrollment: StudentProgramEnrollment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const billing = enrollment.billing!;
  const nextDue = billing.periods.find((period) => period.remainingCents > 0) ?? null;
  const [amount, setAmount] = useState(nextDue ? (nextDue.remainingCents / 100).toFixed(2) : "");
  const [method, setMethod] = useState<Method | "">("");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(amount);
    if (!cents || cents <= 0) return setError("Enter the amount received, for example 40.");
    if (cents > billing.outstandingCents) return setError(`That's more than the outstanding ${formatMoney(billing.outstandingCents, billing.currency)}.`);
    if (!method) return setError("Choose how the payment was made.");
    setError(null);
    startTransition(async () => {
      try {
        const result = await recordProgramPaymentAction({
          programEnrollmentId: enrollment.id,
          amountCents: cents,
          method,
          reference,
          receivedAt: new Date(`${receivedOn}T12:00:00Z`).toISOString(),
          idempotencyKey: key,
        });
        if (!result.ok) return setError(result.error?.message ?? "The payment couldn't be recorded.");
        showSuccessToast("Program payment recorded.");
        onOpenChange(false);
        router.refresh();
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record program payment"
      description={`${enrollment.programName}: outstanding ${formatMoney(billing.outstandingCents, billing.currency)}. The payment covers the oldest unpaid installments first.`}
    >
      <form noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody>
          <FieldGrid>
            <DField label={`Amount received (${billing.currency})`} name="program-pay-amount" required>
              <input type="text" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={controlClass(false)} />
            </DField>
            <DField label="Payment method" name="program-pay-method" required>
              <select value={method} onChange={(event) => setMethod(event.target.value as Method | "")} className={controlClass(false)}>
                <option value="">Choose a method</option>
                {METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </DField>
            <DField label="Received on" name="program-pay-date" required>
              <input type="date" value={receivedOn} max={todayIso()} onChange={(event) => setReceivedOn(event.target.value)} className={controlClass(false)} />
            </DField>
            <DField label="Reference (optional)" name="program-pay-ref">
              <input type="text" maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} className={controlClass(false)} />
            </DField>
          </FieldGrid>
          <FormErrorBanner message={error} />
        </DialogBody>
        <DialogFooter onCancel={() => onOpenChange(false)} submitLabel="Record payment" pendingLabel="Recording…" pending={pending} />
      </form>
    </DesignDialog>
  );
}

function WithdrawProgramDialog({
  enrollment,
  canRefund,
  open,
  onOpenChange,
}: {
  enrollment: StudentProgramEnrollment;
  canRefund: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [withRefund, setWithRefund] = useState(false);
  const [position, setPosition] = useState<ProgramRefundPosition | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState<Method | "">("");
  const [refundedOn, setRefundedOn] = useState(todayIso());
  const [refundReason, setRefundReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [pending, startTransition] = useTransition();

  function toggleRefund(next: boolean) {
    setWithRefund(next);
    if (next && !position) {
      startTransition(async () => {
        const result = await getProgramRefundPositionAction(enrollment.id);
        if (result.ok) setPosition(result.position);
        else setError(result.error.message);
      });
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return setError("Enter why the student is leaving the program.");
    let refund: Parameters<typeof withdrawFromProgramAction>[0]["refund"];
    if (withRefund) {
      const cents = dollarsToCents(refundAmount);
      if (!cents || cents <= 0) return setError("Enter the refund amount.");
      if (position && cents > position.refundableCents) {
        return setError(`At most ${formatMoney(position.refundableCents, position.currency ?? enrollment.billing?.currency ?? "USD")} can be refunded.`);
      }
      if (!refundMethod) return setError("Choose how the refund was paid.");
      if (!refundReason.trim()) return setError("Enter a reason for the refund.");
      refund = { amountCents: cents, method: refundMethod, refundedAt: refundedOn, reason: refundReason, idempotencyKey: key };
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await withdrawFromProgramAction({ programEnrollmentId: enrollment.id, reason, refund }, enrollment.studentId);
        if (!result.ok) return setError(result.error?.message ?? "The student couldn't be withdrawn.");
        showSuccessToast(refund ? "Withdrawn from the program and refund recorded." : "Withdrawn from the program.");
        onOpenChange(false);
        router.refresh();
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const currency = position?.currency ?? enrollment.billing?.currency ?? "USD";
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Withdraw from ${enrollment.programName}?`}
      description="The program and its courses are marked withdrawn. Payments, receipts and installments are kept as they are."
    >
      <form noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody>
          <FieldGrid>
            <DField label="Reason" name="program-withdraw-reason" required full>
              <input type="text" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} className={controlClass(false)} />
            </DField>
            {canRefund && enrollment.billing && (
              <label className="col-span-full flex min-h-11 items-center gap-2 text-sm font-medium text-ink">
                <input type="checkbox" checked={withRefund} onChange={(event) => toggleRefund(event.target.checked)} />
                Record a refund of money already returned to the student
              </label>
            )}
            {withRefund && (
              <>
                <p className="col-span-full text-[13px] text-muted">
                  {position
                    ? `Paid ${formatMoney(position.paidCents, currency)}, already refunded ${formatMoney(position.refundedCents, currency)}, refundable ${formatMoney(position.refundableCents, currency)}.`
                    : "Loading what can be refunded…"}
                </p>
                <DField label={`Refund amount (${currency})`} name="program-refund-amount" required>
                  <input type="text" inputMode="decimal" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} className={controlClass(false)} />
                </DField>
                <DField label="Refund method" name="program-refund-method" required>
                  <select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as Method | "")} className={controlClass(false)}>
                    <option value="">Choose a method</option>
                    {METHODS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </DField>
                <DField label="Refunded on" name="program-refund-date" required>
                  <input type="date" value={refundedOn} max={todayIso()} onChange={(event) => setRefundedOn(event.target.value)} className={controlClass(false)} />
                </DField>
                <DField label="Refund reason" name="program-refund-reason" required>
                  <input type="text" maxLength={500} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} className={controlClass(false)} />
                </DField>
              </>
            )}
          </FieldGrid>
          <FormErrorBanner message={error} />
        </DialogBody>
        <DialogFooter onCancel={() => onOpenChange(false)} submitLabel="Withdraw" pendingLabel="Withdrawing…" pending={pending} />
      </form>
    </DesignDialog>
  );
}

export function ProgramEnrollmentCard({
  enrollment,
  canRecordPayment,
  canWithdraw,
  canRefund,
}: {
  enrollment: StudentProgramEnrollment;
  canRecordPayment: boolean;
  canWithdraw: boolean;
  canRefund: boolean;
}) {
  const [payOpen, setPayOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const billing = enrollment.billing;
  const active = enrollment.status === "active";
  const status = billing ? STATUS_BADGE[billing.status] : null;

  return (
    <Section className="mb-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-[0.08em] text-brand">Complete program</div>
          <h2 className="text-lg font-semibold text-ink">{enrollment.programName}</h2>
          <p className="text-[13px] text-muted">
            Batch{" "}
            <Link href={`/academy/batches/${enrollment.batchId}`} className="font-semibold !text-brand no-underline hover:underline">
              {enrollment.batchName}
            </Link>{" "}
            ({enrollment.batchCode}) · enrolled {formatDate(enrollment.enrolledAt)}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <Badge label={enrollment.status} tone={active ? "green" : "gray"} />
          {enrollment.scholarship && <Badge label={enrollment.scholarship === "full" ? "Full scholarship" : "Partial scholarship"} tone="blue" />}
          {status && <Badge label={status.label} tone={status.tone} />}
        </span>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-ink">Included courses</h3>
      <DataTable stackBelow={600}>
        <thead>
          <tr>
            <th className={rtTh}>Course</th>
            <th className={rtTh}>Instructor</th>
            <th className={rtTh}>Start date</th>
            <th className={rtTh}>End date</th>
          </tr>
        </thead>
        <tbody>
          {enrollment.courses.map((course) => (
            <tr key={course.enrollmentId}>
              <td className={`${rtTd} font-semibold`} data-label="Course">
                {course.courseName}
                {course.status !== "active" && <span className="ml-2 text-xs font-normal text-muted">({course.status})</span>}
              </td>
              <td className={rtTd} data-label="Instructor">
                {course.instructorName ?? <span className="text-muted">Not assigned</span>}
              </td>
              <td className={`${rtTd} whitespace-nowrap`} data-label="Start date">
                {course.startDate ? formatDate(course.startDate) : <span className="text-muted">Not set</span>}
              </td>
              <td className={`${rtTd} whitespace-nowrap`} data-label="End date">
                {course.endDate ? formatDate(course.endDate) : <span className="text-muted">Not set</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p className="mb-5 mt-2 text-xs text-muted">These courses are part of the program. They have no separate fees.</p>

      {billing && enrollment.scholarship === "full" && billing.periods.length === 0 ? (
        <p className="text-[13px] text-muted">Full scholarship: this program is free and nothing is ever due.</p>
      ) : billing ? (
        <>
          <h3 className="mb-2 text-sm font-semibold text-ink">Program fee</h3>
          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            {(
              [
                ["Program fee", formatMoney(billing.programFeeCents, billing.currency)],
                [enrollment.scholarship === "partial" ? "Scholarship" : "Discount", formatMoney(billing.discountCents, billing.currency)],
                ["Final fee", formatMoney(billing.finalFeeCents, billing.currency)],
                [
                  "Plan",
                  billing.periods.length === billing.installments
                    ? describePaymentPlan(billing.finalFeeCents, billing.installments, billing.currency)
                    : `${billing.periods.length} installment${billing.periods.length === 1 ? "" : "s"}`,
                ],
                ["Paid", formatMoney(billing.paidCents, billing.currency)],
                ["Outstanding", formatMoney(billing.outstandingCents, billing.currency)],
                ["Overdue", formatMoney(billing.overdueCents, billing.currency)],
                ["Refunded", formatMoney(billing.refundedCents, billing.currency)],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="font-semibold tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>

          <details className="mb-4 rounded-xl border border-border">
            <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold text-ink">
              Installments ({billing.periods.filter((period) => period.remainingCents === 0).length} of {billing.periods.length} paid)
            </summary>
            <div className="px-3 pb-3">
              <DataTable stackBelow={600}>
                <thead>
                  <tr>
                    <th className={rtTh}>Due</th>
                    <th className={rtTh}>Amount</th>
                    <th className={rtTh}>Paid</th>
                    <th className={rtTh}>Remaining</th>
                    <th className={rtTh}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.periods.map((period) => (
                    <tr key={period.id}>
                      <td className={`${rtTd} whitespace-nowrap`} data-label="Due">
                        {formatDate(period.dueDate)}
                      </td>
                      <td className={`${rtTd} tabular-nums`} data-label="Amount">
                        {formatMoney(period.expectedAmountCents, billing.currency)}
                      </td>
                      <td className={`${rtTd} tabular-nums`} data-label="Paid">
                        {formatMoney(period.paidCents, billing.currency)}
                      </td>
                      <td className={`${rtTd} tabular-nums`} data-label="Remaining">
                        {formatMoney(period.remainingCents, billing.currency)}
                      </td>
                      <td className={rtTd} data-label="Status">
                        <Badge label={STATUS_BADGE[period.status]?.label ?? period.status} tone={STATUS_BADGE[period.status]?.tone ?? "gray"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </div>
          </details>

          <h3 className="mb-2 text-sm font-semibold text-ink">Program payments</h3>
          {billing.payments.length === 0 ? (
            <p className="mb-4 text-[13px] text-muted">No payments recorded yet.</p>
          ) : (
            <DataTable stackBelow={600}>
              <thead>
                <tr>
                  <th className={rtTh}>Received</th>
                  <th className={rtTh}>Amount</th>
                  <th className={rtTh}>Method</th>
                  <th className={rtTh}>Status</th>
                  <th className={rtTh}>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {billing.payments.map((payment) => (
                  <tr key={payment.paymentId}>
                    <td className={`${rtTd} whitespace-nowrap`} data-label="Received">
                      {formatDate(payment.receivedAt)}
                    </td>
                    <td className={`${rtTd} tabular-nums`} data-label="Amount">
                      {formatMoney(payment.amountCents, payment.currency)}
                      {payment.refundedCents > 0 && (
                        <span className="block text-xs text-muted">Refunded {formatMoney(payment.refundedCents, payment.currency)}</span>
                      )}
                    </td>
                    <td className={rtTd} data-label="Method">
                      {methodLabel(payment.method)}
                    </td>
                    <td className={rtTd} data-label="Status">
                      <Badge label={payment.status === "approved" ? "Posted" : payment.status} tone={payment.status === "approved" ? "green" : "gray"} />
                    </td>
                    <td className={rtTd} data-label="Receipt">
                      {payment.receiptId ? (
                        <Link href={`/academy/receipts/${payment.receiptId}`} target="_blank" className="font-semibold !text-brand no-underline hover:underline">
                          {payment.receiptNumber}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      ) : (
        <p className="text-[13px] text-muted">Program fee details are visible to finance staff.</p>
      )}

      {active && (canRecordPayment || canWithdraw) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canRecordPayment && billing && billing.outstandingCents > 0 && (
            <Button type="button" onClick={() => setPayOpen(true)}>
              Record payment
            </Button>
          )}
          {canRecordPayment && (
            <ChangeFeeButton
              target={{ kind: "program", programEnrollmentId: enrollment.id }}
              studentName={enrollment.programName}
              label={`${enrollment.batchCode} · Program · ${enrollment.programName}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app"
            />
          )}
          {canWithdraw && (
            <Button type="button" variant="danger" onClick={() => setWithdrawOpen(true)}>
              Withdraw from program
            </Button>
          )}
        </div>
      )}

      {payOpen && billing && <RecordProgramPaymentDialog enrollment={enrollment} open={payOpen} onOpenChange={setPayOpen} />}
      {withdrawOpen && (
        <WithdrawProgramDialog enrollment={enrollment} canRefund={canRefund} open={withdrawOpen} onOpenChange={setWithdrawOpen} />
      )}
    </Section>
  );
}
