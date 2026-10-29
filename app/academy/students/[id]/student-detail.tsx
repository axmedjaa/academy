"use client";

import { useActionState, useEffect, useState } from "react";
import type { StudentRecord } from "@/lib/academies/students";
import type {
  EnrollmentFeeScheduleRecord,
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
  recordStudentPaymentAction,
  type StudentPaymentsFormState,
} from "@/lib/academies/student-payments-actions";
import { BackLink, Badge, Button, ErrorMessage, Field, PageHeader, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { PAYMENT_PLAN_OPTIONS } from "@/lib/ui/payment-plan";
import { PaymentPlanField } from "@/app/academy/_shell/payment-plan-field";
import {
  ManageStudentSection,
  STATUS_LABEL,
  StatCards,
  StudentHeaderActions,
  StudentOverview,
  type EnrollmentDetail,
  type EnrollmentSummaryEntry,
} from "./student-overview";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import {
  ActionDialog,
  ChoiceChips,
  DField,
  DesignDialog,
  controlClass,
  invalidProps,
} from "@/app/academy/_shell/design-form";
import { Icon } from "@/app/academy/_shell/icons";
import { nextDuePeriod, outstandingCents, previewAllocation, previewScheduleChange } from "@/lib/ui/fee-allocation";
import { formatDate } from "@/lib/ui/date";
import { PaymentHistoryPanel, RefundHistoryPanel, type RefundHistoryRow } from "./payment-history";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { getStatusTone } from "@/lib/ui/status";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { Bone } from "@/app/academy/_shell/skeletons";

const initialState: StudentPaymentsFormState = { ok: false };


// The plan value is the number of monthly installments (see lib/ui/payment-plan.ts).
const INTERVAL_OPTIONS = PAYMENT_PLAN_OPTIONS;

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
    return `Not yet due — starts ${formatDate(period.periodStart)}.`;
  }
  switch (period.status) {
    case "paid":
      return "Fully paid — nothing remaining for this period.";
    case "overdue":
      return `Overdue since ${formatDate(period.dueDate)} — ${remaining} still due.`;
    case "partially_paid":
      return `${formatMoney(period.paidCents, currency)} paid so far — ${remaining} remaining.`;
    case "unpaid":
    default:
      return `${remaining} due by ${formatDate(period.dueDate)}.`;
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
  /** Payments tab "Applies to": the course · batch, or "Charge: …". */
  appliesTo: string;
  /** The fee periods covered ("Oct 29 – Nov 28, 2026"), when any. */
  appliesToDetail: string | null;
  recordedByLabel: string;
  recordedBy: string;
  notes: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  /** Refunded out of this payment on a course withdrawal (0 when none). */
  refundedCents: number;
}

interface Props {
  /** Opens on this tab (`?tab=fees` from a Collect link). */
  initialTab?: Tab;
  student: StudentRecord;
  /** This student's own short-lived signed R2 GET url, pre-resolved
   * server-side (page.tsx, via students.ts's `getStudentPhotoUrl`) —
   * null if they have no photo, or it couldn't be resolved. */
  photoUrl: string | null;
  branchName: string;
  enrollments: StudentEnrollmentOption[];
  enrollmentSummaries: EnrollmentSummaryEntry[];
  enrollmentDetails: Record<string, EnrollmentDetail>;
  /** Delete eligibility, or null when the viewer may not delete students. */
  deletion: { eligible: boolean; reasons: string[] } | null;
  charges: StudentChargeRecord[];
  historyRows: PaymentHistoryRow[];
  /** Refunds recorded on withdrawal: listed apart from payments. */
  refundRows: RefundHistoryRow[];
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
  /** Student edit rights (ACADEMY_STUDENTS_ACTION full/manage). */
  canEditStudent: boolean;
  /** Enroll / withdraw rights (ACADEMY_COURSES_BATCHES_ACTION full/manage). */
  canEnroll: boolean;
  enrollBatches: EnrollBatchOption[];
  currentUserId: string;
  /** "Today," server-computed in the academy's own Somalia-local calendar
   * (see lib/academies/fee-periods.ts's `todayDateOnlyInAcademyTimezone`) —
   * passed down rather than read from the browser's own clock/timezone, so
   * which fee periods count as "started yet" never depends on where the
   * staff member's browser happens to be. */
  today: string;
}

type Tab = "overview" | "fees" | "payments";

const TAB_CLASS = (on: boolean) =>
  `inline-flex min-h-11 items-center rounded-full px-4 text-[15px] font-semibold transition-colors duration-150 ${
    on ? "bg-brand-tint text-brand" : "text-[#374151] hover:bg-app"
  }`;
const SUBTAB_CLASS = (on: boolean) =>
  `inline-flex min-h-10 items-center whitespace-nowrap rounded-full border px-3.5 text-sm font-semibold transition-colors duration-150 ${
    on ? "border-brand bg-brand text-white" : "border-border-strong bg-surface text-ink hover:bg-app"
  }`;

/**
 * Student detail (design A02 detail): back link, name with student number
 * and branch, Enroll / Edit actions, then the Overview, Fees and Payments
 * tabs. Fees has one sub-tab per active enrollment (each course has its
 * own fee plan and periods) plus One-off charges. The finance panels below
 * are the existing, unchanged workflows (fee schedules, per-period and
 * catch-up payments, charges, reversals and adjustments, receipts).
 */
export function StudentDetail({
  initialTab = "overview",
  student,
  photoUrl,
  branchName,
  enrollments,
  enrollmentSummaries,
  enrollmentDetails,
  deletion,
  charges,
  historyRows,
  refundRows,
  paymentsSectionVisible,
  canManagePayments,
  canReversePayments,
  canEditStudent,
  canEnroll,
  enrollBatches,
  currentUserId,
  today,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const feeTabs = enrollmentSummaries.map((entry) => ({
    key: entry.enrollment.id,
    label: `${entry.enrollment.batchCode} · ${entry.enrollment.courseName}`,
  }));
  const [feeTab, setFeeTab] = useState<string>(feeTabs[0]?.key ?? "charges");
  const feeEntry = enrollmentSummaries.find((entry) => entry.enrollment.id === feeTab) ?? null;

  return (
    <>
      <BackLink href="/academy/students" label="All students" />
      <PageHeader
        title={student.fullName}
        description={`${student.studentNumber} · ${branchName}`}
        actions={
          <StudentHeaderActions
            student={student}
            enrollments={enrollments}
            enrollBatches={enrollBatches}
            canEnroll={canEnroll}
            canEdit={canEditStudent}
            enrollOpen={enrollOpen}
            onEnrollOpenChange={setEnrollOpen}
          />
        }
      />

      <div role="tablist" aria-label="Student sections" className="mb-6 flex flex-wrap gap-2">
        {(
          [
            ["overview", "Overview"],
            ["fees", "Fees"],
            ["payments", "Payments"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={TAB_CLASS(tab === key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <StudentOverview
          student={student}
          photoUrl={photoUrl}
          branchName={branchName}
          enrollments={enrollments}
          enrollmentSummaries={enrollmentSummaries}
          enrollmentDetails={enrollmentDetails}
          canEditPhoto={canEditStudent}
          canWithdraw={canEnroll}
          canEnroll={canEnroll && enrollBatches.length > 0}
          onEnroll={() => setEnrollOpen(true)}
        />
      )}

      {tab === "fees" && (
        <div className="flex flex-col gap-6">
          <div role="tablist" aria-label="Fee plans" className="flex gap-2 overflow-x-auto pb-1">
            {feeTabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={feeTab === item.key}
                onClick={() => setFeeTab(item.key)}
                className={SUBTAB_CLASS(feeTab === item.key)}
              >
                {item.label}
              </button>
            ))}
            {paymentsSectionVisible && (
              <button
                type="button"
                role="tab"
                aria-selected={feeTab === "charges"}
                onClick={() => setFeeTab("charges")}
                className={SUBTAB_CLASS(feeTab === "charges")}
              >
                One-off charges
              </button>
            )}
          </div>
          {feeEntry ? (
            <EnrollmentPaymentPanel
              key={feeEntry.enrollment.id}
              studentId={student.id}
              studentName={student.fullName}
              entry={feeEntry}
              canManagePayments={canManagePayments}
              today={today}
            />
          ) : feeTab === "charges" && paymentsSectionVisible ? (
            <ChargesPanel studentId={student.id} charges={charges} canManagePayments={canManagePayments} />
          ) : (
            <Section>
              <p className="text-sm text-muted">
                {enrollments.length === 0 ? "This student has no course enrollment yet." : "This student has no active course enrollment."}
              </p>
            </Section>
          )}
        </div>
      )}

      {tab === "payments" &&
        (paymentsSectionVisible ? (
          <>
            <PaymentHistoryPanel
              rows={historyRows}
              studentName={student.fullName}
              photoUrl={photoUrl}
              canManagePayments={canManagePayments}
              canReversePayments={canReversePayments}
              currentUserId={currentUserId}
            />
            <RefundHistoryPanel rows={refundRows} />
          </>
        ) : (
          <Section>
            <p className="text-sm text-muted">Payments aren&apos;t available to your role.</p>
          </Section>
        ))}

      <ManageStudentSection student={student} canArchive={canEditStudent} deletion={deletion} />
    </>
  );
}

// ===========================================================================
// Payment summary + Record Payment (fee-period / enrollment payments)
// ===========================================================================

function EnrollmentPaymentPanel({
  studentId,
  studentName,
  entry,
  canManagePayments,
  today,
}: {
  studentId: string;
  studentName: string;
  entry: EnrollmentSummaryEntry;
  canManagePayments: boolean;
  today: string;
}) {
  const { enrollment, schedule, summary } = entry;
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

  // Every installment of the schedule is a real fee_periods row from the
  // moment the schedule is set (generateFeePeriodsForEnrollment), so the
  // list shows all of them, oldest first: past, due and upcoming. Upcoming
  // rows are labelled as such and are not counted as overdue.
  const visiblePeriods = [...periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const [periodPage, setPeriodPage] = useState(1);
  const periodPages = Math.max(1, Math.ceil(visiblePeriods.length / PERIOD_ROWS));
  const currentPeriodPage = Math.min(periodPage, periodPages);
  const pagePeriods = visiblePeriods.slice((currentPeriodPage - 1) * PERIOD_ROWS, currentPeriodPage * PERIOD_ROWS);
  const [payAllOpen, setPayAllOpen] = useState(false);

  // Course totals from the persisted period ledger (expected and approved
  // allocations per period), across every period — the same set the server
  // allocates a payment against. The server summary counts started periods
  // only, so it is used for the overall status, not for these totals.
  const currency = schedule?.currency ?? periods[0]?.currency ?? "USD";
  const ledgerLoaded = periods.length > 0;
  const scheduledCents = periods.reduce((sum, period) => sum + period.expectedAmountCents, 0);
  const paidCents = periods.reduce((sum, period) => sum + period.paidCents, 0);
  const outstanding = outstandingCents(periods);
  const nextDue = nextDuePeriod(periods);

  const per = schedule ? `${schedule.intervalMonths} x ${formatMoney(schedule.monthlyInstallmentCents, schedule.currency)}` : "";

  // Design A02 Fees tab: four stat cards for the selected course, then one
  // row (or card, when narrow) per fee period; the schedule editor and the
  // catch-up payment stay below for those who can manage payments.
  return (
    <div className="flex flex-col">
      {schedule && summary ? (
        <StatCards
          items={[
            {
              label: "Course fee",
              value: formatMoney(ledgerLoaded ? scheduledCents : schedule.amountCents, currency),
              hint: per,
              icon: "receipt_long",
            },
            {
              label: "Paid",
              value: ledgerLoaded ? formatMoney(paidCents, currency) : "…",
              hint: "Payments recorded and applied",
              icon: "payments",
            },
            {
              label: "Remaining",
              value: ledgerLoaded ? formatMoney(outstanding, currency) : "…",
              hint: nextDue
                ? `Next due ${formatDate(nextDue.dueDate)} · ${formatMoney(nextDue.remainingCents, nextDue.currency)}`
                : ledgerLoaded
                  ? "Nothing outstanding"
                  : "",
              icon: "payments",
            },
            { label: "Status", value: outstanding === 0 && ledgerLoaded ? "Paid" : (STATUS_LABEL[summary.status] ?? summary.status), icon: "info" },
          ]}
        />
      ) : (
        <Section className="mb-8">
          <p className="text-sm text-muted">{schedule ? "Fee totals are not available to your role." : "No fee schedule set yet."}</p>
        </Section>
      )}

      {canManagePayments && (
        <Section className="mb-8">
          <h2 className="mb-1 text-base font-semibold text-ink">
            {enrollment.courseName} · {enrollment.batchCode}
          </h2>
          <p className="mb-3 text-[13px] text-muted">
            {schedule
              ? `${schedule.intervalMonths} monthly payment${schedule.intervalMonths === 1 ? "" : "s"} of ${formatMoney(schedule.monthlyInstallmentCents, schedule.currency)}, ${formatMoney(schedule.amountCents, schedule.currency)} in total.`
              : "Set the fee schedule to generate this course's fee periods."}
          </p>
          <ScheduleForm
            enrollmentId={enrollment.id}
            schedule={schedule}
            periods={periods}
            today={today}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        </Section>
      )}

      {periodsError && (
        <div className="mb-6">
          <ErrorMessage message={periodsError} />
        </div>
      )}

      {schedule && (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">
              Fee periods {visiblePeriods.length > 0 && <span className="font-normal text-muted">({visiblePeriods.length})</span>}
            </h2>
            {canManagePayments && ledgerLoaded && (
              <span className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => setPayAllOpen(true)}
                  disabled={outstanding === 0}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="payments" width={18} height={18} />
                  Pay all remaining fees
                </button>
                {outstanding === 0 && <span className="text-xs text-muted">Nothing outstanding: every period is paid.</span>}
              </span>
            )}
          </div>
          {loadingPeriods && <span className="sr-only" role="status">Loading fee periods…</span>}
          {visiblePeriods.length === 0 ? (
            <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
              {loadingPeriods ? (
                <span aria-hidden="true" className="mx-auto flex max-w-md flex-col gap-2">
                  <Bone className="h-4 w-full" />
                  <Bone className="h-4 w-2/3" />
                </span>
              ) : (
                "No fee periods due yet."
              )}
            </div>
          ) : (
            <DataTable stackBelow={900}>
              <thead>
                <tr>
                  <th className={rtTh}>#</th>
                  <th className={rtTh}>Due</th>
                  <th className={`${rtTh} text-right`}>Expected</th>
                  <th className={`${rtTh} text-right`}>Paid</th>
                  <th className={`${rtTh} text-right`}>Remaining</th>
                  <th className={rtTh}>Status</th>
                  {canManagePayments && (
                    <th className={rtTh}>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {pagePeriods.map((period, index) => (
                  <PeriodRow
                    key={period.id}
                    number={(currentPeriodPage - 1) * PERIOD_ROWS + index + 1}
                    period={period}
                    today={today}
                    studentId={studentId}
                    canManage={canManagePayments}
                    onRecorded={() => setRefreshKey((k) => k + 1)}
                  />
                ))}
              </tbody>
            </DataTable>
          )}
          {periodPages > 1 && (
            <nav aria-label="Fee period pages" className="mb-8 mt-[-1rem] flex items-center justify-between gap-2">
              <button type="button" className={PAGER_BUTTON} onClick={() => setPeriodPage(currentPeriodPage - 1)} disabled={currentPeriodPage <= 1}>
                Previous
              </button>
              <span className="text-[13px] text-[#374151]">
                Page {currentPeriodPage} of {periodPages}
              </span>
              <button type="button" className={PAGER_BUTTON} onClick={() => setPeriodPage(currentPeriodPage + 1)} disabled={currentPeriodPage >= periodPages}>
                Next
              </button>
            </nav>
          )}

          {payAllOpen && (
            <PayAllRemainingDialog
              studentId={studentId}
              studentName={studentName}
              enrollment={enrollment}
              periods={visiblePeriods}
              currency={currency}
              onClose={() => setPayAllOpen(false)}
              onRecorded={() => {
                setPayAllOpen(false);
                setRefreshKey((k) => k + 1);
              }}
            />
          )}

          {canManagePayments && outstanding > 0 && (
            <Section className="mb-8">
              <h3 className="text-base font-semibold text-ink">Record a partial payment</h3>
              <p className="mt-1 text-[13px] text-muted">
                One amount, applied to the oldest outstanding period first. To pay one period, use its Record payment
                action above; to settle everything, use Pay all remaining fees.
              </p>
              <RecordEnrollmentPaymentForm
                studentId={studentId}
                enrollmentId={enrollment.id}
                remainingCents={outstanding}
                currency={schedule?.currency ?? "USD"}
                onDone={() => setRefreshKey((k) => k + 1)}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}



/** One fee_periods row plus its own per-row Record Payment action. No
 * Action control is rendered at all for an already-`paid` period (not
 * merely disabled) — see fee-periods-manager.tsx's identical PeriodRow for
 * the full reasoning. */
/** Fee periods per page (design `T` tables page at six). */
const PERIOD_ROWS = 6;
const PAGER_BUTTON =
  "h-10 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";
const METHOD_OPTIONS = [
  { value: "cash", label: "Cash", icon: "cash" },
  { value: "mobile_money", label: "Mobile money", icon: "phone" },
  { value: "bank_transfer", label: "Bank transfer", icon: "bank" },
];

/**
 * "Pay all remaining fees": one payment for the course's whole outstanding
 * balance, confirmed before it is recorded. Shows who, which course, the
 * balance, method, date, reference and notes, and how the amount will be
 * applied to each period (oldest first, the server's own rule). Recorded
 * through `recordEnrollmentPaymentAction`, which re-derives the
 * allocation, refuses any overpayment and writes the payment and its
 * allocations in one transaction — one payment, one allocation per period.
 */
function PayAllRemainingDialog({
  studentId,
  studentName,
  enrollment,
  periods,
  currency,
  onClose,
  onRecorded,
}: {
  studentId: string;
  studentName: string;
  enrollment: StudentEnrollmentOption;
  periods: FeePeriodRecord[];
  currency: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const amountCents = outstandingCents(periods);
  const preview = previewAllocation(periods, amountCents);
  const numberOf = new Map(periods.map((period, index) => [period.id, index + 1]));
  const byId = new Map(periods.map((period) => [period.id, period]));
  const [nowLocal] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  return (
    <ActionDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Pay all remaining fees"
      description="Records one payment for the whole outstanding balance and applies it to every unpaid period, oldest first."
      summary={[
        { label: "Student", value: studentName },
        { label: "Course", value: `${enrollment.courseName} · ${enrollment.batchCode}` },
        { label: "Outstanding balance", value: formatMoney(amountCents, currency) },
        { label: "Amount to be received", value: formatMoney(amountCents, currency) },
      ]}
      submitLabel={`Record ${formatMoney(amountCents, currency)}`}
      pendingLabel="Recording…"
      rules={[{ name: "receivedAt", label: "Date received", required: true }]}
      run={async (data) => {
        const result = await recordEnrollmentPaymentAction({
          studentId,
          enrollmentId: enrollment.id,
          amountCents,
          currency,
          method: String(data.get("method") ?? "cash") as "cash" | "mobile_money" | "bank_transfer",
          reference: String(data.get("reference") ?? "") || undefined,
          notes: String(data.get("notes") ?? "") || undefined,
          receivedAt: String(data.get("receivedAt") ?? ""),
        });
        return result.ok ? null : (result.error?.message ?? "The payment could not be recorded.");
      }}
      onDone={() => {
        showSuccessToast(`${formatMoney(amountCents, currency)} recorded across ${preview.allocations.length} period${preview.allocations.length === 1 ? "" : "s"}.`);
        onRecorded();
      }}
    >
      {({ errors, blur }) => (
        <>
          <DField label="Method" name="method" group full>
            <ChoiceChips name="method" options={METHOD_OPTIONS} defaultValue="cash" />
          </DField>
          <DField label="Date received" name="receivedAt" required error={errors.receivedAt}>
            <input
              type="datetime-local"
              name="receivedAt"
              defaultValue={nowLocal}
              onBlur={blur("receivedAt")}
              className={controlClass(Boolean(errors.receivedAt))}
              {...invalidProps("receivedAt", errors.receivedAt)}
            />
          </DField>
          <DField label="Reference" name="reference">
            <input name="reference" maxLength={200} placeholder="e.g. MM-84920" className={controlClass(false)} />
          </DField>
          <DField label="Notes" name="notes" full>
            <input name="notes" maxLength={1000} placeholder="Optional" className={controlClass(false)} />
          </DField>
          <div className="col-span-full">
            <div className="mb-1.5 text-[13px] font-semibold text-ink">How it is applied</div>
            <ul className="divide-y divide-border rounded-lg border border-border bg-[#FAFBFC] text-sm">
              {preview.allocations.map((allocation) => {
                const period = byId.get(allocation.periodId)!;
                return (
                  <li key={allocation.periodId} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-[#374151]">
                      #{numberOf.get(allocation.periodId)} · due {formatDate(period.dueDate)}
                    </span>
                    <span className="font-semibold tabular-nums text-ink">{formatMoney(allocation.amountCents, currency)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </ActionDialog>
  );
}

const PERIOD_STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  paid: { label: "Paid", tone: "green" },
  partially_paid: { label: "Partially paid", tone: "amber" },
  unpaid: { label: "Unpaid", tone: "amber" },
  overdue: { label: "Overdue", tone: "red" },
};

function PeriodRow({
  number,
  period,
  today,
  studentId,
  canManage,
  onRecorded,
}: {
  number: number;
  period: FeePeriodRecord;
  today: string;
  studentId: string;
  canManage: boolean;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const future = isFuturePeriod(period, today);
  const status =
    future ? { label: "Upcoming", tone: "gray" as const } : (PERIOD_STATUS[period.status] ?? { label: period.status, tone: "gray" as const });

  return (
    <tr className={trHover}>
      <td className={rtTd} data-label="#">
        <span className="font-semibold text-ink">#{number}</span>
        <span className="block text-xs tabular-nums text-muted">
          {formatDate(period.periodStart)} – {formatDate(period.periodEnd)}
        </span>
      </td>
      <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Due">
        {formatDate(period.dueDate)}
      </td>
      <td className={`${rtTd} text-right tabular-nums`} data-label="Expected">
        {formatMoney(period.expectedAmountCents, period.currency)}
      </td>
      <td className={`${rtTd} text-right tabular-nums`} data-label="Paid">
        {formatMoney(period.paidCents, period.currency)}
      </td>
      <td className={`${rtTd} text-right tabular-nums`} data-label="Remaining">
        {formatMoney(period.remainingCents, period.currency)}
      </td>
      <td className={rtTd} data-label="Status">
        <Badge label={status.label} tone={status.tone} />
        <span className="mt-1 block text-xs text-muted">{periodGuidance(period, period.currency, today)}</span>
      </td>
      {canManage && (
        <td className={rtTd} data-actions="">
          {period.remainingCents > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app"
              >
                Record payment
              </button>
              <DesignDialog
                open={open}
                onOpenChange={setOpen}
                title={`Record payment for period #${number}`}
                description={`${formatDate(period.periodStart)} – ${formatDate(period.periodEnd)} · ${formatMoney(period.remainingCents, period.currency)} remaining`}
              >
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  <PeriodPaymentForm
                    studentId={studentId}
                    period={period}
                    onDone={() => {
                      setOpen(false);
                      onRecorded();
                    }}
                    onCancel={() => setOpen(false)}
                  />
                </div>
              </DesignDialog>
            </>
          ) : (
            <span className="text-xs text-muted">Paid in full</span>
          )}
        </td>
      )}
    </tr>
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
  periods,
  today,
  onSaved,
}: {
  enrollmentId: string;
  schedule: EnrollmentFeeScheduleRecord | null;
  /** The enrollment's current fee periods (all of them, upcoming included). */
  periods: FeePeriodRecord[];
  today: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(schedule === null);
  const [intervalMonths, setIntervalMonths] = useState<number>(schedule?.intervalMonths ?? 1);
  // Entered/displayed in dollars (e.g. "10.00"), never raw cents — see
  // lib/ui/money.ts's dollarsToCents/centsToDollars.
  const [amountDollars, setAmountDollars] = useState(schedule ? centsToDollars(schedule.amountCents) : "");
  const [anchorDate, setAnchorDate] = useState(schedule?.anchorDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = schedule?.currency ?? "USD";

  // What setEnrollmentFeeSchedule will actually do (lib/ui/fee-allocation.ts
  // mirrors its rule): started or paid periods stay as they are with their
  // own amounts; once any do, the part of the plan they don't already
  // charge carries over and the new installments start the day after them,
  // whatever amount or date is typed. Those two fields are locked to the
  // server's figures in that case rather than accepting a value the server
  // would silently replace.
  const typedCents = dollarsToCents(amountDollars) ?? 0;
  const preview = previewScheduleChange({
    current: schedule ? { amountCents: schedule.amountCents, anchorDate: schedule.anchorDate } : null,
    periods,
    today,
    amountCents: typedCents,
    anchorDate,
    count: intervalMonths,
  });

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>
        Change payment plan
      </Button>
    );
  }

  async function handleSave() {
    setError(null);
    const amount = preview.amountCarried ? preview.totalCents : dollarsToCents(amountDollars);
    const date = preview.dateMoved ? (preview.installments[0]?.date ?? anchorDate) : anchorDate;
    if (amount === null || amount <= 0 || !date) {
      setError("Enter a valid amount and start date.");
      return;
    }
    setSaving(true);
    const result = await setEnrollmentFeeScheduleAction({ enrollmentId, intervalMonths, amountCents: amount, anchorDate: date });
    setSaving(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Failed to save fee schedule.");
      showErrorToast(result.error?.message ?? "Failed to save fee schedule.");
      return;
    }
    showSuccessToast(schedule ? "Payment plan changed." : "Payment plan saved.");
    setOpen(false);
    onSaved();
  }

  const planLabel = (count: number) => INTERVAL_OPTIONS.find((option) => option.value === count)?.label ?? `${count} payments`;

  return (
    <div className="rounded-card border border-border bg-app p-4">
      <h3 className="text-sm font-semibold text-ink">{schedule ? "Change payment plan" : "Set payment plan"}</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PaymentPlanField name="intervalMonths" value={intervalMonths} onChange={setIntervalMonths} />
        <Field label={preview.amountCarried ? "Amount still to schedule (carried over)" : "Total fee (USD)"}>
          <input
            type="number"
            min={0.01}
            step="0.01"
            placeholder="0.00"
            className={inputClass}
            value={preview.amountCarried ? centsToDollars(preview.totalCents) : amountDollars}
            disabled={preview.amountCarried}
            onChange={(e) => setAmountDollars(e.target.value)}
          />
        </Field>
        <Field label={preview.dateMoved ? "First new installment (after kept periods)" : "First installment date"}>
          <input
            type="date"
            className={inputClass}
            value={preview.dateMoved ? (preview.installments[0]?.date ?? "") : anchorDate}
            disabled={preview.dateMoved}
            onChange={(e) => setAnchorDate(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {schedule && (
          <div className="rounded-lg border border-border bg-surface p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Saved plan</div>
            <div className="mt-1 font-semibold text-ink">
              {planLabel(schedule.intervalMonths)} · {formatMoney(schedule.amountCents, currency)}
            </div>
            <div className="mt-1 text-[13px] text-muted">From {formatDate(schedule.anchorDate)}</div>
            {preview.keptCount > 0 && (
              <p className="mt-2 text-[13px] text-[#374151]">
                {preview.keptCount} period{preview.keptCount === 1 ? " has" : "s have"} started or been paid (
                {formatMoney(preview.keptPaidCents, currency)} paid). {preview.keptCount === 1 ? "It stays" : "They stay"} exactly
                as recorded; only later, unpaid periods are replaced.
              </p>
            )}
          </div>
        )}
        <div className="rounded-lg border border-dashed border-[#F0CDD5] bg-surface p-3 text-sm" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Proposed plan</span>
            <Badge label="Preview, not saved" tone="amber" />
          </div>
          {preview.nothingToReschedule ? (
            <p className="mt-2 text-[13px] text-[#374151]">
              Nothing left to reschedule: every installment of the saved plan has started or been paid.
            </p>
          ) : preview.installments.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted">Enter an amount and a first installment date to see the installments.</p>
          ) : (
            <>
              <div className="mt-1 font-semibold text-ink">
                {planLabel(intervalMonths)} · {formatMoney(preview.totalCents, currency)}
              </div>
              <ul className="mt-2 divide-y divide-border">
                {preview.installments.map((installment, index) => (
                  <li key={installment.date} className="flex justify-between gap-3 py-1.5">
                    <span className="text-[#374151]">
                      {index + 1}. due {formatDate(installment.date)}
                    </span>
                    <span className="font-semibold tabular-nums text-ink">{formatMoney(installment.amountCents, currency)}</span>
                  </li>
                ))}
              </ul>
              {preview.amountCarried && (
                <p className="mt-2 text-[13px] text-muted">
                  The saved plan&apos;s total less the installments kept above, which keep their own amounts and balances,
                  so the total owed doesn&apos;t change.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {preview.nothingToReschedule && (
        <div role="alert" className="mt-3 rounded-lg border border-[#F5D08A] bg-[#FFF8E6] px-3 py-2 text-[13px] text-[#7A4B00]">
          This plan can&apos;t be changed. Every installment has started or been paid, so a new plan could only add charges
          beyond the course fee. Record payments against the existing periods instead.
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorMessage message={error} />
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button type="button" disabled={saving || preview.installments.length === 0} onClick={handleSave}>
          {saving ? "Saving..." : schedule ? "Save new plan" : "Save plan"}
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
