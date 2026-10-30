"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StudentRecord } from "@/lib/academies/students";
import type {
  EnrollmentFeeScheduleRecord,
  EnrollmentPaymentSummary,
  FeePeriodRecord,
  StudentEnrollmentOption,
} from "@/lib/academies/fee-periods";
import { getWithdrawDialogDataAction, withdrawStudentWithRefundAction } from "@/lib/academies/course-refunds-actions";
import type { CourseRefundPosition } from "@/lib/academies/course-refunds";
import { checkRefundAmount } from "@/lib/academies/course-refund-rules";
import { outstandingCents } from "@/lib/ui/fee-allocation";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { deleteStudent, updateStudent, updateStudentStatus, type StudentFormState } from "@/lib/academies/students-actions";
import { withdrawStudentFromBatch } from "@/lib/academies/batch-assignments-actions";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { showSuccessToast } from "@/lib/ui/toast";
import { Badge, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, FeeProgress, KvCard, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChatActions } from "@/app/academy/_shell/chat-actions";
import { Icon } from "@/app/academy/_shell/icons";
import { EnrollCoursesDialog } from "@/app/academy/_shell/enroll-courses-dialog";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  ActionDialog,
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  PhoneField,
  ReasonField,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { StudentPhotoField } from "../student-photo-field";
import { StudentAvatar } from "../student-avatar";
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedUpdateStudent = guardAction(updateStudent);

/**
 * Student detail, Overview (design A02 detail): header actions, the photo
 * block, the Student key-value card (phones with WhatsApp / Telegram),
 * fee totals across active enrollments, and the student's enrollments: one
 * row per course, current and past. A student can take several courses in
 * one or more batches; Enroll adds courses, Withdraw ends one enrollment
 * and leaves the others untouched. Every action is an existing server
 * action that re-checks permission and scope.
 */

/** Per-enrollment details for the design A02 course tables, built by the
 * page. `null` means the viewer cannot see that data (no timetable or
 * finance access), shown as "Not available" rather than a zero. */
export interface EnrollmentDetail {
  /** Active: "Mon/Wed 09:00 to 11:00", "" when the course has no classes. */
  schedule?: string | null;
  trainers?: string[] | null;
  /** Past: approved fee-period payments for the course, and refunds
   * recorded for it on withdrawal (student_course_refunds — never
   * reversals, which correct a payment entered in error). */
  paidCents?: number | null;
  refundedCents?: number | null;
  currency?: string | null;
  /** Past, withdrawn: from the withdraw audit entry. */
  withdrawnAt?: Date | null;
  withdrawReason?: string | null;
}

const BATCH_STATUS: Record<StudentEnrollmentOption["batchStatus"], { label: string; tone: "blue" | "green" | "slate" | "gray" }> = {
  planned: { label: "Planned", tone: "blue" },
  active: { label: "Active", tone: "green" },
  completed: { label: "Completed", tone: "slate" },
  archived: { label: "Archived", tone: "gray" },
};

export interface EnrollmentSummaryEntry {
  enrollment: StudentEnrollmentOption;
  schedule: EnrollmentFeeScheduleRecord | null;
  summary: EnrollmentPaymentSummary | null;
}

const HEADER_PRIMARY =
  "inline-flex h-11 items-center rounded-lg bg-brand px-[18px] text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover";
const HEADER_SECONDARY =
  "inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-[18px] text-[15px] font-semibold text-ink transition-colors duration-150 hover:bg-app";
const ROW_BTN =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

/* ------------------------------------------------------------------ */
/* Header actions                                                      */
/* ------------------------------------------------------------------ */

export function StudentHeaderActions({
  student,
  enrollments,
  enrollBatches,
  canEnroll,
  canEdit,
  enrollOpen,
  onEnrollOpenChange,
}: {
  student: StudentRecord;
  enrollments: StudentEnrollmentOption[];
  enrollBatches: EnrollBatchOption[];
  canEnroll: boolean;
  canEdit: boolean;
  /** Owned by the page so the Overview's "Enroll now" opens the same dialog. */
  enrollOpen: boolean;
  onEnrollOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const active = enrollments.filter((e) => e.status === "active");
  const enrolledPairs = { [student.id]: active.map((e) => `${e.batchId}:${e.courseId}`) };
  const canEnrollNow = canEnroll && student.status === "active" && enrollBatches.length > 0;

  return (
    <>
      {canEnrollNow && (
        <button type="button" className={active.length === 0 ? HEADER_PRIMARY : HEADER_SECONDARY} onClick={() => onEnrollOpenChange(true)}>
          {active.length === 0 ? "Enroll in a batch" : "Enroll in another course"}
        </button>
      )}
      {canEdit && (
        <button type="button" className={HEADER_SECONDARY} onClick={() => setEditOpen(true)}>
          Edit student
        </button>
      )}

      {canEnrollNow && (
        <EnrollCoursesDialog
          open={enrollOpen}
          onOpenChange={onEnrollOpenChange}
          student={{ id: student.id, fullName: student.fullName, studentNumber: student.studentNumber }}
          batches={enrollBatches}
          enrolledPairs={enrolledPairs}
          onEnrolled={() => router.refresh()}
        />
      )}
      {canEdit && (
        <EditStudentDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          student={student}
          onSaved={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Edit student                                                        */
/* ------------------------------------------------------------------ */

const EDIT_RULES: DesignFormRule[] = [
  { name: "fullName", label: "Full name", required: true },
  {
    name: "address",
    label: "Home address",
    check: (value) => (value.trim().length > 500 ? "Keep the address under 500 characters." : null),
  },
  {
    name: "district",
    label: "District",
    check: (value) => (value.trim().length > 120 ? "Keep the district under 120 characters." : null),
  },
  {
    name: "email",
    label: "Email",
    check: (value) => (value.trim() && !/^\S+@\S+\.\S+$/.test(value.trim()) ? "Enter a valid email address." : null),
  },
  {
    name: "dateOfBirth",
    label: "Date of birth",
    check: (value) => (value && value > new Date().toISOString().slice(0, 10) ? "Date of birth cannot be in the future." : null),
  },
];

const editInitial: StudentFormState = { ok: false };

function EditStudentFields({ student, onCancel, onSaved }: { student: StudentRecord; onCancel: () => void; onSaved: () => void }) {
  const [state, formAction, pending] = useActionState(guardedUpdateStudent, editInitial);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(EDIT_RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Student updated.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/email/i, "email"],
        [/birth/i, "dateOfBirth"],
        [/guardian phone/i, "guardianPhone"],
        [/address/i, "address"],
        [/district/i, "district"],
        [/phone/i, "phone"],
        [/name/i, "fullName"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      {/* Status and branch are left out: status changes use Archive and
          Restore, and updateStudent keeps both when the form omits them. */}
      <input type="hidden" name="studentId" value={student.id} />
      <DialogBody>
        <FieldGrid>
          <DField label="Full name" name="fullName" required error={errors.fullName} full>
            <input
              type="text"
              name="fullName"
              defaultValue={student.fullName}
              onBlur={blur("fullName")}
              className={controlClass(Boolean(errors.fullName))}
              {...invalidProps("fullName", errors.fullName)}
            />
          </DField>
          <DField label="Phone" name="phone" error={errors.phone}>
            <PhoneField name="phone" defaultValue={student.phone} error={errors.phone} />
          </DField>
          <DField label="Email (optional)" name="email" error={errors.email}>
            <input
              type="email"
              name="email"
              defaultValue={student.email ?? ""}
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps("email", errors.email)}
            />
          </DField>
          <DField label="Guardian name" name="guardianName">
            <input type="text" name="guardianName" defaultValue={student.guardianName ?? ""} className={controlClass(false)} />
          </DField>
          <DField label="Guardian phone" name="guardianPhone" error={errors.guardianPhone}>
            <PhoneField name="guardianPhone" defaultValue={student.guardianPhone} error={errors.guardianPhone} />
          </DField>
          <DField label="Date of birth" name="dateOfBirth" error={errors.dateOfBirth}>
            <input
              type="date"
              name="dateOfBirth"
              defaultValue={student.dateOfBirth ?? ""}
              onBlur={blur("dateOfBirth")}
              className={controlClass(Boolean(errors.dateOfBirth))}
              {...invalidProps("dateOfBirth", errors.dateOfBirth)}
            />
          </DField>
          <DField label="Gender" name="gender">
            <select name="gender" defaultValue={student.gender ?? ""} className={controlClass(false)}>
              <option value="">Not specified</option>
              <option value="Female">Female</option>
              <option value="Male">Male</option>
            </select>
          </DField>
          <DField label="District (optional)" name="district" error={errors.district}>
            <input
              type="text"
              name="district"
              maxLength={120}
              autoComplete="address-level2"
              placeholder="Hargeisa"
              defaultValue={student.district ?? ""}
              onBlur={blur("district")}
              className={controlClass(Boolean(errors.district))}
              {...invalidProps("district", errors.district)}
            />
          </DField>
          <DField label="Home address (optional)" name="address" error={errors.address} full>
            <input
              type="text"
              name="address"
              maxLength={500}
              autoComplete="street-address"
              placeholder="Street or neighbourhood"
              defaultValue={student.address ?? ""}
              onBlur={blur("address")}
              className={controlClass(Boolean(errors.address))}
              {...invalidProps("address", errors.address)}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Save" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}

function EditStudentDialog({
  open,
  onOpenChange,
  student,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  student: StudentRecord;
  onSaved: () => void;
}) {
  return (
    <DesignDialog open={open} onOpenChange={onOpenChange} title="Edit student" description="Status changes use Archive and Restore.">
      {open && <EditStudentFields student={student} onCancel={() => onOpenChange(false)} onSaved={onSaved} />}
    </DesignDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function ageOn(dateOfBirth: string): number | null {
  const born = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

function PhoneRow({ phone, who }: { phone: string | null; who: string }) {
  if (!phone) return <span className="text-muted">Not given</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="tabular-nums">{phone}</span>
      <ChatActions phone={phone} who={who} variant="pill" />
    </span>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  overdue: "Overdue",
  partially_paid: "Partly paid",
  unpaid: "Unpaid",
};

export function StudentOverview({
  student,
  photoUrl,
  enrollments,
  enrollmentSummaries,
  enrollmentDetails,
  canEditPhoto,
  canWithdraw,
  canEnroll,
  onEnroll,
}: {
  student: StudentRecord;
  photoUrl: string | null;
  branchName: string;
  enrollments: StudentEnrollmentOption[];
  enrollmentSummaries: EnrollmentSummaryEntry[];
  enrollmentDetails: Record<string, EnrollmentDetail>;
  canEditPhoto: boolean;
  canWithdraw: boolean;
  canEnroll: boolean;
  onEnroll: () => void;
}) {
  const router = useRouter();
  const [withdrawId, setWithdrawId] = useState<string | null>(null);

  const active = enrollments.filter((e) => e.status === "active");
  const past = enrollments.filter((e) => e.status !== "active");
  const byEnrollment = new Map(enrollmentSummaries.map((entry) => [entry.enrollment.id, entry]));
  const withdrawRow = enrollments.find((e) => e.id === withdrawId) ?? null;

  // Totals across active enrollments (shown only when every plan uses one currency).
  const plans = enrollmentSummaries.filter((entry) => entry.schedule && entry.summary);
  const currencies = new Set(plans.map((entry) => entry.schedule!.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const total = plans.reduce((n, entry) => n + entry.schedule!.amountCents, 0);
  const paid = plans.reduce((n, entry) => n + entry.summary!.paidCents, 0);
  const remaining = plans.reduce((n, entry) => n + Math.max(0, entry.schedule!.amountCents - entry.summary!.paidCents), 0);
  const statuses = plans.map((entry) => entry.summary!.status);
  const overall = statuses.includes("overdue")
    ? "overdue"
    : statuses.length > 0 && statuses.every((s) => s === "paid")
      ? "paid"
      : statuses.some((s) => s === "partially_paid" || s === "paid")
        ? "partially_paid"
        : "unpaid";
  const dob = student.dateOfBirth ? ageOn(student.dateOfBirth) : null;

  return (
    <>
      {canEditPhoto ? (
        <StudentPhotoField
          mode="edit"
          studentId={student.id}
          currentPhotoUrl={photoUrl}
          onChanged={() => router.refresh()}
          hero={{ fullName: student.fullName }}
        />
      ) : (
        <section className="mb-8 flex flex-wrap items-center gap-5 rounded-card border border-border bg-surface p-5 shadow-card">
          <StudentAvatar fullName={student.fullName} photoUrl={photoUrl} sizeClassName="h-24 w-24" textClassName="text-[28px]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">Student photo</h2>
            <p className="mt-1 text-[13px] text-muted">Shown on the student list and the ID card.</p>
          </div>
        </section>
      )}

      <KvCard
        title="Student"
        rows={[
          ["Status", student.status === "active" ? "Active" : "Archived"],
          ["Phone", <PhoneRow key="p" phone={student.phone} who={student.fullName} />],
          ["Email", student.email ?? <span key="e" className="text-muted">Not given</span>],
          [
            "Date of birth",
            student.dateOfBirth ? `${formatDate(student.dateOfBirth)}${dob !== null ? `, age ${dob}` : ""}` : <span key="d" className="text-muted">Not given</span>,
          ],
          ["Gender", student.gender ?? <span key="g" className="text-muted">Not specified</span>],
          ["Guardian", student.guardianName ?? <span key="gn" className="text-muted">Not given</span>],
          [
            "Guardian phone",
            <PhoneRow key="gp" phone={student.guardianPhone} who={student.guardianName ? `${student.guardianName} (guardian)` : "the guardian"} />,
          ],
          [
            "Location",
            [student.address, student.district].filter(Boolean).join(", ") || <span key="l" className="text-muted">Not given</span>,
          ],
        ]}
      />

      {plans.length > 0 && currency && (
        <StatCards
          items={[
            { label: "Total", value: formatMoney(total, currency), hint: `${plans.length} course${plans.length === 1 ? "" : "s"}`, icon: "receipt_long" },
            { label: "Paid", value: formatMoney(paid, currency), icon: "payments" },
            { label: "Remaining", value: formatMoney(remaining, currency), icon: "payments" },
            { label: "Status", value: STATUS_LABEL[overall], icon: "info" },
          ]}
        />
      )}

      <BlockTitle>
        Enrolled courses <span className="font-normal text-muted">({active.length})</span>
      </BlockTitle>
      {active.length === 0 ? (
        <div className="mb-8 flex flex-wrap items-center gap-4 rounded-card border border-[#F0CDD5] bg-brand-tint px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-surface text-brand" aria-hidden="true">
            <Icon name="user_plus" width={20} height={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink">{student.status === "archived" ? "Archived, not enrolled" : "Not enrolled in a course yet"}</div>
            <p className="mt-0.5 text-[13px] text-[#374151]">
              Enrolling picks a batch and the courses the student takes in it. Each course gets its own fee plan.
            </p>
          </div>
          {canEnroll && student.status === "active" && (
            <button type="button" onClick={onEnroll} className={HEADER_PRIMARY}>
              Enroll now
            </button>
          )}
        </div>
      ) : (
        <DataTable stackBelow={1040}>
          <thead>
            <tr>
              <th className={rtTh}>Course</th>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Schedule</th>
              <th className={rtTh}>Trainer</th>
              <th className={rtTh}>Fees paid</th>
              <th className={rtTh}>Status</th>
              {canWithdraw && (
                <th className={rtTh}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {active.map((enrollment) => {
              const entry = byEnrollment.get(enrollment.id);
              const schedule = entry?.schedule ?? null;
              const summary = entry?.summary ?? null;
              const pct = schedule && summary && schedule.amountCents > 0 ? (summary.paidCents / schedule.amountCents) * 100 : 0;
              const detail = enrollmentDetails[enrollment.id] ?? {};
              const batchStatus = BATCH_STATUS[enrollment.batchStatus];
              return (
                <tr key={enrollment.id} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Course">
                    <Link
                      href={`/academy/courses/${enrollment.courseId}`}
                      className="inline-flex min-h-11 items-center !text-brand no-underline hover:underline"
                    >
                      {enrollment.courseName}
                    </Link>
                  </td>
                  <td className={rtTd} data-label="Batch">
                    <Link
                      href={`/academy/batches/${enrollment.batchId}`}
                      className="flex min-h-11 flex-col justify-center !text-ink no-underline hover:underline"
                    >
                      <span>
                        {enrollment.batchCode} · {enrollment.branchName}
                      </span>
                      <span className="text-xs text-muted">{enrollment.batchName}</span>
                    </Link>
                  </td>
                  <td className={rtTd} data-label="Schedule">
                    {detail.schedule === null || detail.schedule === undefined ? (
                      <span className="text-muted">Not available</span>
                    ) : detail.schedule ? (
                      <span className="tabular-nums">{detail.schedule}</span>
                    ) : (
                      <span className="text-muted">Not scheduled</span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Trainer">
                    {detail.trainers === null || detail.trainers === undefined ? (
                      <span className="text-muted">Not available</span>
                    ) : detail.trainers.length > 0 ? (
                      detail.trainers.join(", ")
                    ) : (
                      <span className="text-muted">No trainer yet</span>
                    )}
                  </td>
                  <td className={`${rtTd} min-w-[160px]`} data-label="Fees paid">
                    {schedule && summary ? (
                      <FeeProgress
                        percent={pct}
                        caption={`${formatMoney(summary.paidCents, schedule.currency)} of ${formatMoney(schedule.amountCents, schedule.currency)}`}
                      />
                    ) : (
                      <span className="text-muted">Not available</span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <Badge label={batchStatus.label} tone={batchStatus.tone} />
                  </td>
                  {canWithdraw && (
                    <td className={rtTd} data-actions="">
                      <button type="button" onClick={() => setWithdrawId(enrollment.id)} className={ROW_BTN}>
                        <Icon name="autorenew" width={16} height={16} />
                        Withdraw
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {past.length > 0 && (
        <>
          <BlockTitle>
            Past courses <span className="font-normal text-muted">({past.length})</span>
          </BlockTitle>
          <DataTable stackBelow={760}>
            <thead>
              <tr>
                <th className={rtTh}>Course</th>
                <th className={rtTh}>Batch</th>
                <th className={rtTh}>Outcome</th>
                <th className={`${rtTh} text-right`}>Paid</th>
                <th className={`${rtTh} text-right`}>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {past.map((enrollment) => {
                const detail = enrollmentDetails[enrollment.id] ?? {};
                const withdrawn = enrollment.status === "withdrawn";
                const money = (cents: number | null | undefined) =>
                  cents === null || cents === undefined ? (
                    <span className="text-muted">Not available</span>
                  ) : (
                    formatMoney(cents, detail.currency ?? "USD")
                  );
                return (
                  <tr key={enrollment.id} className={trHover}>
                    <td className={rtTd} data-label="Course">
                      <span className="font-semibold text-ink">{enrollment.courseName}</span>
                      {withdrawn && detail.withdrawReason && (
                        <span className="mt-0.5 block text-xs text-muted [overflow-wrap:anywhere]">Reason: {detail.withdrawReason}</span>
                      )}
                    </td>
                    <td className={rtTd} data-label="Batch">
                      {enrollment.batchCode} · {enrollment.branchName}
                    </td>
                    <td className={rtTd} data-label="Outcome">
                      <Badge label={withdrawn ? "Withdrawn" : "Completed"} tone={withdrawn ? "amber" : "slate"} />
                      {withdrawn && detail.withdrawnAt && (
                        <span className="mt-1 block text-xs tabular-nums text-muted">on {formatDate(detail.withdrawnAt)}</span>
                      )}
                    </td>
                    <td className={`${rtTd} text-right tabular-nums`} data-label="Paid">
                      {money(detail.paidCents)}
                    </td>
                    <td className={`${rtTd} text-right tabular-nums`} data-label="Refunded">
                      {money(detail.refundedCents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </>
      )}

      {withdrawRow && (
        <WithdrawDialog
          key={withdrawRow.id}
          open={withdrawId !== null}
          onOpenChange={(open) => !open && setWithdrawId(null)}
          studentName={student.fullName}
          enrollment={withdrawRow}
          entry={byEnrollment.get(withdrawRow.id) ?? null}
          onDone={() => {
            setWithdrawId(null);
            showSuccessToast("Student withdrawn.");
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * Design A02 `withdraw` form, with the course's financial position laid
 * out before the decision: withdrawal details, a financial summary, the
 * refund decision, what happens, and a required reason.
 *
 * Course fee and outstanding come from this enrollment's fee periods; paid,
 * refunded so far and the refund cap come from the server
 * (getCourseRefundPosition): approved allocations to THIS enrollment's
 * periods only, minus refunds already recorded for it.
 *
 * Refunds (approved policy): only here, on withdrawal; Owner or Manager;
 * the academy returns the money itself and this records it. Choosing
 * "Withdraw and record refund" submits both in one server transaction
 * (withdrawStudentWithRefund), which re-checks the cap on locked rows. A
 * reversal corrects a payment entered in error; it is never a refund.
 */
type RefundChoice = "keep" | "refund";

const REFUND_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "bank_transfer", label: "Bank transfer" },
] as const;

function WithdrawDialog({
  open,
  onOpenChange,
  studentName,
  enrollment,
  entry,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentName: string;
  enrollment: StudentEnrollmentOption;
  entry: EnrollmentSummaryEntry | null;
  onDone: () => void;
}) {
  // The course's fee position from its persisted period ledger (every
  // period, upcoming included) and the server's refund position.
  const [periods, setPeriods] = useState<FeePeriodRecord[] | null | "unavailable">(null);
  const [position, setPosition] = useState<CourseRefundPosition | null | "unavailable">(null);
  const [choice, setChoice] = useState<RefundChoice>("keep");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof REFUND_METHODS)[number]["value"]>("cash");
  // One key per opening (the dialog remounts per withdrawal, keyed by the
  // enrollment): a retried submission records the refund once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // One request for both: client-called Server Actions run one at a time,
    // so two separate calls here always waited on each other.
    getWithdrawDialogDataAction(enrollment.id, Boolean(entry?.schedule)).then(({ periods: ledger, position: refund }) => {
      if (cancelled) return;
      if (ledger) setPeriods(ledger.ok ? ledger.periods : "unavailable");
      setPosition(refund.ok ? refund.position : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [open, enrollment.id, entry?.schedule]);

  const currency = entry?.schedule?.currency ?? (position && position !== "unavailable" ? position.currency : null) ?? "USD";
  const ledger = Array.isArray(periods) ? periods : null;
  const refundInfo = position && position !== "unavailable" ? position : null;
  const money = (cents: number) => formatMoney(cents, currency);
  const pending = entry?.schedule ? (periods === null ? "Loading…" : "Not available to your role") : "No fee schedule";
  const pendingRefund = position === null ? "Loading…" : "Not available to your role";
  const unpaid = ledger ? ledger.filter((period) => period.remainingCents > 0) : [];
  const outstanding = ledger ? outstandingCents(ledger) : 0;
  const fee = ledger ? ledger.reduce((sum, period) => sum + period.expectedAmountCents, 0) : 0;
  const maxRefundable = refundInfo?.refundableCents ?? 0;

  const financial: [string, string][] = [
    ["Course fee", ledger ? money(fee) : pending],
    ["Paid for this course", refundInfo ? money(refundInfo.paidCents) : pendingRefund],
    ["Refunded so far", refundInfo ? money(refundInfo.refundedCents) : pendingRefund],
    ["Kept by the academy", refundInfo ? money(refundInfo.paidCents - refundInfo.refundedCents) : pendingRefund],
    ["Outstanding before withdrawal", ledger ? money(outstanding) : pending],
    ["Unpaid fee periods", ledger ? (unpaid.length === 0 ? "None" : `${unpaid.length} (${money(outstanding)})`) : pending],
    ["Maximum refundable now", refundInfo ? money(maxRefundable) : pendingRefund],
  ];

  // Why a refund can't be recorded here, if it can't (the server enforces
  // the same; this only explains it up front).
  const refundUnavailable = !refundInfo
    ? position === null
      ? "Checking what can be refunded…"
      : "The refund position isn't available to your role."
    : !refundInfo.canRecord
      ? "Only the Academy Owner or a Manager can record a refund."
      : refundInfo.blockedReason
        ? refundInfo.blockedReason
        : maxRefundable <= 0
          ? "Nothing paid for this course is left to refund."
          : null;
  const refunding = choice === "refund" && !refundUnavailable;
  const check = refunding ? checkRefundAmount(amount, maxRefundable, money) : null;
  const refundLabel = check?.ok ? money(check.amountCents) : "the refund";

  const rules: DesignFormRule[] = [
    { name: "reason", label: "Reason", required: true },
    ...(refunding
      ? ([
          {
            name: "refundAmount",
            label: "Refund amount",
            required: true,
            check: (value: string) => {
              const result = checkRefundAmount(value, maxRefundable, money);
              return result.ok ? null : result.message;
            },
          },
          { name: "refundedAt", label: "Date returned", required: true },
          { name: "refundReason", label: "Refund reason", required: true },
          { name: "refundConfirmed", label: "Confirmation", required: true },
        ] satisfies DesignFormRule[])
      : []),
  ];

  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Withdraw from ${enrollment.courseName} in ${enrollment.batchCode}`}
      description="The student leaves this course. Its unpaid fee periods stop and the course disappears from their fees. Other courses stay."
      summary={[
        { label: "Student", value: studentName },
        { label: "Course", value: enrollment.courseName },
        { label: "Batch", value: enrollment.batchCode },
      ]}
      submitLabel={refunding ? "Withdraw and record refund" : "Withdraw without refund"}
      pendingLabel={refunding ? "Recording…" : "Withdrawing…"}
      danger
      rules={rules}
      run={async (data) => {
        if (refunding) {
          const amountCheck = checkRefundAmount(String(data.get("refundAmount") ?? ""), maxRefundable, money);
          if (!amountCheck.ok) return amountCheck.message;
          const result = await withdrawStudentWithRefundAction({
            enrollmentId: enrollment.id,
            withdrawReason: String(data.get("reason") ?? ""),
            refund: {
              amountCents: amountCheck.amountCents,
              method,
              refundedAt: String(data.get("refundedAt") ?? ""),
              reference: String(data.get("refundReference") ?? "") || undefined,
              reason: String(data.get("refundReason") ?? ""),
              idempotencyKey,
            },
          });
          return result.ok ? null : result.error.message;
        }
        data.set("enrollmentId", enrollment.id);
        data.set("batchId", enrollment.batchId);
        const result = await withdrawStudentFromBatch({ ok: false }, data);
        return result.ok ? null : (result.error?.message ?? "The student could not be withdrawn.");
      }}
      onDone={onDone}
    >
      {({ errors, blur }) => (
        <>
          <section className="col-span-full" aria-labelledby="wd-fin">
            <h3 id="wd-fin" className="mb-1.5 text-[13px] font-semibold text-ink">
              Financial summary
            </h3>
            <dl className="grid grid-cols-1 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
              {financial.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="text-[#374151]">{label}</dt>
                  <dd className="text-right font-semibold tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-xs text-muted">
              From this course&apos;s fee periods and the payments applied to them. Payments for other courses or one-off
              charges are not included.
            </p>
          </section>

          <section className="col-span-full" aria-labelledby="wd-refund">
            <h3 id="wd-refund" className="mb-1.5 text-[13px] font-semibold text-ink">
              Refund decision
            </h3>
            <div role="radiogroup" aria-labelledby="wd-refund" className="flex flex-col gap-2">
              <label
                className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${
                  choice === "keep" ? "border-brand bg-brand-tint" : "border-border-strong bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="refund"
                  value="keep"
                  checked={choice === "keep"}
                  onChange={() => setChoice("keep")}
                  className="mt-1 accent-[#850019]"
                />
                <span>
                  <span className={`block font-semibold ${choice === "keep" ? "text-brand" : "text-ink"}`}>Withdraw without refund</span>
                  <span className="block text-[13px] text-[#374151]">Every payment stays on record; nothing is returned.</span>
                </span>
              </label>
              <label
                className={`flex min-h-11 items-start gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${
                  refundUnavailable
                    ? "cursor-not-allowed border-border bg-[#FAFBFC] opacity-80"
                    : choice === "refund"
                      ? "cursor-pointer border-brand bg-brand-tint"
                      : "cursor-pointer border-border-strong bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="refund"
                  value="refund"
                  checked={refunding}
                  disabled={Boolean(refundUnavailable)}
                  onChange={() => setChoice("refund")}
                  aria-describedby="wd-refund-why"
                  className="mt-1 accent-[#850019]"
                />
                <span>
                  <span className={`block font-semibold ${refundUnavailable ? "text-[#6B7280]" : refunding ? "text-brand" : "text-ink"}`}>
                    Withdraw and record refund
                  </span>
                  <span id="wd-refund-why" className={`block text-[13px] ${refundUnavailable ? "text-[#6B7280]" : "text-[#374151]"}`}>
                    {refundUnavailable ?? `Record money the academy has already returned, up to ${money(maxRefundable)}.`}
                  </span>
                </span>
              </label>
            </div>
            <p className="mt-2 text-xs text-muted">
              Reversing a payment corrects a record entered in error; it doesn&apos;t record money returned to the student.
            </p>
          </section>

          {refunding && (
            <section className="col-span-full grid grid-cols-1 gap-4 rounded-lg border border-border p-3 sm:grid-cols-2" aria-labelledby="wd-refund-details">
              <h3 id="wd-refund-details" className="col-span-full text-[13px] font-semibold text-ink">
                Refund already returned to the student
              </h3>
              <DField label={`Refund amount (${currency})`} name="refundAmount" required error={errors.refundAmount}>
                <span className="flex gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    name="refundAmount"
                    value={amount}
                    placeholder="0.00"
                    onChange={(event) => {
                      setAmount(event.target.value);
                      // Clear (or update) a shown error while typing, so it
                      // doesn't vanish on blur and shift the method chips
                      // below out from under the next click.
                      if (errors.refundAmount) blur("refundAmount")();
                    }}
                    onBlur={blur("refundAmount")}
                    className={controlClass(Boolean(errors.refundAmount))}
                    {...invalidProps("refundAmount", errors.refundAmount)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setAmount((maxRefundable / 100).toFixed(2));
                      if (errors.refundAmount) window.setTimeout(blur("refundAmount"), 0);
                    }}
                    className="min-h-11 shrink-0 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-app"
                  >
                    Use full {money(maxRefundable)}
                  </button>
                </span>
              </DField>
              <DField label="Date returned" name="refundedAt" required error={errors.refundedAt}>
                <input
                  type="date"
                  name="refundedAt"
                  defaultValue={today}
                  max={today}
                  onBlur={blur("refundedAt")}
                  className={controlClass(Boolean(errors.refundedAt))}
                  {...invalidProps("refundedAt", errors.refundedAt)}
                />
              </DField>
              <DField label="Method" name="refundMethod" group full>
                <span role="radiogroup" aria-label="Refund method" className="flex flex-wrap gap-2">
                  {REFUND_METHODS.map((option) => (
                    <label
                      key={option.value}
                      className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app has-[:checked]:border-brand has-[:checked]:bg-brand-tint has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30"
                    >
                      <input
                        type="radio"
                        name="refundMethod"
                        value={option.value}
                        checked={method === option.value}
                        onChange={() => setMethod(option.value)}
                        className="sr-only"
                      />
                      {option.label}
                    </label>
                  ))}
                </span>
              </DField>
              <DField label="Reference (optional)" name="refundReference">
                <input type="text" name="refundReference" maxLength={200} placeholder="e.g. MM-84920" className={controlClass(false)} />
              </DField>
              <DField label="Refund reason" name="refundReason" required error={errors.refundReason}>
                <input
                  type="text"
                  name="refundReason"
                  maxLength={500}
                  placeholder="e.g. Withdrew in the first week"
                  onBlur={blur("refundReason")}
                  className={controlClass(Boolean(errors.refundReason))}
                  {...invalidProps("refundReason", errors.refundReason)}
                />
              </DField>
              <DField label="Confirmation" name="refundConfirmed" group full error={errors.refundConfirmed}>
                <label className="flex items-start gap-2.5 text-[13px] font-normal text-[#374151]">
                  <input type="checkbox" name="refundConfirmed" value="yes" className="mt-0.5 h-4 w-4 accent-[#850019]" />
                  <span>
                    I confirm {refundLabel} has already been returned to {studentName}. The system only records it; it
                    doesn&apos;t send money.
                  </span>
                </label>
              </DField>
            </section>
          )}

          <section className="col-span-full rounded-lg border border-border bg-[#FAFBFC] p-3 text-[13px] text-[#374151]" aria-labelledby="wd-what">
            <h3 id="wd-what" className="mb-1.5 font-semibold text-ink">
              What happens
            </h3>
            <ul className="list-disc space-y-1 pl-5">
              {ledger && (
                <li>
                  {unpaid.length === 0
                    ? "No fee period is unpaid."
                    : unpaid.length === 1
                      ? `1 unpaid period (${money(outstanding)}) stays in the record as history but no longer counts toward fees owed or overdue.`
                      : `${unpaid.length} unpaid periods (${money(outstanding)}) stay in the record as history but no longer count toward fees owed or overdue.`}
                </li>
              )}
              <li>Payments, receipts and their allocations stay exactly as recorded.</li>
              <li>
                {refunding
                  ? `A refund of ${refundLabel} is recorded against this course's payments. The system doesn't send money; it records what was returned.`
                  : "No refund is recorded, and no money is sent by the system."}
              </li>
              <li>The student keeps their other courses.</li>
              <li>The reason is saved with the withdrawal in the audit history.</li>
            </ul>
          </section>

          <ReasonField errors={errors} blur={blur} placeholder="Why is the student leaving this course?" />
        </>
      )}
    </ActionDialog>
  );
}

/** The design's `stats` block: four equal cards (label, icon tile, large
 * value, optional hint) on a 24px grid. Shared by Overview and Fees. */
export function StatCards({ items }: { items: { label: string; value: string; hint?: string; icon: string }[] }) {
  return (
    <div className="mb-8 grid grid-cols-1 gap-6 min-[520px]:grid-cols-2 lg:grid-cols-4">
      {items.map((card) => (
        <div key={card.label} className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#374151]">{card.label}</span>
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-tint text-brand">
              <Icon name={card.icon} width={18} height={18} />
            </span>
          </div>
          <div className="mt-3 text-[28px] font-bold leading-tight tabular-nums text-ink">{card.value}</div>
          {card.hint && <div className="mt-1 text-xs text-muted">{card.hint}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Design A02 "Manage this student": Archive (or Restore) and Delete, each
 * with what it does. Archive resubmits the student's own fields with the
 * flipped status, exactly as the Students list does. Delete is offered
 * only to roles allowed to delete, and only while the student has no
 * protected history; otherwise the reasons are shown instead.
 */
export function ManageStudentSection({
  student,
  canArchive,
  deletion,
}: {
  student: StudentRecord;
  canArchive: boolean;
  /** null when the viewer may not delete students at all. */
  deletion: { eligible: boolean; reasons: string[] } | null;
}) {
  const router = useRouter();
  if (!canArchive && !deletion) return null;
  const active = student.status === "active";

  return (
    <section className="mb-8 overflow-hidden rounded-card border border-[#F0CDD5] bg-surface shadow-card" aria-labelledby="manage-student">
      <h2 id="manage-student" className="border-b border-[#F0CDD5] bg-[#FBF5F6] px-5 py-3 text-[15px] font-semibold text-ink">
        Manage this student
      </h2>
      {canArchive && (
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-[200px] flex-1">
            <div className="font-semibold text-ink">{active ? "Archive student" : "Restore student"}</div>
            <p className="mt-0.5 text-[13px] text-muted">
              {active
                ? "Removes the student from the active list and keeps their full history. You can restore them later."
                : "Marks the student active again so they reappear in active lists and can be enrolled."}
            </p>
          </div>
          <ConfirmButton
            label={active ? "Archive" : "Restore"}
            variant={active ? "secondary" : "success"}
            icon={active ? "archive" : "autorenew"}
            title={active ? `Archive ${student.fullName}?` : `Restore ${student.fullName}?`}
            description={
              active
                ? "Archived students are hidden from active rosters and enrollment. Their record and history (results, payments, certificates) are kept."
                : "This student will be marked active again and reappear in active rosters."
            }
            successMessage={active ? "Student archived." : "Student restored."}
            onConfirm={() =>
              updateStudentStatus(student.id, {
                fullName: student.fullName,
                dateOfBirth: student.dateOfBirth ?? "",
                gender: student.gender ?? "",
                phone: student.phone ?? "",
                email: student.email ?? "",
                guardianName: student.guardianName ?? "",
                guardianPhone: student.guardianPhone ?? "",
                status: active ? "archived" : "active",
              })
            }
            onSuccess={() => router.refresh()}
          />
        </div>
      )}
      {deletion && (
        <div className={`flex flex-wrap items-center gap-4 px-5 py-4 ${canArchive ? "border-t border-border" : ""}`}>
          <div className="min-w-[200px] flex-1">
            <div className="font-semibold text-ink">Delete student</div>
            <p className="mt-0.5 text-[13px] text-muted">
              {deletion.eligible
                ? "Permanently removes this student. This cannot be undone."
                : `This student has ${deletion.reasons.join("; ")}, so they can be archived but not deleted.`}
            </p>
          </div>
          {deletion.eligible ? (
            <ConfirmButton
              label="Delete student"
              variant="dangerSolid"
              title={`Delete "${student.fullName}" permanently?`}
              description="This cannot be undone."
              confirmInput={{ label: `Type "${student.fullName}" to confirm`, requiredValue: student.fullName }}
              successMessage="Student deleted."
              onConfirm={() => deleteStudent(student.id, student.fullName)}
              onSuccess={() => router.push("/academy/students")}
            />
          ) : (
            <button
              type="button"
              disabled
              className="min-h-11 cursor-not-allowed rounded-lg border border-[#F0B6C1] bg-surface px-4 text-sm font-semibold text-[#B4475B] opacity-70"
            >
              Delete student
            </button>
          )}
        </div>
      )}
    </section>
  );
}
