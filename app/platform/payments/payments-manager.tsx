"use client";

import { useActionState, useState, useTransition } from "react";
import {
  recordSubscriptionPayment,
  verifySubscriptionPayment,
  rejectSubscriptionPayment,
  reverseSubscriptionPayment,
  type PaymentFormState,
} from "@/lib/subscriptions/payments-actions";
import type {
  AcademySubscriptionOption,
  SubscriptionPaymentRecord,
} from "@/lib/subscriptions/payments";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

const initialState: PaymentFormState = { ok: false };

interface Props {
  payments: SubscriptionPaymentRecord[];
  subscriptionOptions: AcademySubscriptionOption[];
  canVerify: boolean;
}

const STATUS_TONE: Record<string, "amber" | "green" | "red" | "slate" | "gray"> = {
  pending: "amber",
  verified: "green",
  rejected: "red",
  reversed: "slate",
};

// DESIGN.md §8: "/platform/payments | A + C | Record-Payment form: academy,
// subscription, amount (USD, cents-precise), method, reference, received
// date, notes, optional evidence upload... Row actions: Verify / Reject /
// Reverse, each with a reason-required confirmation." Follows
// app/platform/plans/plans-manager.tsx's style: useActionState for the
// create form, useTransition for the row actions.
export function PaymentsManager({ payments, subscriptionOptions, canVerify }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <Section>
        <h2 className="text-base font-semibold text-ink">Record payment</h2>
        <div className="mt-4">
          <RecordPaymentForm subscriptionOptions={subscriptionOptions} />
        </div>
      </Section>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink">Payment history</h2>
        {payments.length === 0 ? (
          <Section>
            <p className="text-sm text-muted">No payments recorded yet.</p>
          </Section>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Received</th>
                <th className={th}>Amount</th>
                <th className={th}>Method</th>
                <th className={th}>Reference</th>
                <th className={th}>Evidence</th>
                <th className={th}>Status</th>
                {canVerify && <th className={th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} canVerify={canVerify} />
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </div>
  );
}

function PaymentRow({
  payment,
  canVerify,
}: {
  payment: SubscriptionPaymentRecord;
  canVerify: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pendingReasonFor, setPendingReasonFor] = useState<
    "verify" | "reject" | "reverse" | null
  >(null);

  function runAction(
    kind: "verify" | "reject" | "reverse",
    action: (id: string, reason: string) => Promise<{ ok: true } | { ok: false; error: { message: string } }>,
  ) {
    const reason = window.prompt(
      `Reason for ${kind === "verify" ? "verifying" : kind === "reject" ? "rejecting" : "reversing"} this payment:`,
    );
    if (reason === null) return; // cancelled
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }

    setError(null);
    setPendingReasonFor(kind);
    startTransition(async () => {
      const result = await action(payment.id, reason);
      if (!result.ok) {
        setError(result.error.message);
      }
      setPendingReasonFor(null);
    });
  }

  return (
    <>
      <tr className={trHover}>
        <td className={td}>{new Date(payment.receivedAt).toLocaleDateString()}</td>
        <td className={`${td} font-medium`}>
          {(payment.amountCents / 100).toFixed(2)} {payment.currency}
        </td>
        <td className={td}>{payment.paymentMethod}</td>
        <td className={td}>{payment.paymentReference ?? "—"}</td>
        <td className={td}>{payment.evidenceFileRef ? "Attached" : "—"}</td>
        <td className={td}>
          <Badge label={payment.status} tone={STATUS_TONE[payment.status] ?? "gray"} />
        </td>
        {canVerify && (
          <td className={td}>
            <div className="flex flex-wrap items-center gap-2">
              {payment.status === "pending" && (
                <>
                  <Button
                    type="button"
                    className="px-2.5 py-1 text-xs"
                    disabled={isPending}
                    onClick={() => runAction("verify", verifySubscriptionPayment)}
                  >
                    {isPending && pendingReasonFor === "verify" ? "Verifying..." : "Verify"}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="px-2.5 py-1 text-xs"
                    disabled={isPending}
                    onClick={() => runAction("reject", rejectSubscriptionPayment)}
                  >
                    {isPending && pendingReasonFor === "reject" ? "Rejecting..." : "Reject"}
                  </Button>
                </>
              )}
              {payment.status === "verified" && (
                <Button
                  type="button"
                  variant="danger"
                  className="px-2.5 py-1 text-xs"
                  disabled={isPending}
                  onClick={() => runAction("reverse", reverseSubscriptionPayment)}
                >
                  {isPending && pendingReasonFor === "reverse" ? "Reversing..." : "Reverse"}
                </Button>
              )}
              {payment.status !== "pending" && payment.status !== "verified" && (
                <span className="text-muted">—</span>
              )}
            </div>
          </td>
        )}
      </tr>
      {error && (
        <tr>
          <td colSpan={canVerify ? 7 : 6} className="px-4 py-2">
            <ErrorMessage message={error} />
          </td>
        </tr>
      )}
    </>
  );
}

function RecordPaymentForm({
  subscriptionOptions,
}: {
  subscriptionOptions: AcademySubscriptionOption[];
}) {
  const [state, formAction, pending] = useActionState(
    recordSubscriptionPayment,
    initialState,
  );
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState("");
  const selectedOption = subscriptionOptions.find(
    (option) => option.subscriptionId === selectedSubscriptionId,
  );

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-3">
      <Field label="Academy / subscription">
        <select
          name="subscriptionId"
          required
          value={selectedSubscriptionId}
          onChange={(event) => setSelectedSubscriptionId(event.target.value)}
          className={inputClass}
        >
          <option value="" disabled>
            Select a subscription
          </option>
          {subscriptionOptions.map((option) => (
            <option key={option.subscriptionId} value={option.subscriptionId}>
              {option.academyName} — {option.planName} ({option.status})
            </option>
          ))}
        </select>
      </Field>
      <input type="hidden" name="academyId" value={selectedOption?.academyId ?? ""} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Amount (in cents)">
          <input type="number" name="amountCents" min={0} step={1} required className={inputClass} />
        </Field>
        <Field label="Currency (3-letter code)">
          <input type="text" name="currency" maxLength={3} required defaultValue="USD" className={inputClass} />
        </Field>
      </div>

      <Field label="Payment method">
        <input
          type="text"
          name="paymentMethod"
          placeholder="bank_transfer, mobile_money, cash, ..."
          required
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Reference">
          <input type="text" name="paymentReference" className={inputClass} />
        </Field>
        <Field label="Received date">
          <input type="date" name="receivedAt" required className={inputClass} />
        </Field>
      </div>

      <Field label="Evidence file reference (optional — no upload storage yet)">
        <input type="text" name="evidenceFileRef" className={inputClass} />
      </Field>

      <Field label="Notes">
        <textarea name="notes" rows={3} className={inputClass} />
      </Field>

      {state.error && <ErrorMessage message={state.error.message} />}
      {state.ok && <p className="text-sm font-medium text-success">Payment recorded.</p>}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Recording..." : "Record payment"}
      </Button>
    </form>
  );
}
