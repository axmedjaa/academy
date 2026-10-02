"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import type { StudentRecord } from "@/lib/academies/students";
import type {
  EnrollmentFeeScheduleRecord,
  EnrollmentPaymentSummary,
  FeePeriodRecord,
  StudentEnrollmentOption,
} from "@/lib/academies/fee-periods";
import type { StudentChargeRecord } from "@/lib/academies/student-payments";
import {
  listFeePeriodsForEnrollmentAction,
  recordEnrollmentPaymentAction,
  recordFeePeriodPaymentAction,
  setEnrollmentFeeScheduleAction,
} from "@/lib/academies/fee-periods-actions";
import {
  createStudentChargeAction,
  issueReceiptAction,
  recordStudentPaymentAction,
  type StudentPaymentsFormState,
} from "@/lib/academies/student-payments-actions";
import { adjustStudentPaymentAction, reverseStudentPaymentAction } from "@/lib/academies/finance-reversals-actions";
import { Badge, Button, ErrorMessage, Field, LinkButton, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { StudentAvatar } from "@/app/academy/students/student-avatar";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { centsToDollars, dollarsToCents } from "@/lib/ui/money";

const initialState: StudentPaymentsFormState = { ok: false };

const SELF_REVERSAL_TOOLTIP = "You can't reverse or adjust a payment you recorded yourself.";

const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monthly" },
  { value: 2, label: "Every 2 Months" },
  { value: 3, label: "Every 3 Months" },
  { value: 4, label: "Every 4 Months" },
  { value: 6, label: "Every 6 Months" },
  { value: 12, label: "Yearly" },
];

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

/** Today as a plain "YYYY-MM-DD" string — same helper/rationale as
 * fee-periods-manager.tsx's identical copy. */
function todayDateOnly(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A period that hasn't started yet is "future," never "currently due" —
 * same helper/rationale as fee-periods-manager.tsx's identical copy (no new
 * persisted status field; purely a display-time comparison). */
function isFuturePeriod(period: FeePeriodRecord, today: string): boolean {
  return period.status === "unpaid" && period.periodStart > today;
}

/** Per-row staff guidance — same rules/wording as
 * app/academy/finance/fee-periods/fee-periods-manager.tsx's identical
 * helper; kept as its own local copy here rather than a shared import,
 * matching this file's existing convention of duplicating formatMoney/
 * INTERVAL_OPTIONS rather than sharing a module with that page. Purely a
 * plain-language readout of the already-derived paidCents/remainingCents/
 * status/dueDate fields — never a manual status control (see PeriodRow's
 * own comment below). */
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

export interface PaymentHistoryRow {
  paymentId: string;
  receivedAt: Date;
  amountCents: number;
  currency: string;
  method: "cash" | "mobile_money" | "bank_transfer";
  reference: string | null;
  status: "pending_approval" | "approved" | "rejected" | "reversed";
  /** "Course — Batch: period, period" for a fee-period payment, "Charge:
   * description" for a one-off charge payment, "—" for neither. */
  description: string;
  recordedByLabel: string;
  recordedBy: string;
  notes: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
}

interface EnrollmentSummaryEntry {
  enrollment: StudentEnrollmentOption;
  schedule: EnrollmentFeeScheduleRecord | null;
  summary: EnrollmentPaymentSummary | null;
}

interface Props {
  student: StudentRecord;
  /** This student's own short-lived signed R2 GET url, pre-resolved
   * server-side (page.tsx, via students.ts's `getStudentPhotoUrl`) —
   * null if they have no photo, or it couldn't be resolved. */
  photoUrl: string | null;
  enrollments: StudentEnrollmentOption[];
  enrollmentSummaries: EnrollmentSummaryEntry[];
  charges: StudentChargeRecord[];
  historyRows: PaymentHistoryRow[];
  /** Whether either finance section (charges/payments) resolved at all —
   * false only for a role with "none" on academy.student_payments
   * (Admissions Officer). */
  paymentsSectionVisible: boolean;
  /** Manager/Finance Officer/Academy Administrator — record payments,
   * create charges, set fee schedules. Owner/Trainer are view-only. */
  canManagePayments: boolean;
  /** Manager only — narrower than canManagePayments, gates Reverse/Adjust.
   * Not an approval gate: there is no approval workflow for student
   * payments anymore, only the reversal/adjustment correction path. */
  canReversePayments: boolean;
  currentUserId: string;
}

export function StudentDetail({
  student,
  photoUrl,
  enrollments,
  enrollmentSummaries,
  charges,
  historyRows,
  paymentsSectionVisible,
  canManagePayments,
  canReversePayments,
  currentUserId,
}: Props) {
  return (
    <div className="flex flex-col gap-6">
      <StudentInfoCard student={student} photoUrl={photoUrl} />

      {enrollmentSummaries.length === 0 ? (
        <Section>
          <p className="text-sm text-muted">
            {enrollments.length === 0
              ? "This student has no course enrollment yet."
              : "This student has no active course enrollment."}
          </p>
        </Section>
      ) : (
        enrollmentSummaries.map((entry) => (
          <EnrollmentPaymentPanel
            key={entry.enrollment.id}
            studentId={student.id}
            entry={entry}
            canManagePayments={canManagePayments}
          />
        ))
      )}

      {paymentsSectionVisible && (
        <ChargesPanel
          studentId={student.id}
          charges={charges}
          canManagePayments={canManagePayments}
        />
      )}

      {paymentsSectionVisible && (
        <PaymentHistoryPanel
          rows={historyRows}
          canManagePayments={canManagePayments}
          canReversePayments={canReversePayments}
          currentUserId={currentUserId}
        />
      )}
    </div>
  );
}

function StudentInfoCard({ student, photoUrl }: { student: StudentRecord; photoUrl: string | null }) {
  return (
    <Section>
      <div className="flex items-center gap-4">
        <StudentAvatar
          fullName={student.fullName}
          photoUrl={photoUrl}
          sizeClassName="h-14 w-14"
          textClassName="text-lg"
        />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{student.fullName}</h2>
            <Badge label={student.status} tone={student.status === "active" ? "green" : "gray"} />
          </div>
          <p className="text-sm text-muted">Student # {student.studentNumber}</p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border pt-5 sm:grid-cols-3">
        <InfoField label="Phone">{student.phone ?? "—"}</InfoField>
        <InfoField label="Email">{student.email ?? "—"}</InfoField>
        <InfoField label="Date of birth">{student.dateOfBirth ?? "—"}</InfoField>
        <InfoField label="Gender">{student.gender ?? "—"}</InfoField>
        <InfoField label="Guardian">
          {student.guardianName ? `${student.guardianName} (${student.guardianPhone ?? "no phone"})` : "—"}
        </InfoField>
      </div>
    </Section>
  );
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1 text-sm text-ink">{children}</div>
    </div>
  );
}

// ===========================================================================
// Payment summary + Record Payment (fee-period / enrollment payments)
// ===========================================================================

function EnrollmentPaymentPanel({
  studentId,
  entry,
  canManagePayments,
}: {
  studentId: string;
  entry: EnrollmentSummaryEntry;
  canManagePayments: boolean;
}) {
  const { enrollment, schedule, summary } = entry;
  const today = todayDateOnly();
  const [periods, setPeriods] = useState<FeePeriodRecord[]>([]);
  const [loadingPeriods, setLoadingPeriods] = useState(false);
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function reloadPeriods() {
    setLoadingPeriods(true);
    setPeriodsError(null);
    const result = await listFeePeriodsForEnrollmentAction(enrollment.id);
    setLoadingPeriods(false);
    if (!result.ok) {
      setPeriodsError(result.error.message);
      return;
    }
    setPeriods(result.periods);
  }

  useEffect(() => {
    // Fetching this enrollment's periods on mount/refresh is exactly the
    // "fetch in response to a change" case React's own docs endorse
    // useEffect for.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate fetch-on-change effect.
    reloadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadPeriods intentionally omitted: it closes over enrollment.id and would otherwise re-run every render.
  }, [enrollment.id, refreshKey]);

  return (
    <Section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {enrollment.courseName} — {enrollment.batchName}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {schedule
              ? `${INTERVAL_OPTIONS.find((o) => o.value === schedule.intervalMonths)?.label ?? `Every ${schedule.intervalMonths} mo.`} — ${formatMoney(schedule.amountCents, schedule.currency)} per period`
              : "No fee schedule set yet."}
          </p>
        </div>
        {summary && (
          <div className="flex flex-wrap gap-4 text-sm">
            <SummaryStat label="Total Fee" value={formatMoney(summary.expectedCents, schedule?.currency ?? "USD")} />
            <SummaryStat label="Previously Paid" value={formatMoney(summary.paidCents, schedule?.currency ?? "USD")} />
            <SummaryStat label="Remaining" value={formatMoney(summary.remainingCents, schedule?.currency ?? "USD")} />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Status</p>
              <Badge label={summary.status.replace("_", " ")} tone={getStatusTone(summary.status)} />
            </div>
          </div>
        )}
      </div>

      {canManagePayments && (
        <div className="mt-4">
          <ScheduleForm
            enrollmentId={enrollment.id}
            schedule={schedule}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}

      {periodsError && (
        <div className="mt-3">
          <ErrorMessage message={periodsError} />
        </div>
      )}

      {schedule && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-ink">Fee periods</h3>
          <NextOutstandingBanner periods={periods} currency={schedule.currency} today={today} />
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Period</th>
                <th className={th}>Due date</th>
                <th className={th}>Expected</th>
                <th className={th}>Paid</th>
                <th className={th}>Remaining</th>
                <th className={th}>Status</th>
                {canManagePayments && <th className={th}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 ? (
                <tr>
                  <td colSpan={canManagePayments ? 7 : 6} className={`${td} text-center text-muted`}>
                    {loadingPeriods ? "Loading…" : "No fee periods yet."}
                  </td>
                </tr>
              ) : (
                periods.map((period) => (
                  <PeriodRow
                    key={period.id}
                    period={period}
                    today={today}
                    studentId={studentId}
                    canManage={canManagePayments}
                    onRecorded={() => setRefreshKey((k) => k + 1)}
                  />
                ))
              )}
            </tbody>
          </TableWrap>

          {canManagePayments && summary && summary.remainingCents > 0 && (
            <div className="mt-6 border-t border-border pt-5">
              <h3 className="text-sm font-semibold text-ink">Record a payment across outstanding periods</h3>
              <p className="mt-1 text-xs text-muted">
                Enter one amount and it is applied to the oldest outstanding period(s) first — use this for a
                catch-up payment spanning more than one period. To pay a single period specifically, use that
                period&apos;s own Record Payment action above instead.
              </p>
              <RecordEnrollmentPaymentForm
                studentId={studentId}
                enrollmentId={enrollment.id}
                remainingCents={summary.remainingCents}
                currency={schedule?.currency ?? "USD"}
                onDone={() => setRefreshKey((k) => k + 1)}
              />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

/** "If the current period is paid but another period is outstanding, the UI
 * should guide the staff member to that next period rather than making them
 * guess" — same helper as fee-periods-manager.tsx's identical component,
 * including the "Upcoming" wording for a future next-outstanding period
 * (§7: never present a not-yet-started period as currently owed). */
function NextOutstandingBanner({
  periods,
  currency,
  today,
}: {
  periods: FeePeriodRecord[];
  currency: string;
  today: string;
}) {
  if (periods.length === 0) return null;

  const nextOutstanding = [...periods]
    .filter((period) => period.remainingCents > 0)
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))[0];

  if (!nextOutstanding) {
    return (
      <p className="mt-2 text-sm font-medium text-success">
        All generated fee periods are fully paid — nothing outstanding right now.
      </p>
    );
  }

  const label = isFuturePeriod(nextOutstanding, today)
    ? "Upcoming period (not yet due)"
    : nextOutstanding.status === "overdue"
      ? "Overdue period needing payment"
      : "Next period needing payment";
  return (
    <p className="mt-2 text-sm text-ink">
      <span className="font-medium">{label}:</span>{" "}
      {nextOutstanding.periodStart} – {nextOutstanding.periodEnd} — {formatMoney(nextOutstanding.remainingCents, currency)}{" "}
      due {nextOutstanding.dueDate}.
    </p>
  );
}

/** One fee_periods row plus its own per-row Record Payment action. No
 * Action control is rendered at all for an already-`paid` period (not
 * merely disabled) — see fee-periods-manager.tsx's identical PeriodRow for
 * the full reasoning. */
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
            {future && <Badge label="upcoming" tone="gray" />}
          </div>
          <p className="mt-1 text-xs text-muted">{periodGuidance(period, period.currency, today)}</p>
        </td>
        {canManage && (
          <td className={`${td} align-top`}>
            {period.remainingCents > 0 ? (
              <Button
                type="button"
                variant={open ? "secondary" : "primary"}
                className="px-2.5 py-1 text-xs"
                onClick={() => setOpen((value) => !value)}
              >
                {open ? "Cancel" : "Record Payment"}
              </Button>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={canManage ? 7 : 6} className={`${td} bg-app`}>
            <PeriodPaymentForm
              studentId={studentId}
              period={period}
              onDone={() => {
                setOpen(false);
                onRecorded();
              }}
              onCancel={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** Records a payment against exactly ONE fee period — same targeted
 * single-allocation form as fee-periods-manager.tsx's identical
 * PeriodPaymentForm, kept as its own local copy per this file's existing
 * duplication convention. */
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
    // balance — same client-side check as fee-periods-manager.tsx's
    // identical form (the server independently refuses it too).
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

function ScheduleForm({
  enrollmentId,
  schedule,
  onSaved,
}: {
  enrollmentId: string;
  schedule: EnrollmentFeeScheduleRecord | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(schedule === null);
  const [intervalMonths, setIntervalMonths] = useState<number>(schedule?.intervalMonths ?? 1);
  const [amountCents, setAmountCents] = useState(schedule ? String(schedule.amountCents) : "");
  const [anchorDate, setAnchorDate] = useState(schedule?.anchorDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>
        Edit fee schedule
      </Button>
    );
  }

  async function handleSave() {
    setError(null);
    const amount = Number(amountCents);
    if (!Number.isFinite(amount) || amount <= 0 || !anchorDate) {
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
    setOpen(false);
    onSaved();
  }

  return (
    <div className="rounded-card border border-border bg-app p-4">
      <h3 className="text-sm font-semibold text-ink">{schedule ? "Edit fee schedule" : "Set fee schedule"}</h3>
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
        <Field label="Amount (cents)">
          <input type="number" min={1} className={inputClass} value={amountCents} onChange={(e) => setAmountCents(e.target.value)} />
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
      <div className="mt-3 flex gap-2">
        <Button type="button" disabled={saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save schedule"}
        </Button>
        {schedule && (
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The manual student-payment verification report's required flow: select
 * student (already fixed — this is the student's own page) -> enter amount
 * paid -> save -> update balance -> record history. One "Amount Paid Now"
 * field, no per-period checkboxes — `recordEnrollmentPaymentAction`
 * auto-allocates the entered amount across outstanding periods
 * server-side (oldest first), so the underlying period ledger stays
 * exactly as correct as the old manual-selection form produced.
 */
function RecordEnrollmentPaymentForm({
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

// ===========================================================================
// One-off charges (§13-14 — never turned into recurring fees)
// ===========================================================================

function ChargesPanel({
  studentId,
  charges,
  canManagePayments,
}: {
  studentId: string;
  charges: StudentChargeRecord[];
  canManagePayments: boolean;
}) {
  const [createChargeState, createChargeFormAction, creatingCharge] = useActionState(createStudentChargeAction, initialState);
  const [recordPaymentState, recordPaymentFormAction, recordingPayment] = useActionState(recordStudentPaymentAction, initialState);
  const payableCharges = charges.filter((charge) => charge.status === "open" || charge.status === "partially_paid");

  useEffect(() => {
    if (createChargeState.ok) showSuccessToast("Charge created.");
    else if (createChargeState.error) showErrorToast(createChargeState.error.message);
  }, [createChargeState]);

  useEffect(() => {
    if (recordPaymentState.ok) showSuccessToast("Payment recorded.");
    else if (recordPaymentState.error) showErrorToast(recordPaymentState.error.message);
  }, [recordPaymentState]);

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">One-off charges</h2>
      <p className="mt-1 text-sm text-muted">
        ID card replacements, damaged equipment, late fees, field trips — separate from the recurring enrollment
        payment plan above.
      </p>

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Description</th>
            <th className={th}>Amount</th>
            <th className={th}>Due date</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {charges.length === 0 ? (
            <tr>
              <td colSpan={4} className={`${td} text-center text-muted`}>
                No charges to show.
              </td>
            </tr>
          ) : (
            charges.map((charge) => (
              <tr key={charge.id} className={trHover}>
                <td className={`${td} font-medium`}>{charge.description}</td>
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

      {canManagePayments && (
        <div className="mt-6 grid grid-cols-1 gap-6 border-t border-border pt-5 sm:grid-cols-2">
          <form action={createChargeFormAction} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Create charge</h3>
            <input type="hidden" name="studentId" value={studentId} />
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
            <Button type="submit" disabled={creatingCharge} className="self-start">
              {creatingCharge ? "Creating..." : "Create charge"}
            </Button>
          </form>

          <form action={recordPaymentFormAction} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Record payment against a charge</h3>
            <input type="hidden" name="studentId" value={studentId} />
            <Field label="Charge">
              <select name="chargeId" required defaultValue="" className={inputClass}>
                <option value="" disabled>
                  {payableCharges.length === 0 ? "No open charges" : "Select a charge…"}
                </option>
                {payableCharges.map((charge) => (
                  <option key={charge.id} value={charge.id}>
                    {charge.description} — {formatMoney(charge.amountCents, charge.currency)} ({charge.status.replace("_", " ")})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount (USD)">
              <input type="number" name="amountDollars" min={0} step="0.01" placeholder="0.00" required className={inputClass} />
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
            <Button type="submit" disabled={recordingPayment || payableCharges.length === 0} className="self-start">
              {recordingPayment ? "Recording..." : "Record payment"}
            </Button>
          </form>
        </div>
      )}
    </Section>
  );
}

// ===========================================================================
// Payment history — merged fee-period + charge payments, one table
// ===========================================================================

function PaymentHistoryPanel({
  rows,
  canManagePayments,
  canReversePayments,
  currentUserId,
}: {
  rows: PaymentHistoryRow[];
  canManagePayments: boolean;
  canReversePayments: boolean;
  currentUserId: string;
}) {
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

  // Anyone who can see this section at all can VIEW an already-issued
  // receipt (getReceipt's own gate is view-or-above, same as payment
  // history itself) — only canManagePayments (Manager/Finance Officer)
  // additionally gets the "Issue receipt" action for one not yet issued.
  const reverseColumn = canReversePayments;
  const columnCount = 7 + (reverseColumn ? 1 : 0);

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Payment history</h2>
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Amount</th>
            <th className={th}>Method</th>
            <th className={th}>Reference</th>
            <th className={th}>Notes</th>
            <th className={th}>Fee period(s) / Charge</th>
            <th className={th}>Recorded by</th>
            <th className={th}>Status</th>
            <th className={th}>Receipt</th>
            {reverseColumn && <th className={th}>Reverse / Adjust</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={`${td} text-center text-muted`}>
                No payments recorded yet.
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const alreadyReversedThisSession = reversedIds.has(row.paymentId);
              const isSelfRecorded = row.recordedBy === currentUserId;
              const canReverseThisRow = canReversePayments && row.status === "approved" && !alreadyReversedThisSession;
              const effectiveStatus = alreadyReversedThisSession ? "reversed" : row.status;
              const issuedThisSession = issuedReceipts.get(row.paymentId);
              const receiptId = issuedThisSession?.id ?? row.receiptId;
              const receiptNumber = issuedThisSession?.receiptNumber ?? row.receiptNumber;
              return (
                <tr key={row.paymentId} className={trHover}>
                  <td className={td}>{row.receivedAt.toLocaleString()}</td>
                  <td className={`${td} font-medium`}>{formatMoney(row.amountCents, row.currency)}</td>
                  <td className={td}>{row.method.replace("_", " ")}</td>
                  <td className={td}>{row.reference ?? "—"}</td>
                  <td className={td}>{row.notes ?? "—"}</td>
                  <td className={td}>{row.description}</td>
                  <td className={td}>{row.recordedByLabel}</td>
                  <td className={td}>
                    <Badge label={effectiveStatus.replace("_", " ")} tone={getStatusTone(effectiveStatus)} />
                  </td>
                  <td className={td}>
                    {receiptId ? (
                      <LinkButton href={`/academy/receipts/${receiptId}`} variant="secondary" className="px-2.5 py-1 text-xs" target="_blank">
                        View {receiptNumber ?? "receipt"}
                      </LinkButton>
                    ) : canManagePayments ? (
                      <Button
                        type="button"
                        variant="secondary"
                        className="px-2.5 py-1 text-xs"
                        disabled={row.status !== "approved" || issuingId === row.paymentId}
                        onClick={() => handleIssueReceipt(row.paymentId)}
                      >
                        {issuingId === row.paymentId ? "Issuing..." : "Issue receipt"}
                      </Button>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  {reverseColumn && (
                    <td className={td}>
                      {!canReverseThisRow ? (
                        <span className="text-muted">—</span>
                      ) : reversalRowId === row.paymentId ? (
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
                              onClick={() => confirmReversal(row.paymentId)}
                            >
                              {isReversalPending ? "Working..." : reversalMode === "adjust" ? "Confirm adjustment" : "Confirm reversal"}
                            </Button>
                            <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={cancelReversal}>
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
                            onClick={() => startReversal(row.paymentId, "reverse")}
                          >
                            Reverse
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2.5 py-1 text-xs"
                            disabled={isSelfRecorded}
                            onClick={() => startReversal(row.paymentId, "adjust")}
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
    </Section>
  );
}
