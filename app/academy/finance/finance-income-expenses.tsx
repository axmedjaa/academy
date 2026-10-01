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
  EmptyState,
  ErrorMessage,
  Field,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { getStatusTone } from "@/lib/ui/status";
import { dollarsToCents } from "@/lib/ui/money";

const initialIncomeState: IncomeRecordFormState = { ok: false };
const initialExpenseState: ExpenseRecordFormState = { ok: false };

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

interface Props {
  income: IncomeRecordRecord[] | null;
  incomeCanCreate: boolean;
  expenses: ExpenseRecordRecord[] | null;
  expenseCanCreate: boolean;
  /** GENERAL approve authority — may decide ANY pending expense. Also
   * still exactly what gates the Reverse/Adjust column (unchanged). */
  expenseCanApprove: boolean;
  /** May decide a pending expense only when `record.submittedBy ===
   * currentUserId` — combined with that per-row check below to decide
   * whether to render Approve/Reject on a given row (approved architecture
   * decision: Owner/Admin/Manager/Finance Officer may all approve their
   * own expense immediately; this flag alone does not mean "can decide any
   * row"). Reverse/Adjust's self-reversal block is unrelated and still
   * unconditional for everyone — the backend refuses that regardless of
   * role; this is presentation only for that part. */
  expenseCanSelfApprove: boolean;
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
 * UI-quality pass: restyled onto the shared Tailwind shell
 * (Section/TableWrap/Badge/Button/Field), matching the rest of `/academy/*`.
 *
 * Self-approval (later architecture decision): Owner/Academy
 * Administrator/Manager/Finance Officer may all approve/reject an expense
 * they submitted themselves, immediately — no longer blocked waiting for a
 * different approver. Approve/Reject now render per-row based on
 * `canDecideThisRow` (general approve authority, OR self-approve-eligible
 * AND this is the viewer's own submission) rather than a flat
 * `expenseCanApprove` gate with a disabled-self-submitted button — DESIGN.md
 * §5's "not rendered, not disabled" rule, and matches exactly what the
 * server (`expense-records.ts`'s `approveExpense`/`rejectExpense`) allows,
 * so there is no UI-allows/server-blocks or UI-hides/server-allows gap.
 */
export function FinanceIncomeExpenses({
  income,
  incomeCanCreate,
  expenses,
  expenseCanCreate,
  expenseCanApprove,
  expenseCanSelfApprove,
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
    // The "corrected amount" field is entered in dollars — never cents; see
    // lib/ui/money.ts's dollarsToCents. An unparseable amount is refused
    // client-side rather than silently sent as NaN/0.
    if (reversalMode === "adjust" && dollarsToCents(adjustAmount) === null) {
      setReversalError("Enter a valid corrected amount.");
      return;
    }
    startReversalTransition(async () => {
      const result =
        reversalMode === "adjust"
          ? await adjustIncomeRecordAction(incomeRecordId, reversalReason.trim(), dollarsToCents(adjustAmount)!)
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
    if (reversalMode === "adjust" && dollarsToCents(adjustAmount) === null) {
      setReversalError("Enter a valid corrected amount.");
      return;
    }
    startReversalTransition(async () => {
      const result =
        reversalMode === "adjust"
          ? await adjustExpenseRecordAction(expenseRecordId, reversalReason.trim(), dollarsToCents(adjustAmount)!)
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
        <div key="income" className="motion-safe:animate-fade-in">
          {income.length === 0 ? (
            <EmptyState message="No income records to show yet." icon={<Icon name="payments" />} />
          ) : (
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
                {income.map((record) => {
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
                        <Badge label={effectiveStatus} tone={getStatusTone(effectiveStatus)} />
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
                })}
            </tbody>
          </TableWrap>
          )}

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
                <Field label="Amount (USD)">
                  <input type="number" name="amountDollars" min={0} step="0.01" placeholder="0.00" required className={inputClass} />
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
        </div>
      )}

      {tab === "expenses" && expenses !== null && (
        <div key="expenses" className="motion-safe:animate-fade-in">
          {expenses.length === 0 ? (
            <EmptyState message="No expense records to show yet." icon={<Icon name="payments" />} />
          ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Category</th>
                <th className={th}>Amount</th>
                <th className={th}>Status</th>
                {(expenseCanCreate || expenseCanApprove || expenseCanSelfApprove) && <th className={th}>Actions</th>}
                {expenseCanApprove && <th className={th}>Reverse / Adjust</th>}
              </tr>
            </thead>
            <tbody>
                {expenses.map((record) => {
                  const rowKey = `expense:${record.id}`;
                  const alreadyReversed = reversedKeys.has(rowKey);
                  const canReverse = expenseCanApprove && record.status === "approved" && !alreadyReversed;
                  const isSelfSubmitted = record.submittedBy === currentUserId;
                  // GENERAL approvers (Admin/Manager) may decide any row;
                  // self-approve-only roles (Owner/Finance Officer, and
                  // Admin/Manager too — harmless overlap) may decide only
                  // their own — the server enforces this identically, see
                  // expense-records.ts's approveExpense/rejectExpense.
                  const canDecideThisRow = expenseCanApprove || (expenseCanSelfApprove && isSelfSubmitted);
                  const effectiveStatus = alreadyReversed ? "reversed" : record.status;
                  return (
                    <tr key={record.id} className={trHover}>
                      <td className={`${td} font-medium`}>{record.category}</td>
                      <td className={td}>{formatMoney(record.amountCents, record.currency)}</td>
                      <td className={td}>
                        <Badge label={effectiveStatus.replace("_", " ")} tone={getStatusTone(effectiveStatus)} />
                      </td>
                      {(expenseCanCreate || expenseCanApprove || expenseCanSelfApprove) && (
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
                            {canDecideThisRow && record.status === "pending_approval" && (
                              <>
                                <Button
                                  type="button"
                                  className="px-2.5 py-1 text-xs"
                                  disabled={busyExpenseId === record.id}
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
                })}
            </tbody>
          </TableWrap>
          )}
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
                <Field label="Amount (USD)">
                  <input type="number" name="amountDollars" min={0} step="0.01" placeholder="0.00" required className={inputClass} />
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
        </div>
      )}
    </Section>
  );
}
