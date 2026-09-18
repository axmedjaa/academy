"use client";

import { useState, useTransition } from "react";
import {
  approveStudentPaymentAction,
  rejectStudentPaymentAction,
} from "@/lib/academies/student-payments-actions";
import type { StudentPaymentRecord } from "@/lib/academies/student-payments";
import { Card, EmptyState, ErrorMessage, PrimaryButton, SecondaryButton } from "@/app/academy/_shell/ui";
import { color, spacing } from "@/lib/ui/theme";

interface Props {
  payments: StudentPaymentRecord[];
  currentUserId: string;
}

const SELF_APPROVAL_TOOLTIP = "You can't approve a transaction you recorded.";

/**
 * DESIGN.md §3 "Approval queue": "a filtered list view (submitted-but-
 * undecided items) with an Approve/Reject action pair per row; Reject
 * always opens a modal requiring a reason; the actor's own submissions are
 * visually excluded or shown with Approve disabled + tooltip." Same
 * reveal-then-confirm reject pattern as
 * app/academy/results/results-list.tsx's Reject flow and
 * app/academy/certificates/certificates-list.tsx's Cancel flow — no new
 * modal component is introduced, per this task's "do not introduce a new
 * UI library" constraint.
 *
 * Approve is a single confirm-and-fire button (no separate confirmation
 * step) — DESIGN.md's own component spec only requires a modal for Reject
 * ("Reject always opens a modal requiring a reason"), not Approve.
 *
 * Acted-upon rows are removed from local state on success rather than
 * re-fetching the whole list — the server action's own `revalidatePath`
 * (lib/academies/student-payments-actions.ts) keeps a later full page load
 * correct; this local update is just what makes THIS render immediately
 * reflect the outcome without a full round trip.
 */
export function PaymentApprovalsQueue({ payments: initialPayments, currentUserId }: Props) {
  const [payments, setPayments] = useState(initialPayments);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function handleApprove(paymentId: string) {
    setError(null);
    startTransition(async () => {
      const result = await approveStudentPaymentAction(paymentId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPayments((prev) => prev.filter((payment) => payment.id !== paymentId));
    });
  }

  function handleReject(paymentId: string) {
    setError(null);
    startTransition(async () => {
      const result = await rejectStudentPaymentAction(paymentId, rejectReason.trim());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPayments((prev) => prev.filter((payment) => payment.id !== paymentId));
      setRejectingId(null);
      setRejectReason("");
    });
  }

  return (
    <Card>
      {error && (
        <div style={{ marginBottom: spacing.sm }}>
          <ErrorMessage message={error} />
        </div>
      )}
      {payments.length === 0 ? (
        <EmptyState message="No student payments are waiting for a decision." />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: `1px solid ${color.border}` }}>
                <th style={{ padding: "0.4rem 0" }}>Student</th>
                <th style={{ padding: "0.4rem 0" }}>Amount</th>
                <th style={{ padding: "0.4rem 0" }}>Method</th>
                <th style={{ padding: "0.4rem 0" }}>Received</th>
                <th style={{ padding: "0.4rem 0" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const isSelfRecorded = payment.recordedBy === currentUserId;
                return (
                  <tr key={payment.id} style={{ borderBottom: `1px solid ${color.border}` }}>
                    <td style={{ padding: "0.5rem 0" }}>{payment.studentId}</td>
                    <td style={{ padding: "0.5rem 0" }}>
                      {payment.currency} {(payment.amountCents / 100).toFixed(2)}
                    </td>
                    <td style={{ padding: "0.5rem 0" }}>{payment.method.replace("_", " ")}</td>
                    <td style={{ padding: "0.5rem 0" }}>{payment.receivedAt.toLocaleDateString()}</td>
                    <td style={{ padding: "0.5rem 0" }}>
                      {rejectingId === payment.id ? (
                        <div style={{ display: "flex", gap: spacing.xs, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            type="text"
                            placeholder="Rejection reason"
                            value={rejectReason}
                            onChange={(event) => setRejectReason(event.target.value)}
                            style={{ minWidth: 200 }}
                          />
                          <PrimaryButton
                            type="button"
                            disabled={isPending || rejectReason.trim() === ""}
                            onClick={() => handleReject(payment.id)}
                          >
                            Confirm reject
                          </PrimaryButton>
                          <SecondaryButton
                            type="button"
                            onClick={() => {
                              setRejectingId(null);
                              setRejectReason("");
                            }}
                          >
                            Back
                          </SecondaryButton>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: spacing.xs, alignItems: "center" }}>
                          <PrimaryButton
                            type="button"
                            disabled={isPending || isSelfRecorded}
                            title={isSelfRecorded ? SELF_APPROVAL_TOOLTIP : undefined}
                            onClick={() => handleApprove(payment.id)}
                          >
                            Approve
                          </PrimaryButton>
                          <SecondaryButton
                            type="button"
                            disabled={isPending}
                            onClick={() => setRejectingId(payment.id)}
                          >
                            Reject
                          </SecondaryButton>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
