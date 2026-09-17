"use client";

import { useActionState, useState } from "react";
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

const initialIncomeState: IncomeRecordFormState = { ok: false };
const initialExpenseState: ExpenseRecordFormState = { ok: false };

interface Props {
  income: IncomeRecordRecord[] | null;
  incomeCanCreate: boolean;
  expenses: ExpenseRecordRecord[] | null;
  expenseCanCreate: boolean;
  expenseCanApprove: boolean;
}

/**
 * PLAN.md Phase 4, Item 53 — Income/Expenses tabs (DESIGN.md §9.6: "Same
 * approve/reject pattern as Payments; Expense 'Submit for Approval.'").
 * `income`/`expenses` are `null` when the caller's role has no access to
 * that row at all (`ACADEMY_INCOME_ACTION`/`ACADEMY_EXPENSES_ACTION`
 * returning "none") — that tab is simply not rendered, per DESIGN.md §5's
 * "nav item and every action tied to it are absent... not rendered, not
 * disabled" rule.
 */
export function FinanceIncomeExpenses({
  income,
  incomeCanCreate,
  expenses,
  expenseCanCreate,
  expenseCanApprove,
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
              </tr>
            </thead>
            <tbody>
              {income.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "0.5rem", color: "#666" }}>
                    No income records to show.
                  </td>
                </tr>
              ) : (
                income.map((record) => (
                  <tr key={record.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.5rem" }}>{record.category}</td>
                    <td style={{ padding: "0.5rem" }}>{record.description ?? "—"}</td>
                    <td style={{ padding: "0.5rem" }}>{record.amountCents}</td>
                    <td style={{ padding: "0.5rem" }}>{record.currency}</td>
                    <td style={{ padding: "0.5rem" }}>{record.status}</td>
                  </tr>
                ))
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
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td
                    colSpan={expenseCanCreate || expenseCanApprove ? 4 : 3}
                    style={{ padding: "0.5rem", color: "#666" }}
                  >
                    No expense records to show.
                  </td>
                </tr>
              ) : (
                expenses.map((record) => (
                  <tr key={record.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.5rem" }}>{record.category}</td>
                    <td style={{ padding: "0.5rem" }}>{record.amountCents}</td>
                    <td style={{ padding: "0.5rem" }}>{record.status}</td>
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
                              disabled={busyExpenseId === record.id}
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
                  </tr>
                ))
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
