"use client";

import { useState, useTransition } from "react";
import {
  approveStudentPaymentAction,
  rejectStudentPaymentAction,
} from "@/lib/academies/student-payments-actions";
import type { StudentPaymentRecord } from "@/lib/academies/student-payments";
import { Button, ErrorMessage, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

interface Props {
  payments: StudentPaymentRecord[];
  /** studentId -> "Full Name (STD-XXXX)" — see page.tsx's own comment. */
  studentLabels: Record<string, string>;
  currentUserId: string;
}

const SELF_APPROVAL_TOOLTIP = "You can't approve a transaction you recorded.";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

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
export function PaymentApprovalsQueue({ payments: initialPayments, studentLabels, currentUserId }: Props) {
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
    <Section>
      {error && (
        <div className="mb-3">
          <ErrorMessage message={error} />
        </div>
      )}
      {payments.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No student payments are waiting for a decision.</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Student</th>
              <th className={th}>Amount</th>
              <th className={th}>Method</th>
              <th className={th}>Received</th>
              <th className={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => {
              const isSelfRecorded = payment.recordedBy === currentUserId;
              return (
                <tr key={payment.id} className={trHover}>
                  <td className={`${td} font-medium`}>{studentLabels[payment.studentId] ?? payment.studentId}</td>
                  <td className={td}>{formatMoney(payment.amountCents, payment.currency)}</td>
                  <td className={td}>{payment.method.replace("_", " ")}</td>
                  <td className={td}>{payment.receivedAt.toLocaleDateString()}</td>
                  <td className={td}>
                    {rejectingId === payment.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          placeholder="Rejection reason"
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                          className={`${inputClass} w-48 py-1.5`}
                        />
                        <Button
                          type="button"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending || rejectReason.trim() === ""}
                          onClick={() => handleReject(payment.id)}
                        >
                          Confirm reject
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => {
                            setRejectingId(null);
                            setRejectReason("");
                          }}
                        >
                          Back
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2" title={isSelfRecorded ? SELF_APPROVAL_TOOLTIP : undefined}>
                        <Button
                          type="button"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending || isSelfRecorded}
                          onClick={() => handleApprove(payment.id)}
                        >
                          Approve
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending}
                          onClick={() => setRejectingId(payment.id)}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Section>
  );
}
