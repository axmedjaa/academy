"use client";

import { useActionState, useState, useTransition } from "react";
import { createIncomeRecordAction, type IncomeRecordFormState } from "@/lib/academies/income-records-actions";
import type { IncomeRecordRecord } from "@/lib/academies/income-records";
import {
  approveExpenseAction,
  createExpenseRecordAction,
  rejectExpenseAction,
  submitExpenseForApprovalAction,
  type ExpenseRecordFormState,
} from "@/lib/academies/expense-records-actions";
import type { ExpenseRecordRecord } from "@/lib/academies/expense-records";
import {
  adjustExpenseRecordAction,
  adjustIncomeRecordAction,
  reverseExpenseRecordAction,
  reverseIncomeRecordAction,
} from "@/lib/academies/finance-reversals-actions";

const initialIncomeState: IncomeRecordFormState = { ok: false };
const initialExpenseState: ExpenseRecordFormState = { ok: false };

const SELF_APPROVAL_TOOLTIP = "You can't approve a transaction you recorded.";

interface Props {
  income: IncomeRecordRecord[] | null;
  incomeCanCreate: boolean;
  expenses: ExpenseRecordRecord[] | null;
  expenseCanCreate: boolean;
  expenseCanApprove: boolean;
  /** Confirmed Phase 4 audit gap fix (self-approval visual disable,
   * DESIGN.md §9.6/§11.7) and Reverse/Adjust self-reversal disable — the
   * backend already refuses both unconditionally; this is presentation
   * only. */
  currentUserId: string;
}

/**
 * PLAN.md Phase 4, Item 53 — Income/Expenses tabs (DESIGN.md §9.6: "Same
 * approve/reject pattern as Payments; Expense 'Submit for Approval.'").
 * `income`/`expenses` are `null` when the caller's role has no access to
 * that row at all (`ACADEMY_INCOME_ACTION`/`ACADEMY_EXPENSES_ACTION`
 * returning "none") — that tab is simply not rendered, per DESIGN.md §5's
 * "nav item and every action tied to it are absent... not rendered, not
 * disabled" rule.
 *
 * Confirmed Phase 4 audit gap fix (this wave): Reverse/Adjust controls for
 * posted income rows (gated by `incomeCanCreate` — the same "manage" level
 * `lib/academies/finance-reversals.ts`'s `canReverseIncome` requires, since
 * income has no separate approve authority) and approved expense rows
 * (gated by `expenseCanApprove` — the same "approve" level
 * `canReverseExpense` requires). Also adds the DESIGN.md §9.6/§11.7
 * self-approval-visually-disabled-with-tooltip pattern to the expense
 * Approve button — currently inert in practice (create and approve are
 * mutually exclusive permission levels on this row today, so no live user
 * can hold both), kept anyway since the check is cheap and future-proofs
 * against a permission-model change, per this task's explicit "if
 * straightforward, implement it" instruction.
 */
export function FinanceIncomeExpenses({
  income,
  incomeCanCreate,
  expenses,
  expenseCanCreate,
  expenseCanApprove,
  currentUserId,
}: Props) {
  const availableTabs: ("income" | "expenses")[] = [
    ...(income !== null ? (["income"] as const) : []),
    ...(expenses !== null ? (["expenses"] as const) : []),
  ];
  const [tab, setTab] = useState<"income" | "expenses" | null>(availableTabs[0] ?? null);

  const [createIncomeState, createIncomeFormAction, creatingIncome] = useActionState(
    createIncomeRecordAction,
    initialIncomeState,
  );
  const [createExpenseState, createExpenseFormAction, creatingExpense] = useActionState(
    createExpenseRecordAction,
    initialExpenseState,
  );
  const [busyExpenseId, setBusyExpenseId] = useState<string | null>(null);
  const [expenseActionError, setExpenseActionError] = useState<string | null>(null);
  const [rejectReasonByExpenseId, setRejectReasonByExpenseId] = useState<Record<string, string>>({});

  const [isReversalPending, startReversalTransition] = useTransition();
  const [reversalError, setReversalError] = useState<string | null>(null);
  const [reversingKey, setReversingKey] = useState<string | null>(null);
  const [reversalMode, setReversalMode] = useState<"reverse" | "adjust" | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [reversedKeys, setReversedKeys] = useState<Set<string>>(new Set());

  async function handleSubmitForApproval(expenseRecordId: string) {
    setBusyExpenseId(expenseRecordId);
    setExpenseActionError(null);
    const result = await submitExpenseForApprovalAction(expenseRecordId);
    setBusyExpenseId(null);
    if (!result.ok) setExpenseActionError(result.error.message);
  }

  async function handleApprove(expenseRecordId: string) {
    setBusyExpenseId(expenseRecordId);
    setExpenseActionError(null);
    const result = await approveExpenseAction(expenseRecordId);
    setBusyExpenseId(null);
    if (!result.ok) setExpenseActionError(result.error.message);
  }

  async function handleReject(expenseRecordId: string) {
    const reason = rejectReasonByExpenseId[expenseRecordId] ?? "";
    setBusyExpenseId(expenseRecordId);
    setExpenseActionError(null);
    const result = await rejectExpenseAction(expenseRecordId, reason);
    setBusyExpenseId(null);
    if (!result.ok) setExpenseActionError(result.error.message);
  }

  function startReversal(key: string, mode: "reverse" | "adjust") {
    setReversalError(null);
    setReversingKey(key);
    setReversalMode(mode);
    setReversalReason("");
    setAdjustAmount("");
  }

  function cancelReversal() {
    setReversingKey(null);
    setReversalMode(null);
    setReversalReason("");
    setAdjustAmount("");
  }

  function confirmIncomeReversal(incomeRecordId: string) {
    setReversalError(null);
    startReversalTransition(async () => {
      const result =
        reversalMode === "adjust"
          ? await adjustIncomeRecordAction(incomeRecordId, reversalReason.trim(), Number(adjustAmount))
          : await reverseIncomeRecordAction(incomeRecordId, reversalReason.trim());
      if (!result.ok) {
        setReversalError(result.error.message);
        return;
      }
      setReversedKeys((prev) => new Set(prev).add(`income:${incomeRecordId}`));
      cancelReversal();
    });
  }

  function confirmExpenseReversal(expenseRecordId: string) {
    setReversalError(null);
    startReversalTransition(async () => {
      const result =
        reversalMode === "adjust"
          ? await adjustExpenseRecordAction(expenseRecordId, reversalReason.trim(), Number(adjustAmount))
          : await reverseExpenseRecordAction(expenseRecordId, reversalReason.trim());
      if (!result.ok) {
        setReversalError(result.error.message);
        return;
      }
      setReversedKeys((prev) => new Set(prev).add(`expense:${expenseRecordId}`));
      cancelReversal();
    });
  }

  function ReversalControls({
    rowKey,
    canReverse,
    onConfirm,
  }: {
    rowKey: string;
    canReverse: boolean;
    onConfirm: (mode: "reverse" | "adjust") => void;
  }) {
    if (!canReverse) return <>—</>;
    if (reversingKey === rowKey) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", minWidth: 220 }}>
          {reversalMode === "adjust" && (
            <input
              type="number"
              placeholder="Corrected amount (cents)"
              min={0}
              value={adjustAmount}
              onChange={(event) => setAdjustAmount(event.target.value)}
            />
          )}
          <input
            type="text"
            placeholder="Reason (required)"
            value={reversalReason}
            onChange={(event) => setReversalReason(event.target.value)}
          />
          <div style={{ display: "flex", gap: "0.35rem" }}>
            <button
              type="button"
              disabled={
                isReversalPending ||
                reversalReason.trim() === "" ||
                (reversalMode === "adjust" && adjustAmount.trim() === "")
              }
              onClick={() => onConfirm(reversalMode ?? "reverse")}
            >
              {isReversalPending ? "Working..." : reversalMode === "adjust" ? "Confirm adjustment" : "Confirm reversal"}
            </button>
            <button type="button" onClick={cancelReversal}>
              Back
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "flex", gap: "0.35rem" }}>
        <button type="button" onClick={() => startReversal(rowKey, "reverse")}>
          Reverse
        </button>
        <button type="button" onClick={() => startReversal(rowKey, "adjust")}>
          Adjust
        </button>
      </div>
    );
  }

  if (availableTabs.length === 0) {
    return null;
  }

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        {income !== null && (
          <button type="button" onClick={() => setTab("income")} disabled={tab === "income"}>
            Income
          </button>
        )}
        {expenses !== null && (
          <button type="button" onClick={() => setTab("expenses")} disabled={tab === "expenses"}>
            Expenses
          </button>
        )}
      </div>

      {reversalError && (
        <p role="alert" style={{ color: "crimson" }}>
          {reversalError}
        </p>
      )}

      {tab === "income" && income !== null && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "0.5rem" }}>Category</th>
                <th style={{ padding: "0.5rem" }}>Description</th>
                <th style={{ padding: "0.5rem" }}>Amount (cents)</th>
                <th style={{ padding: "0.5rem" }}>Currency</th>
                <th style={{ padding: "0.5rem" }}>Status</th>
                {incomeCanCreate && <th style={{ padding: "0.5rem" }}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
              {income.length === 0 ? (
                <tr>
                  <td colSpan={incomeCanCreate ? 6 : 5} style={{ padding: "0.5rem", color: "#666" }}>
                    No income records to show.
                  </td>
                </tr>
              ) : (
                income.map((record) => {
                  const rowKey = `income:${record.id}`;
                  const alreadyReversed = reversedKeys.has(rowKey);
                  const canReverse = incomeCanCreate && record.status === "posted" && !alreadyReversed;
                  return (
                    <tr key={record.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.5rem" }}>{record.category}</td>
                      <td style={{ padding: "0.5rem" }}>{record.description ?? "—"}</td>
                      <td style={{ padding: "0.5rem" }}>{record.amountCents}</td>
                      <td style={{ padding: "0.5rem" }}>{record.currency}</td>
                      <td style={{ padding: "0.5rem" }}>{alreadyReversed ? "reversed" : record.status}</td>
                      {incomeCanCreate && (
                        <td style={{ padding: "0.5rem" }}>
                          <ReversalControls
                            rowKey={rowKey}
                            canReverse={canReverse}
                            onConfirm={() => confirmIncomeReversal(record.id)}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {incomeCanCreate && (
            <>
              <h2 style={{ marginTop: "2rem" }}>Record income</h2>
              <form
                action={createIncomeFormAction}
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
              >
                <label>
                  Category
                  <input type="text" name="category" required style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Description (optional)
                  <input type="text" name="description" style={{ display: "block", width: "100%" }} />
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
                {createIncomeState.error && (
                  <p role="alert" style={{ color: "crimson" }}>
                    {createIncomeState.error.message}
                  </p>
                )}
                {createIncomeState.ok && <p style={{ color: "green" }}>Income posted.</p>}
                <button type="submit" disabled={creatingIncome}>
                  {creatingIncome ? "Posting..." : "Post income"}
                </button>
              </form>
            </>
          )}
        </>
      )}

      {tab === "expenses" && expenses !== null && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "0.5rem" }}>Category</th>
                <th style={{ padding: "0.5rem" }}>Amount (cents)</th>
                <th style={{ padding: "0.5rem" }}>Status</th>
                {(expenseCanCreate || expenseCanApprove) && <th style={{ padding: "0.5rem" }}>Actions</th>}
                {expenseCanApprove && <th style={{ padding: "0.5rem" }}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td
                    colSpan={3 + (expenseCanCreate || expenseCanApprove ? 1 : 0) + (expenseCanApprove ? 1 : 0)}
                    style={{ padding: "0.5rem", color: "#666" }}
                  >
                    No expense records to show.
                  </td>
                </tr>
              ) : (
                expenses.map((record) => {
                  const rowKey = `expense:${record.id}`;
                  const alreadyReversed = reversedKeys.has(rowKey);
                  const canReverse = expenseCanApprove && record.status === "approved" && !alreadyReversed;
                  const isSelfSubmitted = record.submittedBy === currentUserId;
                  return (
                    <tr key={record.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.5rem" }}>{record.category}</td>
                      <td style={{ padding: "0.5rem" }}>{record.amountCents}</td>
                      <td style={{ padding: "0.5rem" }}>{alreadyReversed ? "reversed" : record.status}</td>
                      {(expenseCanCreate || expenseCanApprove) && (
                        <td style={{ padding: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                          {expenseCanCreate && record.status === "draft" && (
                            <button
                              type="button"
                              disabled={busyExpenseId === record.id}
                              onClick={() => handleSubmitForApproval(record.id)}
                            >
                              Submit for approval
                            </button>
                          )}
                          {expenseCanApprove && record.status === "pending_approval" && (
                            <>
                              <button
                                type="button"
                                disabled={busyExpenseId === record.id || isSelfSubmitted}
                                title={isSelfSubmitted ? SELF_APPROVAL_TOOLTIP : undefined}
                                onClick={() => handleApprove(record.id)}
                              >
                                Approve
                              </button>
                              <input
                                type="text"
                                placeholder="Rejection reason"
                                value={rejectReasonByExpenseId[record.id] ?? ""}
                                onChange={(event) =>
                                  setRejectReasonByExpenseId((prev) => ({
                                    ...prev,
                                    [record.id]: event.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                disabled={busyExpenseId === record.id}
                                onClick={() => handleReject(record.id)}
                              >
                                Reject
                              </button>
                            </>
                          )}
                        </td>
                      )}
                      {expenseCanApprove && (
                        <td style={{ padding: "0.5rem" }}>
                          <ReversalControls
                            rowKey={rowKey}
                            canReverse={canReverse}
                            onConfirm={() => confirmExpenseReversal(record.id)}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {expenseActionError && (
            <p role="alert" style={{ color: "crimson" }}>
              {expenseActionError}
            </p>
          )}

          {expenseCanCreate && (
            <>
              <h2 style={{ marginTop: "2rem" }}>Create expense</h2>
              <form
                action={createExpenseFormAction}
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
              >
                <label>
                  Category
                  <input type="text" name="category" required style={{ display: "block", width: "100%" }} />
                </label>
                <label>
                  Description (optional)
                  <input type="text" name="description" style={{ display: "block", width: "100%" }} />
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
                {createExpenseState.error && (
                  <p role="alert" style={{ color: "crimson" }}>
                    {createExpenseState.error.message}
                  </p>
                )}
                {createExpenseState.ok && <p style={{ color: "green" }}>Expense created as draft.</p>}
                <button type="submit" disabled={creatingExpense}>
                  {creatingExpense ? "Creating..." : "Create expense"}
                </button>
              </form>
            </>
          )}
        </>
      )}
    </section>
  );
}
