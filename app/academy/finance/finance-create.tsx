"use client";

import { startTransition, useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createStudentChargeAction,
  recordStudentPaymentAction,
  type StudentPaymentsFormState,
} from "@/lib/academies/student-payments-actions";
import { createIncomeRecordAction, type IncomeRecordFormState } from "@/lib/academies/income-records-actions";
import { createExpenseRecordAction, type ExpenseRecordFormState } from "@/lib/academies/expense-records-actions";
import { exportFinanceReportAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import {
  ChoiceChips,
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  FormSummary,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { METHOD_OPTIONS } from "./finance-chips";

export interface PayableChargeOption {
  id: string;
  studentId: string;
  description: string;
  amountCents: number;
  currency: string;
  status: string;
}

type Kind = "charge" | "payment" | "income" | "expense";

const COPY: Record<Kind, { button: string; title: string; description: string; submit: string; pending: string; done: string }> = {
  charge: {
    button: "Create charge",
    title: "Create charge",
    description: "A one-off amount the student owes, such as a replacement fee.",
    submit: "Create charge",
    pending: "Creating…",
    done: "Charge created.",
  },
  payment: {
    button: "Record payment",
    title: "Record payment",
    description: "Student payments post immediately and cannot be edited, only reversed.",
    submit: "Record payment",
    pending: "Recording…",
    done: "Payment recorded.",
  },
  income: {
    button: "Record income",
    title: "Record income",
    description: "Income posts directly.",
    submit: "Record income",
    pending: "Recording…",
    done: "Income recorded.",
  },
  expense: {
    button: "Submit expense",
    title: "Submit expense",
    description: "It starts as a draft. Submit it from the list for approval.",
    submit: "Save draft",
    pending: "Saving…",
    done: "Expense saved as a draft.",
  },
};

const amountCheck = (value: string) => {
  const cents = dollarsToCents(value);
  return cents === null || cents <= 0 ? "Enter an amount above zero, for example 25.00." : null;
};

/** The header's primary action for the open Finance tab, with its dialog. */
export function FinanceCreateAction({
  kind,
  studentOptions = [],
  payableCharges = [],
}: {
  kind: Kind;
  studentOptions?: StudentPickerOption[];
  payableCharges?: PayableChargeOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const copy = COPY[kind];
  const close = () => setOpen(false);
  const saved = () => {
    setOpen(false);
    router.refresh();
  };
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
        <Icon name={kind === "expense" ? "upload" : kind === "charge" ? "receipt_long" : "cash"} width={18} height={18} />
        {copy.button}
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title={copy.title} description={copy.description}>
        {open && kind === "charge" && <ChargeForm studentOptions={studentOptions} onCancel={close} onSaved={saved} />}
        {open && kind === "payment" && (
          <PaymentForm studentOptions={studentOptions} payableCharges={payableCharges} onCancel={close} onSaved={saved} />
        )}
        {open && (kind === "income" || kind === "expense") && <LedgerForm kind={kind} onCancel={close} onSaved={saved} />}
      </DesignDialog>
    </>
  );
}

/* ------------------------------------------------------------------ */

const guardedCreateCharge = guardAction(createStudentChargeAction);
const guardedRecordPayment = guardAction(recordStudentPaymentAction);
const guardedCreateIncome = guardAction(createIncomeRecordAction);
const guardedCreateExpense = guardAction(createExpenseRecordAction);
const initialPayments: StudentPaymentsFormState = { ok: false };
const initialIncome: IncomeRecordFormState = { ok: false };
const initialExpense: ExpenseRecordFormState = { ok: false };

const CHARGE_RULES: DesignFormRule[] = [
  { name: "studentId", label: "Student", required: true, kind: "select" },
  { name: "description", label: "Description", required: true },
  { name: "amountDollars", label: "Amount (USD)", required: true, check: amountCheck },
];

function useResult(
  state: { ok: boolean; error?: { message: string } },
  done: string,
  onSaved: () => void,
  showServerError: (message: string, patterns: [RegExp, string][]) => void,
  patterns: [RegExp, string][],
) {
  useEffect(() => {
    if (state.ok) {
      showSuccessToast(done);
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, patterns);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

function ChargeForm({
  studentOptions,
  onCancel,
  onSaved,
}: {
  studentOptions: StudentPickerOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedCreateCharge, initialPayments);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(CHARGE_RULES);
  const [studentId, setStudentId] = useState("");
  useResult(state, COPY.charge.done, onSaved, showServerError, [
    [/student/i, "studentId"],
    [/description/i, "description"],
    [/amount/i, "amountDollars"],
    [/due/i, "dueDate"],
  ]);
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Student" name="studentId" required error={errors.studentId} full>
            <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} required />
          </DField>
          <DField label="Description" name="description" required error={errors.description} full>
            <input
              type="text"
              name="description"
              maxLength={200}
              placeholder="ID card replacement fee"
              onBlur={blur("description")}
              className={controlClass(Boolean(errors.description))}
              {...invalidProps("description", errors.description)}
            />
          </DField>
          <DField label="Amount (USD)" name="amountDollars" required error={errors.amountDollars}>
            <input
              type="text"
              inputMode="decimal"
              name="amountDollars"
              placeholder="0.00"
              onBlur={blur("amountDollars")}
              className={controlClass(Boolean(errors.amountDollars))}
              {...invalidProps("amountDollars", errors.amountDollars)}
            />
          </DField>
          <DField label="Due date" name="dueDate" error={errors.dueDate} hint="Optional.">
            <input type="date" name="dueDate" className={controlClass(Boolean(errors.dueDate))} {...invalidProps("dueDate", errors.dueDate)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel={COPY.charge.submit} pendingLabel={COPY.charge.pending} pending={pending} />
    </form>
  );
}

/* ------------------------------------------------------------------ */

const PAYMENT_RULES: DesignFormRule[] = [
  { name: "studentId", label: "Student", required: true, kind: "select" },
  { name: "amountDollars", label: "Amount (USD)", required: true, check: amountCheck },
  { name: "receivedAt", label: "Received on", required: true },
];

/** "now" for a datetime-local input, in the browser's own time zone. */
function localNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function PaymentForm({
  studentOptions,
  payableCharges,
  onCancel,
  onSaved,
}: {
  studentOptions: StudentPickerOption[];
  payableCharges: PayableChargeOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedRecordPayment, initialPayments);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(PAYMENT_RULES);
  const [studentId, setStudentId] = useState("");
  const [chargeId, setChargeId] = useState("");
  const [amount, setAmount] = useState("");
  const [receivedAt] = useState(localNow);
  useResult(state, COPY.payment.done, onSaved, showServerError, [
    [/student/i, "studentId"],
    [/amount|exceed|overpay/i, "amountDollars"],
    [/received|date/i, "receivedAt"],
    [/reference/i, "reference"],
  ]);

  const studentCharges = payableCharges.filter((charge) => charge.studentId === studentId);
  const charge = studentCharges.find((c) => c.id === chargeId) ?? null;
  const student = studentOptions.find((s) => s.id === studentId) ?? null;

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        {student && (
          <FormSummary
            items={[
              { label: "Student", value: student.fullName },
              {
                label: "Open charges",
                value: studentCharges.length
                  ? studentCharges.map((c) => formatMoney(c.amountCents, c.currency)).join(", ")
                  : "None",
              },
            ]}
          />
        )}
        <FieldGrid>
          <DField label="Student" name="studentId" required error={errors.studentId} full>
            <StudentPicker
              name="studentId"
              options={studentOptions}
              value={studentId}
              onChange={(id) => {
                setStudentId(id);
                setChargeId("");
              }}
              required
            />
          </DField>
          <DField
            label="Applies to"
            name="chargeId"
            error={errors.chargeId}
            full
            hint="Course fees are collected from the student's page, against their fee periods."
          >
            <select
              name="chargeId"
              value={chargeId}
              disabled={!studentId}
              onChange={(event) => {
                setChargeId(event.target.value);
                const next = studentCharges.find((c) => c.id === event.target.value);
                if (next && next.status === "open") setAmount(centsToDollars(next.amountCents));
              }}
              className={controlClass(Boolean(errors.chargeId))}
            >
              <option value="">{studentId ? "General payment (no specific charge)" : "Choose a student first"}</option>
              {studentCharges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.description}, {formatMoney(c.amountCents, c.currency)}
                  {c.status === "partially_paid" ? " (partly paid)" : ""}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Amount (USD)" name="amountDollars" required error={errors.amountDollars}>
            <span className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                onBlur={blur("amountDollars")}
                className={controlClass(Boolean(errors.amountDollars))}
                {...invalidProps("amountDollars", errors.amountDollars)}
              />
              {charge && charge.status === "open" && (
                <button
                  type="button"
                  onClick={() => setAmount(centsToDollars(charge.amountCents))}
                  className="h-11 shrink-0 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-app"
                >
                  Full
                </button>
              )}
            </span>
          </DField>
          <DField label="Received on" name="receivedAt" required error={errors.receivedAt}>
            <input
              type="datetime-local"
              name="receivedAt"
              defaultValue={receivedAt}
              onBlur={blur("receivedAt")}
              className={controlClass(Boolean(errors.receivedAt))}
              {...invalidProps("receivedAt", errors.receivedAt)}
            />
          </DField>
          <DField label="Paid by" name="method" group full>
            <ChoiceChips name="method" options={[...METHOD_OPTIONS]} defaultValue="cash" />
          </DField>
          <DField label="Reference" name="reference" error={errors.reference} hint="Optional.">
            <input
              type="text"
              name="reference"
              maxLength={120}
              placeholder="Receipt or transaction number"
              className={controlClass(Boolean(errors.reference))}
            />
          </DField>
          <DField label="Notes" name="notes" hint="Optional.">
            <input type="text" name="notes" maxLength={500} placeholder="Second installment" className={controlClass(false)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel={COPY.payment.submit} pendingLabel={COPY.payment.pending} pending={pending} />
    </form>
  );
}

/* ------------------------------------------------------------------ */

const LEDGER_RULES: DesignFormRule[] = [
  { name: "category", label: "Category", required: true },
  { name: "amountDollars", label: "Amount (USD)", required: true, check: amountCheck },
];

function LedgerForm({ kind, onCancel, onSaved }: { kind: "income" | "expense"; onCancel: () => void; onSaved: () => void }) {
  const [incomeState, incomeAction, incomePending] = useActionState(guardedCreateIncome, initialIncome);
  const [expenseState, expenseAction, expensePending] = useActionState(guardedCreateExpense, initialExpense);
  const state = kind === "income" ? incomeState : expenseState;
  const formAction = kind === "income" ? incomeAction : expenseAction;
  const pending = kind === "income" ? incomePending : expensePending;
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(LEDGER_RULES);
  useResult(state, COPY[kind].done, onSaved, showServerError, [
    [/category/i, "category"],
    [/amount/i, "amountDollars"],
    [/description/i, "description"],
  ]);
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Category" name="category" required error={errors.category}>
            <input
              type="text"
              name="category"
              maxLength={100}
              placeholder={kind === "income" ? "Workshop sponsorship" : "Classroom supplies"}
              onBlur={blur("category")}
              className={controlClass(Boolean(errors.category))}
              {...invalidProps("category", errors.category)}
            />
          </DField>
          <DField label="Amount (USD)" name="amountDollars" required error={errors.amountDollars}>
            <input
              type="text"
              inputMode="decimal"
              name="amountDollars"
              placeholder="0.00"
              onBlur={blur("amountDollars")}
              className={controlClass(Boolean(errors.amountDollars))}
              {...invalidProps("amountDollars", errors.amountDollars)}
            />
          </DField>
          <DField label="Description" name="description" error={errors.description} hint="Optional." full>
            <input
              type="text"
              name="description"
              maxLength={500}
              placeholder={kind === "income" ? "Local sponsor, tech day" : "Markers and paper for room 2"}
              className={controlClass(Boolean(errors.description))}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel={COPY[kind].submit} pendingLabel={COPY[kind].pending} pending={pending} />
    </form>
  );
}

/* ------------------------------------------------------------------ */

/** Export CSV: the finance report export (audited, permission-checked). */
export function FinanceExportButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const result = await exportFinanceReportAction({}, "csv");
            if (!result.ok) showErrorToast(result.error.message);
            else downloadExportContent(result.content, result.filename, result.format);
          } catch {
            showErrorToast(NETWORK_ERROR_MESSAGE);
          }
        })
      }
    >
      {pending ? "Exporting…" : "Export CSV"}
    </Button>
  );
}
