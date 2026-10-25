"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StudentRecord } from "@/lib/academies/students";
import type { EnrollmentFeeScheduleRecord, EnrollmentPaymentSummary, StudentEnrollmentOption } from "@/lib/academies/fee-periods";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { updateStudent, type StudentFormState } from "@/lib/academies/students-actions";
import { withdrawStudentFromBatch, type BatchAssignmentFormState } from "@/lib/academies/batch-assignments-actions";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, FeeProgress, KvCard, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChatActions } from "@/app/academy/_shell/chat-actions";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { Icon } from "@/app/academy/_shell/icons";
import { EnrollCoursesDialog } from "@/app/academy/_shell/enroll-courses-dialog";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  PhoneField,
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
const guardedWithdraw = guardAction(withdrawStudentFromBatch);

/**
 * Student detail, Overview (design A02 detail): header actions, the photo
 * block, the Student key-value card (phones with WhatsApp / Telegram),
 * fee totals across active enrollments, and the student's enrollments: one
 * row per course, current and past. A student can take several courses in
 * one or more batches; Enroll adds courses, Withdraw ends one enrollment
 * and leaves the others untouched. Every action is an existing server
 * action that re-checks permission and scope.
 */

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

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  overdue: "Overdue",
  partially_paid: "Partly paid",
  unpaid: "Unpaid",
};

export function StudentOverview({
  student,
  photoUrl,
  branchName,
  enrollments,
  enrollmentSummaries,
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
  canEditPhoto: boolean;
  canWithdraw: boolean;
  canEnroll: boolean;
  onEnroll: () => void;
}) {
  const router = useRouter();
  const [withdrawState, withdrawAction, withdrawing] = useActionState(guardedWithdraw, { ok: false } as BatchAssignmentFormState);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  useEffect(() => {
    if (withdrawState.ok) {
      showSuccessToast("Withdrawn from the course.");
      router.refresh();
    } else if (withdrawState.error) showErrorToast(withdrawState.error.message);
  }, [withdrawState, router]);

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
      <section className="mb-8 flex flex-wrap items-center gap-5 rounded-card border border-border bg-surface p-5 shadow-card">
        {canEditPhoto ? (
          <div className="min-w-0 flex-1">
            <h2 className="mb-1 text-base font-semibold text-ink">Student photo</h2>
            <p className="mb-3 text-[13px] text-muted">Shown on the student list and the ID card.</p>
            <StudentPhotoField mode="edit" studentId={student.id} currentPhotoUrl={photoUrl} onChanged={() => router.refresh()} />
          </div>
        ) : (
          <>
            <StudentAvatar fullName={student.fullName} photoUrl={photoUrl} sizeClassName="h-24 w-24" textClassName="text-[28px]" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-ink">Student photo</h2>
              <p className="mt-1 text-[13px] text-muted">Shown on the student list and the ID card.</p>
            </div>
          </>
        )}
      </section>

      <KvCard
        title="Student"
        rows={[
          ["Status", <Badge key="s" label={student.status} tone={student.status === "active" ? "green" : "gray"} />],
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
          ["Address", student.address ?? <span key="a" className="text-muted">Not given</span>],
          ["District", student.district ?? <span key="di" className="text-muted">Not given</span>],
          ["Branch", branchName],
        ]}
      />

      {plans.length > 0 && currency && (
        <div className="mb-8 grid grid-cols-1 gap-6 min-[520px]:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Total", value: formatMoney(total, currency), hint: `${plans.length} course${plans.length === 1 ? "" : "s"}`, icon: "receipt_long" },
            { label: "Paid", value: formatMoney(paid, currency), hint: "", icon: "payments" },
            { label: "Remaining", value: formatMoney(remaining, currency), hint: "", icon: "payments" },
            { label: "Status", value: STATUS_LABEL[overall], hint: "", icon: "info" },
          ].map((card) => (
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
      )}

      <BlockTitle>
        Enrolled courses <span className="font-normal text-muted">({active.length})</span>
      </BlockTitle>
      {active.length === 0 ? (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-card border border-[#F0CDD5] bg-brand-tint px-5 py-4">
          <div>
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
              <th className={rtTh}>Enrolled</th>
              <th className={rtTh}>Fee plan</th>
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
                      <span>{enrollment.batchCode}</span>
                      <span className="text-xs text-muted">{enrollment.batchName}</span>
                    </Link>
                  </td>
                  <td className={`${rtTd} tabular-nums`} data-label="Enrolled">
                    {formatDate(enrollment.enrolledAt)}
                  </td>
                  <td className={rtTd} data-label="Fee plan">
                    {schedule ? (
                      describePaymentPlan(schedule.amountCents, schedule.intervalMonths, schedule.currency)
                    ) : (
                      <span className="text-muted">{entry ? "No fee plan" : "Not visible to you"}</span>
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
                    {summary ? (
                      <Badge label={STATUS_LABEL[summary.status]} tone={summary.status === "paid" ? "green" : summary.status === "overdue" ? "red" : "amber"} />
                    ) : (
                      <Badge label="Active" tone="green" />
                    )}
                  </td>
                  {canWithdraw && (
                    <td className={rtTd} data-actions="">
                      <button type="button" disabled={withdrawing} onClick={() => setWithdrawId(enrollment.id)} className={ROW_BTN}>
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
          <BlockTitle>Past courses</BlockTitle>
          <DataTable stackBelow={600}>
            <thead>
              <tr>
                <th className={rtTh}>Course</th>
                <th className={rtTh}>Batch</th>
                <th className={rtTh}>Enrolled</th>
                <th className={rtTh}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {past.map((enrollment) => (
                <tr key={enrollment.id} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Course">
                    {enrollment.courseName}
                  </td>
                  <td className={rtTd} data-label="Batch">
                    {enrollment.batchCode} · {enrollment.batchName}
                  </td>
                  <td className={`${rtTd} tabular-nums`} data-label="Enrolled">
                    {formatDate(enrollment.enrolledAt)}
                  </td>
                  <td className={rtTd} data-label="Outcome">
                    <Badge label={enrollment.status === "completed" ? "Completed" : "Withdrawn"} tone={enrollment.status === "completed" ? "slate" : "gray"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      {withdrawRow && (
        <ConfirmButton
          label="Withdraw"
          variant="danger"
          icon="autorenew"
          open={withdrawId !== null}
          onOpenChange={(open) => !open && setWithdrawId(null)}
          title={`Withdraw from ${withdrawRow.courseName}?`}
          description={
            <>
              {student.fullName} leaves {withdrawRow.courseName} in {withdrawRow.batchCode}. Their other courses, payments and
              history are kept.
            </>
          }
          successMessage={false}
          onConfirm={async () => {
            const data = new FormData();
            data.set("enrollmentId", withdrawRow.id);
            data.set("batchId", withdrawRow.batchId);
            startTransition(() => withdrawAction(data));
            return { ok: true };
          }}
        />
      )}
    </>
  );
}
