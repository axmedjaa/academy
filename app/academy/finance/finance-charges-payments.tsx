"use client";

import { useActionState, useState } from "react";
import {
  createStudentChargeAction,
  issueReceiptAction,
  recordStudentPaymentAction,
  type StudentPaymentsFormState,
} from "@/lib/academies/student-payments-actions";
import type { StudentChargeRecord, StudentPaymentRecord } from "@/lib/academies/student-payments";

const initialState: StudentPaymentsFormState = { ok: false };

interface Props {
  charges: StudentChargeRecord[];
  payments: StudentPaymentRecord[];
  /** Only "full"/"manage" callers (Manager/Finance Officer) get
   * create/record/issue controls — Owner/Admin/Trainer are read-only here,
   * per this row's confirmed View/View/Full/—/Manage/View matrix. */
  canManage: boolean;
}

export function FinanceChargesPayments({ charges, payments, canManage }: Props) {
  const [tab, setTab] = useState<"charges" | "payments">("charges");
  const [createChargeState, createChargeFormAction, creatingCharge] = useActionState(
    createStudentChargeAction,
    initialState,
  );
  const [recordPaymentState, recordPaymentFormAction, recordingPayment] = useActionState(
    recordStudentPaymentAction,
    initialState,
  );
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);

  async function handleIssueReceipt(paymentId: string) {
    setIssuingId(paymentId);
    setIssueError(null);
    const result = await issueReceiptAction(paymentId);
    setIssuingId(null);
    if (!result.ok) {
      setIssueError(result.error.message);
    }
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button type="button" onClick={() => setTab("charges")} disabled={tab === "charges"}>
          Charges
        </button>
        <button type="button" onClick={() => setTab("payments")} disabled={tab === "payments"}>
          Payments
        </button>
      </div>

      {tab === "charges" && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "0.5rem" }}>Student</th>
                <th style={{ padding: "0.5rem" }}>Description</th>
                <th style={{ padding: "0.5rem" }}>Amount (cents)</th>
                <th style={{ padding: "0.5rem" }}>Currency</th>
                <th style={{ padding: "0.5rem" }}>Due date</th>
                <th style={{ padding: "0.5rem" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "0.5rem", color: "#666" }}>
                    No charges to show.
                  </td>
                </tr>
              ) : (
                charges.map((charge) => (
                  <tr key={charge.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.5rem" }}>{charge.studentId}</td>
                    <td style={{ padding: "0.5rem" }}>{charge.description}</td>
                    <td style={{ padding: "0.5rem" }}>{charge.amountCents}</td>
                    <td style={{ padding: "0.5rem" }}>{charge.currency}</td>
                    <td style={{ padding: "0.5rem" }}>{charge.dueDate ?? "—"}</td>
                    <td style={{ padding: "0.5rem" }}>{charge.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {canManage && (
            <>
              <h2 style={{ marginTop: "2rem" }}>Create charge</h2>
              <form
                action={createChargeFormAction}
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
              >
                <label>
                  Student ID
                  <input type="text" name="studentId" required style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Description
                  <input
                    type="text"
                    name="description"
                    required
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                <label>
                  Amount (cents)
                  <input
                    type="number"
                    name="amountCents"
                    min={0}
                    required
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                <label>
                  Currency (optional — defaults to academy currency)
                  <input type="text" name="currency" maxLength={3} style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Due date (optional)
                  <input type="date" name="dueDate" style={{ display: "block", width: "100%" }} />
                </label>
                {createChargeState.error && (
                  <p role="alert" style={{ color: "crimson" }}>
                    {createChargeState.error.message}
                  </p>
                )}
                {createChargeState.ok && <p style={{ color: "green" }}>Charge created.</p>}
                <button type="submit" disabled={creatingCharge}>
                  {creatingCharge ? "Creating..." : "Create charge"}
                </button>
              </form>
            </>
          )}
        </>
      )}

      {tab === "payments" && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "0.5rem" }}>Student</th>
                <th style={{ padding: "0.5rem" }}>Amount (cents)</th>
                <th style={{ padding: "0.5rem" }}>Method</th>
                <th style={{ padding: "0.5rem" }}>Status</th>
                {canManage && <th style={{ padding: "0.5rem" }}>Receipt</th>}
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 5 : 4} style={{ padding: "0.5rem", color: "#666" }}>
                    No payments to show.
                  </td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.5rem" }}>{payment.studentId}</td>
                    <td style={{ padding: "0.5rem" }}>{payment.amountCents}</td>
                    <td style={{ padding: "0.5rem" }}>{payment.method}</td>
                    <td style={{ padding: "0.5rem" }}>{payment.status}</td>
                    {canManage && (
                      <td style={{ padding: "0.5rem" }}>
                        <button
                          type="button"
                          disabled={payment.status !== "approved" || issuingId === payment.id}
                          onClick={() => handleIssueReceipt(payment.id)}
                        >
                          {issuingId === payment.id ? "Issuing..." : "Issue receipt"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {issueError && (
            <p role="alert" style={{ color: "crimson" }}>
              {issueError}
            </p>
          )}

          {canManage && (
            <>
              <h2 style={{ marginTop: "2rem" }}>Record payment</h2>
              <form
                action={recordPaymentFormAction}
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
              >
                <label>
                  Student ID
                  <input type="text" name="studentId" required style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Charge ID (optional)
                  <input type="text" name="chargeId" style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Amount (cents)
                  <input
                    type="number"
                    name="amountCents"
                    min={0}
                    required
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                <label>
                  Currency (optional — defaults to academy currency)
                  <input type="text" name="currency" maxLength={3} style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Method
                  <select name="method" style={{ display: "block", width: "100%" }}>
                    <option value="cash">Cash</option>
                    <option value="mobile_money">Mobile money</option>
                    <option value="bank_transfer">Bank transfer</option>
                  </select>
                </label>
                <label>
                  Reference (optional)
                  <input type="text" name="reference" style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Received at
                  <input
                    type="datetime-local"
                    name="receivedAt"
                    required
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                {recordPaymentState.error && (
                  <p role="alert" style={{ color: "crimson" }}>
                    {recordPaymentState.error.message}
                  </p>
                )}
                {recordPaymentState.ok && <p style={{ color: "green" }}>Payment recorded (pending approval).</p>}
                <button type="submit" disabled={recordingPayment}>
                  {recordingPayment ? "Recording..." : "Record payment"}
                </button>
              </form>
            </>
          )}
        </>
      )}
    </section>
  );
}
