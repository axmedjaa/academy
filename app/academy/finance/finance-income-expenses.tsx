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

const initialIncomeState: IncomeRecordFormState = { ok: false };
const initialExpenseState: ExpenseRecordFormState = { ok: false };

const SELF_APPROVAL_TOOLTIP = "You can't approve a transaction you recorded.";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

const INCOME_STATUS_TONE = { posted: "green", reversed: "slate" } as const;
const EXPENSE_STATUS_TONE = {
  draft: "gray",
  pending_approval: "amber",
  approved: "green",
  rejected: "red",
  reversed: "slate",
} as const;

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
 * UI-quality pass (this wave): restyled onto the shared Tailwind shell
 * (Section/TableWrap/Badge/Button/Field), matching the rest of `/academy/*`
 * — no business logic changed, same props/handlers as before.
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
    if (!canReverse) return <span className="text-muted">—</span>;
    if (reversingKey === rowKey) {
      return (
        <div className="flex min-w-[220px] flex-col gap-2">
          {reversalMode === "adjust" && (
            <input
              type="number"
              placeholder="Corrected amount (cents)"
              min={0}
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
              onClick={() => onConfirm(reversalMode ?? "reverse")}
            >
              {isReversalPending ? "Working..." : reversalMode === "adjust" ? "Confirm adjustment" : "Confirm reversal"}
            </Button>
            <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={cancelReversal}>
              Back
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          className="px-2.5 py-1 text-xs"
          onClick={() => startReversal(rowKey, "reverse")}
        >
          Reverse
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          onClick={() => startReversal(rowKey, "adjust")}
        >
          Adjust
        </Button>
      </div>
    );
  }

  if (availableTabs.length === 0) {
    return null;
  }

  return (
    <Section>
      <div className="mb-4 flex gap-2">
        {income !== null && (
          <Button
            type="button"
            variant={tab === "income" ? "primary" : "secondary"}
            className="px-3 py-1.5 text-xs"
            onClick={() => setTab("income")}
          >
            Income
          </Button>
        )}
        {expenses !== null && (
          <Button
            type="button"
            variant={tab === "expenses" ? "primary" : "secondary"}
            className="px-3 py-1.5 text-xs"
            onClick={() => setTab("expenses")}
          >
            Expenses
          </Button>
        )}
      </div>

      {reversalError && (
        <div className="mb-3">
          <ErrorMessage message={reversalError} />
        </div>
      )}

      {tab === "income" && income !== null && (
        <>
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Category</th>
                <th className={th}>Description</th>
                <th className={th}>Amount</th>
                <th className={th}>Status</th>
                {incomeCanCreate && <th className={th}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
              {income.length === 0 ? (
                <tr>
                  <td colSpan={incomeCanCreate ? 5 : 4} className={`${td} text-center text-muted`}>
                    No income records to show.
                  </td>
                </tr>
              ) : (
                income.map((record) => {
                  const rowKey = `income:${record.id}`;
                  const alreadyReversed = reversedKeys.has(rowKey);
                  const canReverse = incomeCanCreate && record.status === "posted" && !alreadyReversed;
                  const effectiveStatus = alreadyReversed ? "reversed" : record.status;
                  return (
                    <tr key={record.id} className={trHover}>
                      <td className={`${td} font-medium`}>{record.category}</td>
                      <td className={td}>{record.description ?? "—"}</td>
                      <td className={td}>{formatMoney(record.amountCents, record.currency)}</td>
                      <td className={td}>
                        <Badge label={effectiveStatus} tone={INCOME_STATUS_TONE[effectiveStatus]} />
                      </td>
                      {incomeCanCreate && (
                        <td className={td}>
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
          </TableWrap>

          {incomeCanCreate && (
            <div className="mt-6 border-t border-border pt-5">
              <h2 className="text-base font-semibold text-ink">Record income</h2>
              <form action={createIncomeFormAction} className="mt-3 flex max-w-md flex-col gap-3">
                <Field label="Category">
                  <input type="text" name="category" required className={inputClass} />
                </Field>
                <Field label="Description (optional)">
                  <input type="text" name="description" className={inputClass} />
                </Field>
                <Field label="Amount (cents)">
                  <input type="number" name="amountCents" min={0} required className={inputClass} />
                </Field>
                <Field label="Currency (optional — defaults to academy currency)">
                  <input type="text" name="currency" maxLength={3} className={inputClass} />
                </Field>
                {createIncomeState.error && <ErrorMessage message={createIncomeState.error.message} />}
                {createIncomeState.ok && <p className="text-sm font-medium text-success">Income posted.</p>}
                <Button type="submit" disabled={creatingIncome} className="self-start">
                  {creatingIncome ? "Posting..." : "Post income"}
                </Button>
              </form>
            </div>
          )}
        </>
      )}

      {tab === "expenses" && expenses !== null && (
        <>
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Category</th>
                <th className={th}>Amount</th>
                <th className={th}>Status</th>
                {(expenseCanCreate || expenseCanApprove) && <th className={th}>Actions</th>}
                {expenseCanApprove && <th className={th}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td
                    colSpan={3 + (expenseCanCreate || expenseCanApprove ? 1 : 0) + (expenseCanApprove ? 1 : 0)}
                    className={`${td} text-center text-muted`}
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
                  const effectiveStatus = alreadyReversed ? "reversed" : record.status;
                  return (
                    <tr key={record.id} className={trHover}>
                      <td className={`${td} font-medium`}>{record.category}</td>
                      <td className={td}>{formatMoney(record.amountCents, record.currency)}</td>
                      <td className={td}>
                        <Badge label={effectiveStatus.replace("_", " ")} tone={EXPENSE_STATUS_TONE[effectiveStatus]} />
                      </td>
                      {(expenseCanCreate || expenseCanApprove) && (
                        <td className={`${td} align-top`}>
                          <div className="flex flex-wrap items-center gap-2">
                            {expenseCanCreate && record.status === "draft" && (
                              <Button
                                type="button"
                                variant="secondary"
                                className="px-2.5 py-1 text-xs"
                                disabled={busyExpenseId === record.id}
                                onClick={() => handleSubmitForApproval(record.id)}
                              >
                                Submit for approval
                              </Button>
                            )}
                            {expenseCanApprove && record.status === "pending_approval" && (
                              <>
                                <Button
                                  type="button"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={busyExpenseId === record.id || isSelfSubmitted}
                                  title={isSelfSubmitted ? SELF_APPROVAL_TOOLTIP : undefined}
                                  onClick={() => handleApprove(record.id)}
                                >
                                  Approve
                                </Button>
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
                                  className={`${inputClass} w-40 py-1.5`}
                                />
                                <Button
                                  type="button"
                                  variant="danger"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={busyExpenseId === record.id}
                                  onClick={() => handleReject(record.id)}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      )}
                      {expenseCanApprove && (
                        <td className={td}>
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
          </TableWrap>
          {expenseActionError && (
            <div className="mt-3">
              <ErrorMessage message={expenseActionError} />
            </div>
          )}

          {expenseCanCreate && (
            <div className="mt-6 border-t border-border pt-5">
              <h2 className="text-base font-semibold text-ink">Create expense</h2>
              <form action={createExpenseFormAction} className="mt-3 flex max-w-md flex-col gap-3">
                <Field label="Category">
                  <input type="text" name="category" required className={inputClass} />
                </Field>
                <Field label="Description (optional)">
                  <input type="text" name="description" className={inputClass} />
                </Field>
                <Field label="Amount (cents)">
                  <input type="number" name="amountCents" min={0} required className={inputClass} />
                </Field>
                <Field label="Currency (optional — defaults to academy currency)">
                  <input type="text" name="currency" maxLength={3} className={inputClass} />
                </Field>
                {createExpenseState.error && <ErrorMessage message={createExpenseState.error.message} />}
                {createExpenseState.ok && <p className="text-sm font-medium text-success">Expense created as draft.</p>}
                <Button type="submit" disabled={creatingExpense} className="self-start">
                  {creatingExpense ? "Creating..." : "Create expense"}
                </Button>
              </form>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
