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

const initialState: PaymentFormState = { ok: false };

interface Props {
  payments: SubscriptionPaymentRecord[];
  subscriptionOptions: AcademySubscriptionOption[];
  canVerify: boolean;
}

// DESIGN.md §8: "/platform/payments | A + C | Record-Payment form: academy,
// subscription, amount (USD, cents-precise), method, reference, received
// date, notes, optional evidence upload... Row actions: Verify / Reject /
// Reverse, each with a reason-required confirmation." Follows
// app/platform/plans/plans-manager.tsx's style: useActionState for the
// create form, useTransition for the row actions.
export function PaymentsManager({ payments, subscriptionOptions, canVerify }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem" }}>
      <section>
        <h2>Record payment</h2>
        <RecordPaymentForm subscriptionOptions={subscriptionOptions} />
      </section>

      <section>
        <h2>Payment history</h2>
        {payments.length === 0 ? (
          <p>No payments recorded yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Received</th>
                <th style={{ textAlign: "left" }}>Amount</th>
                <th style={{ textAlign: "left" }}>Method</th>
                <th style={{ textAlign: "left" }}>Reference</th>
                <th style={{ textAlign: "left" }}>Evidence</th>
                <th style={{ textAlign: "left" }}>Status</th>
                {canVerify && <th style={{ textAlign: "left" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} canVerify={canVerify} />
              ))}
            </tbody>
          </table>
        )}
      </section>
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
      <tr>
        <td>{new Date(payment.receivedAt).toLocaleDateString()}</td>
        <td>
          {(payment.amountCents / 100).toFixed(2)} {payment.currency}
        </td>
        <td>{payment.paymentMethod}</td>
        <td>{payment.paymentReference ?? "—"}</td>
        <td>{payment.evidenceFileRef ? "Attached" : "—"}</td>
        <td>{payment.status}</td>
        {canVerify && (
          <td>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {payment.status === "pending" && (
                <>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runAction("verify", verifySubscriptionPayment)}
                  >
                    {isPending && pendingReasonFor === "verify" ? "Verifying..." : "Verify"}
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runAction("reject", rejectSubscriptionPayment)}
                  >
                    {isPending && pendingReasonFor === "reject" ? "Rejecting..." : "Reject"}
                  </button>
                </>
              )}
              {payment.status === "verified" && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => runAction("reverse", reverseSubscriptionPayment)}
                >
                  {isPending && pendingReasonFor === "reverse" ? "Reversing..." : "Reverse"}
                </button>
              )}
              {payment.status !== "pending" && payment.status !== "verified" && "—"}
            </div>
          </td>
        )}
      </tr>
      {error && (
        <tr>
          <td colSpan={canVerify ? 7 : 6} role="alert" style={{ color: "crimson" }}>
            {error}
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
    <form
      action={formAction}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: 480,
      }}
    >
      <label>
        Academy / subscription
        <select
          name="subscriptionId"
          required
          value={selectedSubscriptionId}
          onChange={(event) => setSelectedSubscriptionId(event.target.value)}
          style={{ display: "block", width: "100%" }}
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
      </label>
      <input type="hidden" name="academyId" value={selectedOption?.academyId ?? ""} />

      <label>
        Amount (in cents)
        <input
          type="number"
          name="amountCents"
          min={0}
          step={1}
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Currency (3-letter code)
        <input
          type="text"
          name="currency"
          maxLength={3}
          required
          defaultValue="USD"
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Payment method
        <input
          type="text"
          name="paymentMethod"
          placeholder="bank_transfer, mobile_money, cash, ..."
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Reference
        <input
          type="text"
          name="paymentReference"
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Received date
        <input
          type="date"
          name="receivedAt"
          required
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Evidence file reference (optional — no upload storage yet)
        <input
          type="text"
          name="evidenceFileRef"
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Notes
        <textarea name="notes" style={{ display: "block", width: "100%" }} />
      </label>

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}
      {state.ok && <p style={{ color: "green" }}>Payment recorded.</p>}

      <button type="submit" disabled={pending}>
        {pending ? "Recording..." : "Record payment"}
      </button>
    </form>
  );
}
