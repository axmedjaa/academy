"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  createStudentChargeAction,
  issueReceiptAction,
  recordStudentPaymentAction,
  type StudentPaymentsFormState,
} from "@/lib/academies/student-payments-actions";
import type { StudentChargeRecord, StudentPaymentRecord } from "@/lib/academies/student-payments";
import { adjustStudentPaymentAction, reverseStudentPaymentAction } from "@/lib/academies/finance-reversals-actions";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  LinkButton,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { dollarsToCents } from "@/lib/ui/money";

const initialState: StudentPaymentsFormState = { ok: false };

const SELF_REVERSAL_TOOLTIP = "You can't reverse or adjust a payment you recorded yourself.";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

interface Props {
  charges: StudentChargeRecord[];
  payments: StudentPaymentRecord[];
  /** studentId -> "Full Name (STD-XXXX)", resolved server-side once for
   * every student referenced by any charge/payment (see page.tsx's own
   * comment) — falls back to the raw id if a student was somehow deleted
   * out from under an existing charge/payment row. */
  studentLabels: Record<string, string>;
  /** Active students for the Create Charge/Record Payment forms' student
   * picker — see page.tsx's own comment. */
  studentOptions: StudentPickerOption[];
  /** paymentId -> "Course — Batch" for a fee-period-linked payment; absent
   * for a charge-linked (or unlinked) payment — see page.tsx's own comment
   * on why this is a display-only, separately-resolved lookup. */
  courseByPayment: Record<string, string>;
  /** paymentId -> already-issued receipt, for the Receipt column's
   * View/Issue toggle — see page.tsx's own comment. */
  receiptsByPayment: Record<string, { id: string; receiptNumber: string }>;
  /** Only "full"/"manage" callers (Manager/Finance Officer/Academy
   * Administrator) get create/record/issue controls — Owner/Trainer are
   * read-only here, per this row's View/Manage/Full/—/Manage/View matrix
   * (Administrator raised from view-only to manage-level per the manual
   * student-payment verification report). */
  canManage: boolean;
  /** Manager-only ("full" level exactly — Finance Officer's "manage" does
   * not reach this). Gates Reverse/Adjust, which
   * lib/academies/finance-reversals.ts's `canReversePayment` requires the
   * exact same level for. Not an approval gate — there is no approval
   * workflow for student payments anymore. */
  canReverse: boolean;
  /** For the self-reversal visual-disable + tooltip (DESIGN.md §9.6/§11.7)
   * — the backend (`reverseStudentPayment`/`adjustStudentPayment`) already
   * refuses this unconditionally; this is presentation only. */
  currentUserId: string;
}

export function FinanceChargesPayments({
  charges,
  payments,
  studentLabels,
  studentOptions,
  courseByPayment,
  receiptsByPayment,
  canManage,
  canReverse,
  currentUserId,
}: Props) {
  const [tab, setTab] = useState<"charges" | "payments">("charges");
  const [createChargeState, createChargeFormAction, creatingCharge] = useActionState(
    createStudentChargeAction,
    initialState,
  );
  const [recordPaymentState, recordPaymentFormAction, recordingPayment] = useActionState(
    recordStudentPaymentAction,
    initialState,
  );
  const [chargeStudentId, setChargeStudentId] = useState("");
  // Narrows the "Charge id" picker below to that student's own open/
  // partially-paid charges — "" (no selection yet) shows every payable
  // charge across all students, each already labeled with its own student
  // name, so there's still something useful to pick from immediately.
  const [paymentStudentId, setPaymentStudentId] = useState("");
  const payableCharges = charges.filter(
    (charge) =>
      (charge.status === "open" || charge.status === "partially_paid") &&
      (paymentStudentId === "" || charge.studentId === paymentStudentId),
  );
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuedReceipts, setIssuedReceipts] = useState<Map<string, { id: string; receiptNumber: string }>>(new Map());

  const [isReversalPending, startReversalTransition] = useTransition();
  const [reversalError, setReversalError] = useState<string | null>(null);
  const [reversalRowId, setReversalRowId] = useState<string | null>(null);
  const [reversalMode, setReversalMode] = useState<"reverse" | "adjust" | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [reversedIds, setReversedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (createChargeState.ok) {
      showSuccessToast("Charge created.");
    } else if (createChargeState.error) {
      showErrorToast(createChargeState.error.message);
    }
  }, [createChargeState]);

  useEffect(() => {
    if (recordPaymentState.ok) {
      showSuccessToast("Payment recorded.");
    } else if (recordPaymentState.error) {
      showErrorToast(recordPaymentState.error.message);
    }
  }, [recordPaymentState]);

  function studentLabel(studentId: string): string {
    return studentLabels[studentId] ?? studentId;
  }

  async function handleIssueReceipt(paymentId: string) {
    setIssuingId(paymentId);
    setIssueError(null);
    const result = await issueReceiptAction(paymentId);
    setIssuingId(null);
    if (!result.ok) {
      setIssueError(result.error.message);
      showErrorToast(result.error.message);
      return;
    }
    setIssuedReceipts((prev) => new Map(prev).set(paymentId, { id: result.receiptId, receiptNumber: result.receiptNumber }));
    showSuccessToast("Receipt issued.");
  }

  function startReversal(paymentId: string, mode: "reverse" | "adjust") {
    setReversalError(null);
    setReversalRowId(paymentId);
    setReversalMode(mode);
    setReversalReason("");
    setAdjustAmount("");
  }

  function cancelReversal() {
    setReversalRowId(null);
    setReversalMode(null);
    setReversalReason("");
    setAdjustAmount("");
  }

  function confirmReversal(paymentId: string) {
    setReversalError(null);
    // The "corrected amount" field is entered in dollars, not cents — see
    // lib/ui/money.ts's dollarsToCents.
    if (reversalMode === "adjust" && dollarsToCents(adjustAmount) === null) {
      setReversalError("Enter a valid corrected amount.");
      return;
    }
    startReversalTransition(async () => {
      const result =
        reversalMode === "adjust"
          ? await adjustStudentPaymentAction(paymentId, reversalReason.trim(), dollarsToCents(adjustAmount)!)
          : await reverseStudentPaymentAction(paymentId, reversalReason.trim());
      if (!result.ok) {
        setReversalError(result.error.message);
        showErrorToast(result.error.message);
        return;
      }
      setReversedIds((prev) => new Set(prev).add(paymentId));
      showSuccessToast(reversalMode === "adjust" ? "Payment adjusted." : "Payment reversed.");
      cancelReversal();
    });
  }

  return (
    <Section>
      <div className="mb-4 flex gap-2">
        <Button
          type="button"
          variant={tab === "charges" ? "primary" : "secondary"}
          className="px-3 py-1.5 text-xs"
          onClick={() => setTab("charges")}
        >
          Charges
        </Button>
        <Button
          type="button"
          variant={tab === "payments" ? "primary" : "secondary"}
          className="px-3 py-1.5 text-xs"
          onClick={() => setTab("payments")}
        >
          Payments
        </Button>
      </div>

      {tab === "charges" && (
        <div key="charges" className="motion-safe:animate-fade-in">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Student</th>
                <th className={th}>Description</th>
                <th className={th}>Amount</th>
                <th className={th}>Due date</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.length === 0 ? (
                <tr>
                  <td colSpan={5} className={`${td} text-center text-muted`}>
                    No charges to show.
                  </td>
                </tr>
              ) : (
                charges.map((charge) => (
                  <tr key={charge.id} className={trHover}>
                    <td className={`${td} font-medium`}>{studentLabel(charge.studentId)}</td>
                    <td className={td}>{charge.description}</td>
                    <td className={td}>{formatMoney(charge.amountCents, charge.currency)}</td>
                    <td className={td}>{charge.dueDate ?? "—"}</td>
                    <td className={td}>
                      <Badge label={charge.status.replace("_", " ")} tone={getStatusTone(charge.status)} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </TableWrap>

          {canManage && (
            <div className="mt-6 border-t border-border pt-5">
              <h2 className="text-base font-semibold text-ink">Create charge</h2>
              <form action={createChargeFormAction} className="mt-3 flex max-w-md flex-col gap-3">
                <Field label="Student">
                  <StudentPicker
                    name="studentId"
                    options={studentOptions}
                    value={chargeStudentId}
                    onChange={setChargeStudentId}
                    required
                  />
                </Field>
                <Field label="Description">
                  <input type="text" name="description" required className={inputClass} />
                </Field>
                <Field label="Amount (USD)">
                  <input type="number" name="amountDollars" min={0} step="0.01" placeholder="0.00" required className={inputClass} />
                </Field>
                <Field label="Currency (optional — defaults to academy currency)">
                  <input type="text" name="currency" maxLength={3} className={inputClass} />
                </Field>
                <Field label="Due date (optional)">
                  <input type="date" name="dueDate" className={inputClass} />
                </Field>
                {createChargeState.error && <ErrorMessage message={createChargeState.error.message} />}
                {createChargeState.ok && <p className="text-sm font-medium text-success">Charge created.</p>}
                <Button type="submit" disabled={creatingCharge} className="self-start">
                  {creatingCharge ? "Creating..." : "Create charge"}
                </Button>
              </form>
            </div>
          )}
        </div>
      )}

      {tab === "payments" && (
        <div key="payments" className="motion-safe:animate-fade-in">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Student</th>
                <th className={th}>Course</th>
                <th className={th}>Amount</th>
                <th className={th}>Method</th>
                <th className={th}>Status</th>
                <th className={th}>Receipt</th>
                {canReverse && <th className={th}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td
                    colSpan={6 + (canReverse ? 1 : 0)}
                    className={`${td} text-center text-muted`}
                  >
                    No payments to show.
                  </td>
                </tr>
              ) : (
                payments.map((payment) => {
                  const alreadyReversedThisSession = reversedIds.has(payment.id);
                  const isSelfRecorded = payment.recordedBy === currentUserId;
                  const canReverseThisRow =
                    canReverse && payment.status === "approved" && !alreadyReversedThisSession;
                  const effectiveStatus = alreadyReversedThisSession ? "reversed" : payment.status;
                  const issuedThisSession = issuedReceipts.get(payment.id);
                  const existingReceipt = receiptsByPayment[payment.id];
                  const receiptId = issuedThisSession?.id ?? existingReceipt?.id ?? null;
                  const receiptNumber = issuedThisSession?.receiptNumber ?? existingReceipt?.receiptNumber ?? null;
                  return (
                    <tr key={payment.id} className={trHover}>
                      <td className={`${td} font-medium`}>{studentLabel(payment.studentId)}</td>
                      <td className={td}>{courseByPayment[payment.id] ?? "—"}</td>
                      <td className={td}>{formatMoney(payment.amountCents, payment.currency)}</td>
                      <td className={td}>{payment.method.replace("_", " ")}</td>
                      <td className={td}>
                        <Badge label={effectiveStatus.replace("_", " ")} tone={getStatusTone(effectiveStatus)} />
                      </td>
                      <td className={td}>
                        {receiptId ? (
                          <LinkButton href={`/academy/receipts/${receiptId}`} variant="secondary" className="px-2.5 py-1 text-xs" target="_blank">
                            View {receiptNumber ?? "receipt"}
                          </LinkButton>
                        ) : canManage ? (
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2.5 py-1 text-xs"
                            disabled={payment.status !== "approved" || issuingId === payment.id}
                            onClick={() => handleIssueReceipt(payment.id)}
                          >
                            {issuingId === payment.id ? "Issuing..." : "Issue receipt"}
                          </Button>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      {canReverse && (
                        <td className={td}>
                          {!canReverseThisRow ? (
                            <span className="text-muted">—</span>
                          ) : reversalRowId === payment.id ? (
                            <div className="flex min-w-[220px] flex-col gap-2">
                              {reversalMode === "adjust" && (
                                <input
                                  type="number"
                                  placeholder="Corrected amount (USD)"
                                  min={0}
                                  step="0.01"
                                  value={adjustAmount}
                                  onChange={(event) => setAdjustAmount(event.target.value)}
                                  className={`${inputClass} py-1.5`}
                                />
                              )}
                              <input
                                type="text"
                                placeholder="Reason (required)"
                                value={reversalReason}
                                onChange={(event) => setReversalReason(event.target.value)}
                                className={`${inputClass} py-1.5`}
                              />
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant="danger"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={
                                    isReversalPending ||
                                    reversalReason.trim() === "" ||
                                    (reversalMode === "adjust" && adjustAmount.trim() === "")
                                  }
                                  onClick={() => confirmReversal(payment.id)}
                                >
                                  {isReversalPending
                                    ? "Working..."
                                    : reversalMode === "adjust"
                                      ? "Confirm adjustment"
                                      : "Confirm reversal"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="px-2.5 py-1 text-xs"
                                  onClick={cancelReversal}
                                >
                                  Back
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2" title={isSelfRecorded ? SELF_REVERSAL_TOOLTIP : undefined}>
                              <Button
                                type="button"
                                variant="danger"
                                className="px-2.5 py-1 text-xs"
                                disabled={isSelfRecorded}
                                onClick={() => startReversal(payment.id, "reverse")}
                              >
                                Reverse
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                className="px-2.5 py-1 text-xs"
                                disabled={isSelfRecorded}
                                onClick={() => startReversal(payment.id, "adjust")}
                              >
                                Adjust
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </TableWrap>
          {issueError && (
            <div className="mt-3">
              <ErrorMessage message={issueError} />
            </div>
          )}
          {reversalError && (
            <div className="mt-3">
              <ErrorMessage message={reversalError} />
            </div>
          )}

          {canManage && (
            <div className="mt-6 border-t border-border pt-5">
              <h2 className="text-base font-semibold text-ink">Record payment</h2>
              <form action={recordPaymentFormAction} className="mt-3 flex max-w-md flex-col gap-3">
                <Field label="Student">
                  <StudentPicker
                    name="studentId"
                    options={studentOptions}
                    value={paymentStudentId}
                    onChange={setPaymentStudentId}
                    required
                  />
                </Field>
                <Field label="Charge (optional — leave blank if this payment isn't against a specific charge)">
                  <select name="chargeId" defaultValue="" className={inputClass}>
                    <option value="">No specific charge</option>
                    {payableCharges.map((charge) => (
                      <option key={charge.id} value={charge.id}>
                        {studentLabel(charge.studentId)} — {charge.description} —{" "}
                        {formatMoney(charge.amountCents, charge.currency)} ({charge.status.replace("_", " ")})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount (USD)">
                  <input type="number" name="amountDollars" min={0} step="0.01" placeholder="0.00" required className={inputClass} />
                </Field>
                <Field label="Currency (optional — defaults to academy currency)">
                  <input type="text" name="currency" maxLength={3} className={inputClass} />
                </Field>
                <Field label="Method">
                  <select name="method" className={inputClass}>
                    <option value="cash">Cash</option>
                    <option value="mobile_money">Mobile money</option>
                    <option value="bank_transfer">Bank transfer</option>
                  </select>
                </Field>
                <Field label="Reference (optional)">
                  <input type="text" name="reference" className={inputClass} />
                </Field>
                <Field label="Received at">
                  <input type="datetime-local" name="receivedAt" required className={inputClass} />
                </Field>
                <Field label="Notes (optional)">
                  <input type="text" name="notes" placeholder="e.g. Second installment" className={inputClass} />
                </Field>
                {recordPaymentState.error && <ErrorMessage message={recordPaymentState.error.message} />}
                {recordPaymentState.ok && (
                  <p className="text-sm font-medium text-success">Payment recorded.</p>
                )}
                <Button type="submit" disabled={recordingPayment} className="self-start">
                  {recordingPayment ? "Recording..." : "Record payment"}
                </Button>
              </form>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
