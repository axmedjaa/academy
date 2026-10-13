"use client";

import { useEffect, useState } from "react";
import type { EnrollmentFeeScheduleRecord, FeePeriodRecord, StudentEnrollmentOption } from "@/lib/academies/fee-periods";
import {
  getEnrollmentFeeScheduleAction,
  listEnrollmentsForStudentAction,
  listFeePeriodsForEnrollmentAction,
  recordEnrollmentPaymentAction,
  recordFeePeriodPaymentAction,
  setEnrollmentFeeScheduleAction,
} from "@/lib/academies/fee-periods-actions";
import { Badge, Button, EmptyState, ErrorMessage, Field, FormDialog, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { StudentPicker, type StudentPickerOption } from "@/app/academy/_shell/student-picker";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { getStatusTone } from "@/lib/ui/status";

/**
 * A period that hasn't started yet is "future," never "currently due" —
 * even though its derived `status` is plain `unpaid`, the same status a
 * genuinely-due-now unpaid period also has (`computeFeePeriodStatus` has no
 * separate "future" state, and none is added here: no new persisted status
 * field is introduced anywhere by this distinction — it's computed fresh on
 * every render from `periodStart` vs. today, purely for display). Only
 * `unpaid` periods are ever "future" in practice — a period with money
 * already paid toward it, or one whose due date has passed, is never in
 * this bucket.
 */
function isFuturePeriod(period: FeePeriodRecord, today: string): boolean {
  return period.status === "unpaid" && period.periodStart > today;
}

/**
 * Per-row staff guidance (step 6 of the fee-period payment-guidance
 * requirement): one line explaining exactly what, if anything, needs to
 * happen for THIS period — never a manual status control (see this file's
 * own "no manual status editor" note on the Status column below), purely a
 * plain-language readout of the same already-derived `paidCents`/
 * `remainingCents`/`status`/`dueDate` fields the table already renders.
 * A PAID period's guidance is explicit about the fact that no further
 * payment applies to it — the per-row Record Payment action is hidden
 * entirely for such rows (below), not merely disabled, so there is nothing
 * to accidentally allocate against an already-settled period.
 */
function periodGuidance(period: FeePeriodRecord, currency: string, today: string): string {
  const remaining = formatMoney(period.remainingCents, currency);
  if (isFuturePeriod(period, today)) {
    return `Not yet due — starts ${period.periodStart}.`;
  }
  switch (period.status) {
    case "paid":
      return "Fully paid — nothing remaining for this period.";
    case "overdue":
      return `Overdue since ${period.dueDate} — ${remaining} still due.`;
    case "partially_paid":
      return `${formatMoney(period.paidCents, currency)} paid so far — ${remaining} remaining.`;
    case "unpaid":
    default:
      return `${remaining} due by ${period.dueDate}.`;
  }
}

interface Props {
  studentOptions: StudentPickerOption[];
  canManage: boolean;
  /** "Today," server-computed in the academy's own Somalia-local calendar
   * (see lib/academies/fee-periods.ts's `todayDateOnlyInAcademyTimezone`) —
   * passed down rather than read from the browser's own clock/timezone, so
   * which periods count as "started yet" never depends on where the staff
   * member's browser happens to be. */
  today: string;
}

export function FeePeriodsManager({ studentOptions, canManage, today }: Props) {
  const [studentId, setStudentId] = useState("");
  const [enrollments, setEnrollments] = useState<StudentEnrollmentOption[]>([]);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [schedule, setSchedule] = useState<EnrollmentFeeScheduleRecord | null>(null);
  const [periods, setPeriods] = useState<FeePeriodRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // React's "adjust state during render" pattern (not an effect): resets
  // the downstream selection synchronously in the same render that
  // `studentId` changes, avoiding a cascading extra render.
  const [prevStudentId, setPrevStudentId] = useState(studentId);
  if (studentId !== prevStudentId) {
    setPrevStudentId(studentId);
    setEnrollments([]);
    setEnrollmentId("");
    setPeriods([]);
    setSchedule(null);
  }

  useEffect(() => {
    if (!studentId) return;
    listEnrollmentsForStudentAction(studentId).then((result) => {
      if (result.ok) setEnrollments(result.enrollments);
      else showErrorToast(result.error.message);
    });
  }, [studentId]);

  async function reloadPeriods() {
    if (!enrollmentId) return;
    setLoading(true);
    setError(null);
    const [periodsResult, scheduleResult] = await Promise.all([
      listFeePeriodsForEnrollmentAction(enrollmentId),
      getEnrollmentFeeScheduleAction(enrollmentId),
    ]);
    setLoading(false);
    if (!periodsResult.ok) {
      setError(periodsResult.error.message);
      return;
    }
    setPeriods(periodsResult.periods);
    setSchedule(scheduleResult.ok ? scheduleResult.schedule : null);
  }

  const [prevEnrollmentId, setPrevEnrollmentId] = useState(enrollmentId);
  if (enrollmentId !== prevEnrollmentId) {
    setPrevEnrollmentId(enrollmentId);
    setPeriods([]);
    setSchedule(null);
  }

  useEffect(() => {
    // Fetching data in response to a prop/state change is exactly the case
    // React's own docs endorse useEffect for — reloadPeriods's setLoading/
    // setPeriods/setSchedule calls are the fetch's result reaching React,
    // not a derived-state sync (which the "adjust state during render"
    // blocks above already handle without an effect).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate fetch-on-change effect, see comment above.
    if (enrollmentId) reloadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadPeriods intentionally omitted: it closes over enrollmentId and would otherwise re-run every render.
  }, [enrollmentId]);

  // The normal fee-periods view never shows a period before its own
  // periodStart arrives — the database may already hold it (period
  // generation always eagerly generates one period ahead; see
  // generateFeePeriodsForEnrollment's own doc comment), but telling staff
  // about a payment that isn't owed yet is exactly the "Upcoming period
  // (not yet due)" banner this view no longer shows. Purely a display-time
  // filter on each period's own `periodStart` (never the batch's start
  // date or the enrollment date) — nothing about generation, status, or
  // balances changes.
  const visiblePeriods = periods.filter((period) => period.periodStart <= today);
  // Summed across every generated period (not just the visible ones) so an
  // advance payment on a not-yet-started installment — a real, if rare,
  // possibility — still counts; see setEnrollmentFeeSchedule's own doc
  // comment in fee-periods.ts.
  const paidCents = periods.reduce((sum, period) => sum + period.paidCents, 0);

  return (
    <Section>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Student">
          <StudentPicker name="studentId" options={studentOptions} value={studentId} onChange={setStudentId} />
        </Field>
        <Field label="Enrollment">
          <select className={inputClass} value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} disabled={enrollments.length === 0}>
            <option value="">{enrollments.length === 0 ? "No enrollments" : "Select an enrollment…"}</option>
            {enrollments.map((enrollment) => (
              <option key={enrollment.id} value={enrollment.id}>
                {enrollment.courseName} — {enrollment.batchName} ({enrollment.status})
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorMessage message={error} />
        </div>
      )}

      {enrollmentId && !loading && (
        <div className="mt-6">
          {schedule && (
            <div className="mb-4 rounded-card border border-border bg-app p-4">
              {/* "6 months · $6.00/month · 6 monthly payments" — never "6
                  months — $36" (that reads as one lump $36 payment). See
                  fee-periods.ts's own module comment ("Payment schedule
                  model"): intervalMonths is how many equal MONTHLY
                  installments the total splits into. */}
              <p className="text-sm font-medium text-ink">
                {schedule.intervalMonths} month{schedule.intervalMonths === 1 ? "" : "s"} ·{" "}
                {formatMoney(schedule.monthlyInstallmentCents, schedule.currency)}/month · {schedule.intervalMonths}{" "}
                monthly payment{schedule.intervalMonths === 1 ? "" : "s"}
              </p>
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Total Fee</p>
                  <p className="font-medium text-ink">{formatMoney(schedule.amountCents, schedule.currency)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Paid</p>
                  <p className="font-medium text-ink">{formatMoney(paidCents, schedule.currency)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Remaining</p>
                  <p className="font-medium text-ink">
                    {formatMoney(Math.max(0, schedule.amountCents - paidCents), schedule.currency)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {canManage && <ScheduleForm enrollmentId={enrollmentId} schedule={schedule} paidCents={paidCents} onSaved={reloadPeriods} />}

          <div className="mt-6">
            <h2 className="text-base font-semibold text-ink">Fee periods</h2>
            {visiblePeriods.length === 0 ? (
              <EmptyState
                message={schedule ? "No fee periods due yet." : "Set a fee schedule to generate periods."}
                icon={<Icon name="payments" />}
              />
            ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Period</th>
                  <th className={th}>Due date</th>
                  <th className={th}>Expected</th>
                  <th className={th}>Paid</th>
                  <th className={th}>Remaining</th>
                  <th className={th}>Status</th>
                  {canManage && <th className={th}>Action</th>}
                </tr>
              </thead>
              <tbody>
                  {visiblePeriods.map((period) => (
                    <PeriodRow
                      key={period.id}
                      period={period}
                      today={today}
                      studentId={studentId}
                      canManage={canManage}
                      onRecorded={reloadPeriods}
                    />
                  ))}
              </tbody>
            </TableWrap>
            )}
          </div>

          {canManage && visiblePeriods.some((period) => period.remainingCents > 0) && (
            <div className="mt-6 border-t border-border pt-5">
              <h2 className="text-base font-semibold text-ink">Record a payment across outstanding periods</h2>
              <p className="mt-1 text-xs text-muted">
                Enter one amount and it is applied to the oldest outstanding period(s) first — use this for a
                catch-up payment spanning more than one period. To pay a single period specifically, use that
                period&apos;s own Record Payment action above instead.
              </p>
              <RecordPaymentForm
                studentId={studentId}
                enrollmentId={enrollmentId}
                remainingCents={visiblePeriods.reduce((sum, period) => sum + period.remainingCents, 0)}
                currency={schedule?.currency ?? "USD"}
                onDone={reloadPeriods}
              />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * One `fee_periods` table row plus its own per-row Record Payment action.
 * The Action column is deliberately absent (not merely disabled) for an
 * already-`paid` period — there is no control here that could ever
 * allocate a payment onto a period that doesn't need one, matching the
 * "do not allow another payment to be allocated to that already-paid
 * period" requirement structurally, not just as a UI courtesy (the server
 * itself independently refuses any allocation exceeding a period's
 * outstanding balance — see recordFeePeriodPayment's own overpayment
 * check — this is the UI simply never offering the control at all).
 */
function PeriodRow({
  period,
  today,
  studentId,
  canManage,
  onRecorded,
}: {
  period: FeePeriodRecord;
  today: string;
  studentId: string;
  canManage: boolean;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const future = isFuturePeriod(period, today);

  return (
    <>
      <tr className={trHover}>
        <td className={td}>
          {period.periodStart} – {period.periodEnd}
        </td>
        <td className={td}>{period.dueDate}</td>
        <td className={td}>{formatMoney(period.expectedAmountCents, period.currency)}</td>
        <td className={td}>{formatMoney(period.paidCents, period.currency)}</td>
        <td className={td}>{formatMoney(period.remainingCents, period.currency)}</td>
        <td className={td}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge label={period.status.replace("_", " ")} tone={getStatusTone(period.status)} />
            {/* §7: a future period must read as "upcoming," never lumped in
                with what's currently due — this is display-only, derived
                fresh from periodStart vs. today, never a stored status. */}
            {future && <Badge label="upcoming" tone="gray" />}
          </div>
          <p className="mt-1 text-xs text-muted">{periodGuidance(period, period.currency, today)}</p>
        </td>
        {canManage && (
          <td className={`${td} align-top`}>
            {period.remainingCents > 0 ? (
              <Button type="button" className="px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>
                Record Payment
              </Button>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </td>
        )}
      </tr>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={`Record payment — ${period.periodStart} – ${period.periodEnd}`}
      >
        <PeriodPaymentForm
          studentId={studentId}
          period={period}
          onDone={() => {
            setOpen(false);
            onRecorded();
          }}
          onCancel={() => setOpen(false)}
        />
      </FormDialog>
    </>
  );
}

/**
 * Records a payment against exactly ONE fee period — `recordFeePeriodPayment`
 * with a single explicit allocation `{ feePeriodId: period.id, amountCents }`,
 * never the enrollment-wide auto-allocator. This is what makes the per-row
 * "Record Payment" action a genuinely targeted control (pay THIS period)
 * rather than a relabelled copy of the bulk form below the table — the
 * server independently re-checks this period's own outstanding balance at
 * write time regardless of what this form pre-fills.
 */
function PeriodPaymentForm({
  studentId,
  period,
  onDone,
  onCancel,
}: {
  studentId: string;
  period: FeePeriodRecord;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(() => centsToDollars(period.remainingCents));
  const [method, setMethod] = useState<"cash" | "mobile_money" | "bank_transfer">("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    const amountCents = dollarsToCents(amount);
    if (amountCents === null || amountCents <= 0) {
      setError("Enter a valid amount paid.");
      return;
    }
    // Do not allow the amount to silently exceed this period's remaining
    // balance — this codebase has no advance-payment/overpayment flow for
    // fee periods (recordFeePeriodPayment refuses it server-side too; this
    // client-side check exists purely so staff see a clear, immediate
    // reason rather than a generic server error).
    if (amountCents > period.remainingCents) {
      setError(
        `Amount cannot exceed the remaining balance of ${formatMoney(period.remainingCents, period.currency)} for this period.`,
      );
      return;
    }
    setSubmitting(true);
    const result = await recordFeePeriodPaymentAction({
      studentId,
      enrollmentId: period.enrollmentId,
      allocations: [{ feePeriodId: period.id, amountCents }],
      method,
      reference: reference || undefined,
      notes: notes || undefined,
      receivedAt,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to record payment.");
      showErrorToast(result.error?.message ?? "Failed to record payment.");
      return;
    }
    showSuccessToast("Payment recorded.");
    onDone();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Recording a payment for the {period.periodStart} – {period.periodEnd} period only — outstanding balance{" "}
        {formatMoney(period.remainingCents, period.currency)}.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Amount Paid Now">
          <input
            type="number"
            min={0.01}
            step={0.01}
            max={period.remainingCents / 100}
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Payment Method">
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile money</option>
            <option value="bank_transfer">Bank transfer</option>
          </select>
        </Field>
        <Field label="Payment Date">
          <input type="datetime-local" className={inputClass} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Reference (optional)">
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. MM-84920" />
        </Field>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Second installment" />
        </Field>
      </div>

      {error && <ErrorMessage message={error} />}
      <div className="flex gap-2">
        <Button type="button" disabled={submitting} className="self-start" onClick={handleSubmit}>
          {submitting ? "Recording..." : "Record Payment"}
        </Button>
        <Button type="button" variant="secondary" disabled={submitting} className="self-start" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monthly" },
  { value: 2, label: "Every 2 Months" },
  { value: 3, label: "Every 3 Months" },
  { value: 4, label: "Every 4 Months" },
  { value: 6, label: "Every 6 Months" },
  { value: 12, label: "Yearly" },
];

function ScheduleForm({
  enrollmentId,
  schedule,
  paidCents,
  onSaved,
}: {
  enrollmentId: string;
  schedule: EnrollmentFeeScheduleRecord | null;
  /** How much has actually been approved-paid toward the CURRENT schedule's
   * already-started installments — see fee-periods.ts's own
   * setEnrollmentFeeSchedule doc comment ("auto-carry the remaining
   * balance"). Once this is > 0, the server authoritatively overrides
   * whatever total fee is submitted here with the auto-computed remaining
   * balance, so this field is locked to that same value rather than
   * letting the admin type a number the server will silently replace. */
  paidCents: number;
  onSaved: () => void;
}) {
  const [intervalMonths, setIntervalMonths] = useState<number>(schedule?.intervalMonths ?? 1);
  // Once anything has been paid toward the current schedule, the Total Fee
  // field always reflects the auto-carried remaining balance — the server
  // computes and uses this same figure regardless of what's submitted (see
  // setEnrollmentFeeSchedule's own doc comment), so showing anything else
  // here would just be misleading.
  const amountIsLocked = schedule !== null && paidCents > 0;
  const remainingCents = schedule ? Math.max(0, schedule.amountCents - paidCents) : 0;
  // Entered/displayed in dollars (e.g. "5.55"), never raw cents — see
  // lib/ui/money.ts's dollarsToCents/centsToDollars. This is the exact
  // "Fee schedule" input the money-input-system fix specifically calls
  // out: entering "10" here must mean $10.00 total, not 10 cents.
  const [amountDollars, setAmountDollars] = useState(
    schedule ? centsToDollars(amountIsLocked ? remainingCents : schedule.amountCents) : "",
  );
  const [anchorDate, setAnchorDate] = useState(schedule?.anchorDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adjust state during render (see the manager's own comment above) — this
  // is purely a derived-from-prop sync with no external system involved, so
  // no effect is needed at all.
  const [prevSchedule, setPrevSchedule] = useState(schedule);
  if (schedule !== prevSchedule) {
    setPrevSchedule(schedule);
    setIntervalMonths(schedule?.intervalMonths ?? 1);
    setAmountDollars(schedule ? centsToDollars(amountIsLocked ? remainingCents : schedule.amountCents) : "");
    setAnchorDate(schedule?.anchorDate ?? "");
  }

  async function handleSave() {
    setError(null);
    const amount = dollarsToCents(amountDollars);
    if (amount === null || amount <= 0 || !anchorDate) {
      setError("Enter a valid amount and start date.");
      return;
    }
    setSaving(true);
    const result = await setEnrollmentFeeScheduleAction({ enrollmentId, intervalMonths, amountCents: amount, anchorDate });
    setSaving(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to save fee schedule.");
      showErrorToast(result.error?.message ?? "Failed to save fee schedule.");
      return;
    }
    showSuccessToast("Fee schedule saved.");
    onSaved();
  }

  return (
    <div className="rounded-card border border-border bg-app p-4">
      <h2 className="text-sm font-semibold text-ink">{schedule ? "Edit fee schedule" : "Set fee schedule"}</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Payment Plan">
          <select className={inputClass} value={intervalMonths} onChange={(e) => setIntervalMonths(Number(e.target.value))}>
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={amountIsLocked ? "Remaining balance (auto-carried)" : "Total Fee (USD)"}>
          <input
            type="number"
            min={0.01}
            step="0.01"
            placeholder="0.00"
            className={inputClass}
            value={amountDollars}
            disabled={amountIsLocked}
            onChange={(e) => setAmountDollars(e.target.value)}
          />
          {amountIsLocked && schedule && (
            <p className="mt-1 text-xs text-muted">
              {formatMoney(paidCents, schedule.currency)} already paid toward the current plan — the remaining
              balance carries over automatically into the new one.
            </p>
          )}
        </Field>
        <Field label="First period start date">
          <input type="date" className={inputClass} value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
        </Field>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorMessage message={error} />
        </div>
      )}
      <Button type="button" className="mt-3" disabled={saving} onClick={handleSave}>
        {saving ? "Saving..." : "Save schedule"}
      </Button>
    </div>
  );
}

/**
 * The manual student-payment verification report's required flow: select
 * student -> enter amount paid -> save -> update balance -> record
 * history. One "Amount Paid Now" field, no per-period checkboxes —
 * `recordEnrollmentPaymentAction` auto-allocates the entered amount across
 * outstanding periods server-side (oldest first).
 */
function RecordPaymentForm({
  studentId,
  enrollmentId,
  remainingCents,
  currency,
  onDone,
}: {
  studentId: string;
  enrollmentId: string;
  remainingCents: number;
  currency: string;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(() => centsToDollars(remainingCents));
  const [method, setMethod] = useState<"cash" | "mobile_money" | "bank_transfer">("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    const amountCents = dollarsToCents(amount);
    if (amountCents === null || amountCents <= 0) {
      setError("Enter a valid amount paid.");
      return;
    }
    setSubmitting(true);
    const result = await recordEnrollmentPaymentAction({
      studentId,
      enrollmentId,
      amountCents,
      method,
      reference: reference || undefined,
      notes: notes || undefined,
      receivedAt,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to record payment.");
      showErrorToast(result.error?.message ?? "Failed to record payment.");
      return;
    }
    showSuccessToast("Payment recorded.");
    setReference("");
    setNotes("");
    onDone();
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Amount Paid Now">
          <input
            type="number"
            min={0.01}
            step={0.01}
            max={remainingCents / 100}
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Payment Method">
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile money</option>
            <option value="bank_transfer">Bank transfer</option>
          </select>
        </Field>
        <Field label="Payment Date">
          <input type="datetime-local" className={inputClass} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Reference (optional)">
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. MM-84920" />
        </Field>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Second installment" />
        </Field>
      </div>

      <p className="text-sm text-muted">Remaining balance: {formatMoney(remainingCents, currency)}</p>

      {error && <ErrorMessage message={error} />}
      <Button type="button" disabled={submitting} className="self-start" onClick={handleSubmit}>
        {submitting ? "Recording..." : "Record Payment"}
      </Button>
    </div>
  );
}
