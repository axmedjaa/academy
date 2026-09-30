"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteStudent,
  updateStudent,
  updateStudentStatus,
  type StudentFormState,
} from "@/lib/academies/students-actions";
import {
  updateStudentEnrollment,
  type BatchAssignmentFormState,
} from "@/lib/academies/batch-assignments-actions";
import type { StudentDeletionEligibilitySummary, StudentRecord } from "@/lib/academies/students";
import type { StudentActiveCourse } from "@/lib/academies/batch-assignments";
import type { FeePeriodRecord, StudentPaymentSummaryRow } from "@/lib/academies/fee-periods";
import { recordFeePeriodPaymentAction } from "@/lib/academies/fee-periods-actions";
import {
  Badge,
  Button,
  EmptyState,
  ErrorMessage,
  Field,
  LinkButton,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getStatusTone } from "@/lib/ui/status";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { centsToDollars, dollarsToCents } from "@/lib/ui/money";
import Link from "next/link";

/** Mirrors lib/academies/fee-periods.ts's INTERVAL_OPTIONS-shaped labels —
 * used to render the "Payment Plan" column ("Monthly — $50.00 / period"). */
const INTERVAL_LABELS: Record<number, string> = {
  1: "Monthly",
  2: "Every 2 Months",
  3: "Every 3 Months",
  4: "Every 4 Months",
  6: "Every 6 Months",
  12: "Yearly",
};

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

/** First + last initial, e.g. "Jane Doe" -> "JD" — same avatar-style
 * identity cue as app/academy/staff/staff-table.tsx's row identity cell, for
 * a consistent "people list" visual language across the app. Purely
 * cosmetic; the actual identity is still `fullName`/`studentNumber`. */
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const initialState: StudentFormState = { ok: false };
const initialEnrollmentState: BatchAssignmentFormState = { ok: false };

/** Mirrors lib/db/schema.ts's FEE_INTERVAL_MONTHS_OPTIONS — same list as
 * app/academy/batches/[batchId]/roster-panel.tsx's enroll form and
 * app/academy/students/new/student-form.tsx's registration-time form. */
const PAYMENT_PLAN_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monthly" },
  { value: 2, label: "Every 2 Months" },
  { value: 3, label: "Every 3 Months" },
  { value: 4, label: "Every 4 Months" },
  { value: 6, label: "Every 6 Months" },
  { value: 12, label: "Yearly" },
];

interface CourseOption {
  batchId: string;
  label: string;
}

interface Props {
  students: (StudentRecord & { deletionEligibility: StudentDeletionEligibilitySummary })[];
  /** Only "full"/"manage" callers (Owner, Admin, Manager, Admissions
   * Officer) get edit controls — "view" (Finance Officer, Trainer) is
   * read-only, per the Master Permission Matrix's Full/Full/Manage/
   * Manage/View/"View assigned" split. */
  canManage: boolean;
  /** Narrower than `canManage` — Admissions Officer can archive students in
   * their own assigned branch but must never see a Delete action at all
   * (permission-absent, not disabled — see students.ts's canDeleteStudent). */
  canDelete: boolean;
  /** Independent of `canManage` (that's ACADEMY_STUDENTS_ACTION's edit
   * gate) — ACADEMY_FEE_PERIODS_ACTION's own "manage" gate, the exact same
   * permission recordFeePeriodPayment itself requires (see
   * app/academy/students/page.tsx's own computation). Gates ONLY the
   * Record Payment action — a role with `canManage` but not
   * `canManagePayments` (e.g. Admissions Officer) still gets Edit/Archive/
   * Delete but never sees Record Payment; a role with `canManagePayments`
   * but not `canManage` (e.g. Finance Officer) gets the opposite. */
  canManagePayments: boolean;
  /** False for branch-limited callers (Admissions Officer) — see
   * lib/academies/students.ts's updateStudent branchId judgment call: a
   * branch-limited caller must never submit a `branchId` field at all, so
   * the edit form omits the control entirely rather than disabling it. */
  showBranchField: boolean;
  /** Each student's currently active course(s), for the "Course" column —
   * see lib/academies/batch-assignments.ts's getActiveCoursesForStudents. */
  coursesByStudent: Map<string, StudentActiveCourse[]>;
  /** Each student's derived payment plan/expected/paid/remaining/status,
   * batched (never N+1) — see lib/academies/fee-periods.ts's
   * getStudentPaymentSummaries. A student absent from this map has no
   * active enrollment (or no fee schedule set yet) and shows "—" in every
   * payment column instead of a false UNPAID reading. */
  paymentSummaries: Map<string, StudentPaymentSummaryRow>;
  /** Every non-archived batch, labeled with its course name, for the
   * "change course" select — same shape as the registration form's course
   * picker (app/academy/students/new/student-form.tsx). */
  courseOptions: CourseOption[];
}

export function StudentsList({
  students,
  canManage,
  canDelete,
  canManagePayments,
  showBranchField,
  coursesByStudent,
  paymentSummaries,
  courseOptions,
}: Props) {
  const router = useRouter();
  const [updateState, updateFormAction, updating] = useActionState(updateStudent, initialState);
  const [enrollmentState, enrollmentFormAction, updatingEnrollment] = useActionState(
    updateStudentEnrollment,
    initialEnrollmentState,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/staff/staff-table.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  // Which row's Record Payment dialog is open — same controlled-dialog-
  // outside-the-dropdown pattern as archive/delete above.
  const [paymentRowId, setPaymentRowId] = useState<string | null>(null);

  const editingStudent = students.find((student) => student.id === editingId) ?? null;
  const editingStudentCourses = editingStudent ? (coursesByStudent.get(editingStudent.id) ?? []) : [];
  const currentCourseBatchId = editingStudentCourses[0]?.batchId ?? "";

  const [selectedBatchId, setSelectedBatchId] = useState(currentCourseBatchId);
  // Adjust state during render (see fee-periods-manager.tsx's identical
  // pattern) — resets the course selection whenever a different student's
  // row is opened for editing, without an effect.
  const [prevEditingId, setPrevEditingId] = useState(editingId);
  if (editingId !== prevEditingId) {
    setPrevEditingId(editingId);
    setSelectedBatchId(currentCourseBatchId);
  }
  const changingCourse = selectedBatchId !== "" && selectedBatchId !== currentCourseBatchId;

  /** Resubmits the row's own current field values alongside the flipped
   * `status` — see students-actions.ts's updateStudentStatus doc comment
   * for why (updateStudent does a full overwrite, not a partial merge).
   * Never includes `branchId`, so a branch-limited caller's own scoping
   * stays untouched regardless of who clicks this. */
  function toggleStudentStatus(student: StudentRecord) {
    const nextStatus: "active" | "archived" = student.status === "active" ? "archived" : "active";
    return updateStudentStatus(student.id, {
      fullName: student.fullName,
      dateOfBirth: student.dateOfBirth ?? "",
      gender: student.gender ?? "",
      phone: student.phone ?? "",
      email: student.email ?? "",
      guardianName: student.guardianName ?? "",
      guardianPhone: student.guardianPhone ?? "",
      status: nextStatus,
    });
  }

  return (
    <section className="flex flex-col gap-6">
      {students.length === 0 ? (
        <Section>
          <EmptyState
            message="No students match your search or filters. Try broadening them, or register a new student."
            icon={<Icon name="group" />}
            action={canManage ? <LinkButton href="/academy/students/new">Register student</LinkButton> : undefined}
          />
        </Section>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Student</th>
              <th className={th}>Status</th>
              <th className={`${th} hidden md:table-cell`}>Course / Batch</th>
              <th className={`${th} hidden xl:table-cell`}>Payment Plan</th>
              <th className={`${th} hidden xl:table-cell text-right`}>Expected</th>
              <th className={`${th} hidden lg:table-cell text-right`}>Paid</th>
              <th className={`${th} text-right`}>Remaining</th>
              <th className={th}>Payment Status</th>
              <th className={`${th} hidden xl:table-cell`}>Phone</th>
              <th className={`${th} hidden xl:table-cell`}>Email</th>
              <th className={`${th} hidden xl:table-cell`}>Guardian</th>
              {(canManage || canManagePayments) && <th className={`${th} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {students.map((student) => {
              const summary = paymentSummaries.get(student.id);
              const courses = coursesByStudent.get(student.id) ?? [];
              return (
                <tr key={student.id} className={trHover}>
                  <td className={td}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">
                        {getInitials(student.fullName)}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/academy/students/${student.id}`}
                          className="block truncate font-medium text-ink hover:text-brand hover:underline"
                        >
                          {student.fullName}
                        </Link>
                        <span className="block text-xs text-muted">{student.studentNumber}</span>
                      </div>
                    </div>
                  </td>
                  <td className={td}>
                    <Badge label={student.status} tone={student.status === "active" ? "green" : "gray"} />
                  </td>
                  <td className={`${td} hidden md:table-cell`}>
                    {courses.length > 0
                      ? courses.map((c) => `${c.courseName} — ${c.batchName}`).join(", ")
                      : "—"}
                  </td>
                  <td className={`${td} hidden xl:table-cell text-muted`}>
                    {summary
                      ? `${INTERVAL_LABELS[summary.intervalMonths] ?? `Every ${summary.intervalMonths} mo.`} — ${formatMoney(summary.scheduleAmountCents, summary.currency)}`
                      : "—"}
                  </td>
                  <td className={`${td} hidden xl:table-cell text-right tabular-nums`}>
                    {summary ? formatMoney(summary.expectedCents, summary.currency) : "—"}
                  </td>
                  <td className={`${td} hidden lg:table-cell text-right tabular-nums`}>
                    {summary ? formatMoney(summary.paidCents, summary.currency) : "—"}
                  </td>
                  <td className={`${td} text-right font-medium tabular-nums`}>
                    {summary ? formatMoney(summary.remainingCents, summary.currency) : "—"}
                  </td>
                  <td className={td}>
                    {summary ? (
                      <Badge label={summary.status.replace("_", " ")} tone={getStatusTone(summary.status)} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={`${td} hidden xl:table-cell text-muted`}>{student.phone ?? "—"}</td>
                  <td className={`${td} hidden xl:table-cell text-muted`}>{student.email ?? "—"}</td>
                  <td className={`${td} hidden xl:table-cell text-muted`}>{student.guardianName ?? "—"}</td>
                  {(canManage || canManagePayments) && (
                    <td className={`${td} text-right`}>
                      {/* Record Payment targets summary.nextOutstandingPeriod
                          — the oldest period, among the same "relevant"
                          window the Expected/Paid/Remaining/Payment Status
                          columns above are themselves derived from, that
                          still has remainingCents > 0. `null` there means
                          "nothing currently outstanding" (including the
                          "only a future period exists" case — see that
                          field's own doc comment in fee-periods.ts), so no
                          payment action is offered at all — never merely
                          disabled, there is simply nothing to render. */}
                      {canManage || (canManagePayments && summary?.nextOutstandingPeriod) ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Actions for ${student.fullName}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                            >
                              <Icon name="more" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canManagePayments && summary?.nextOutstandingPeriod && (
                              <>
                                <DropdownMenuItem onClick={() => setPaymentRowId(student.id)}>
                                  Record Payment
                                </DropdownMenuItem>
                                {canManage && <DropdownMenuSeparator />}
                              </>
                            )}
                            {canManage && (
                              <>
                                <DropdownMenuItem onClick={() => setEditingId(student.id)}>Edit</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setArchiveRowId(student.id)}>
                                  {student.status === "active" ? "Archive" : "Restore"}
                                </DropdownMenuItem>
                                {canDelete && (
                                  <>
                                    <DropdownMenuSeparator />
                                    {student.deletionEligibility.eligible ? (
                                      <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(student.id)}>
                                        Delete
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem
                                        disabled
                                        title={`This student cannot be permanently deleted because ${student.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                                      >
                                        Delete
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-muted">—</span>
                      )}

                      {canManage && (
                        <>
                          <ConfirmButton
                            label={student.status === "active" ? "Archive" : "Restore"}
                            variant={student.status === "active" ? "danger" : "secondary"}
                            open={archiveRowId === student.id}
                            onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? student.id : null)}
                            title={
                              student.status === "active"
                                ? `Archive ${student.fullName}?`
                                : `Restore ${student.fullName}?`
                            }
                            description={
                              student.status === "active" ? (
                                <>
                                  Archived students are hidden from active rosters and enrollment, but their
                                  record and history (results, payments, certificates) are kept and can be
                                  restored at any time.
                                </>
                              ) : (
                                <>This student will be marked active again and reappear in active rosters.</>
                              )
                            }
                            onConfirm={() => toggleStudentStatus(student)}
                          />
                          {canDelete && student.deletionEligibility.eligible && (
                            <ConfirmButton
                              label="Delete"
                              variant="dangerSolid"
                              open={deleteRowId === student.id}
                              onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? student.id : null)}
                              title={`Delete "${student.fullName}" permanently?`}
                              description={<>This cannot be undone.</>}
                              confirmInput={{ label: `Type "${student.fullName}" to confirm`, requiredValue: student.fullName }}
                              onConfirm={() => deleteStudent(student.id, student.fullName)}
                            />
                          )}
                        </>
                      )}

                      {canManagePayments && summary?.nextOutstandingPeriod && (
                        <RecordPaymentDialog
                          open={paymentRowId === student.id}
                          onOpenChange={(nextOpen) => setPaymentRowId(nextOpen ? student.id : null)}
                          studentId={student.id}
                          studentName={student.fullName}
                          period={summary.nextOutstandingPeriod}
                          onRecorded={() => {
                            setPaymentRowId(null);
                            router.refresh();
                          }}
                        />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      {canManage && editingStudent && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Edit student — {editingStudent.fullName}</h2>
          <form action={updateFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <input type="hidden" name="studentId" value={editingStudent.id} />
            {showBranchField && (
              <Field label="Branch ID">
                <input type="text" name="branchId" defaultValue={editingStudent.branchId} className={inputClass} />
              </Field>
            )}
            <Field label="Full name">
              <input type="text" name="fullName" defaultValue={editingStudent.fullName} required className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Date of birth">
                <input type="date" name="dateOfBirth" defaultValue={editingStudent.dateOfBirth ?? ""} className={inputClass} />
              </Field>
              <Field label="Gender">
                <input type="text" name="gender" defaultValue={editingStudent.gender ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Phone">
                <input type="text" name="phone" defaultValue={editingStudent.phone ?? ""} className={inputClass} />
              </Field>
              <Field label="Email">
                <input type="email" name="email" defaultValue={editingStudent.email ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Guardian name">
                <input type="text" name="guardianName" defaultValue={editingStudent.guardianName ?? ""} className={inputClass} />
              </Field>
              <Field label="Guardian phone">
                <input type="text" name="guardianPhone" defaultValue={editingStudent.guardianPhone ?? ""} className={inputClass} />
              </Field>
            </div>
            <Field label="Status">
              <select name="status" defaultValue={editingStudent.status} className={inputClass}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            {updateState.error && <ErrorMessage message={updateState.error.message} />}
            {updateState.ok && <p className="text-sm font-medium text-success">Student updated.</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={updating}>
                {updating ? "Saving..." : "Save changes"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </form>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-ink">Course</h3>
            <p className="mt-1 text-sm text-muted">
              Current: {editingStudentCourses.map((c) => c.courseName).join(", ") || "No course selected"}
            </p>
            <form action={enrollmentFormAction} className="mt-3 flex max-w-lg flex-wrap items-end gap-3">
              <input type="hidden" name="studentId" value={editingStudent.id} />
              <Field label="Change course" className="min-w-[220px] flex-1">
                <select
                  name="batchId"
                  value={selectedBatchId}
                  onChange={(event) => setSelectedBatchId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">No course</option>
                  {courseOptions.map((option) => (
                    <option key={option.batchId} value={option.batchId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              {changingCourse && (
                <>
                  <Field label="Payment Plan">
                    <select name="paymentPlanIntervalMonths" required defaultValue="1" className={inputClass}>
                      {PAYMENT_PLAN_INTERVAL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount per period (USD)">
                    <input type="number" name="paymentPlanAmountDollars" min={0.01} step="0.01" placeholder="0.00" required className={inputClass} />
                  </Field>
                </>
              )}
              <Button type="submit" variant="secondary" disabled={updatingEnrollment}>
                {updatingEnrollment ? "Saving..." : "Save course"}
              </Button>
            </form>
            {enrollmentState.error && <div className="mt-2"><ErrorMessage message={enrollmentState.error.message} /></div>}
            {enrollmentState.ok && <p className="mt-2 text-sm font-medium text-success">Course updated.</p>}
          </div>
        </Section>
      )}
    </section>
  );
}

/**
 * The Students-list "quick payment" modal — records a payment against
 * exactly ONE fee period (`period`, always the caller-supplied
 * `summary.nextOutstandingPeriod`: the oldest-outstanding period within the
 * same "relevant" window the row's Expected/Paid/Remaining/Payment Status
 * columns are themselves derived from — see fee-periods.ts's own doc
 * comment on that field). This is NOT a second payment implementation: it
 * calls the exact same `recordFeePeriodPaymentAction` — and, through it,
 * the exact same `recordFeePeriodPayment` — that
 * app/academy/finance/fee-periods/fee-periods-manager.tsx's and
 * app/academy/students/[id]/student-detail.tsx's own per-period
 * `PeriodPaymentForm`s already use, with the identical single-allocation
 * shape (`allocations: [{ feePeriodId: period.id, amountCents }]`). Every
 * server-side guarantee those two already have — tenant/enrollment/period
 * ownership checks, the row-locked live remaining-balance re-check, the
 * "no allocation may exceed what's actually still outstanding" refusal —
 * applies here unchanged, because it's the same function.
 */
function RecordPaymentDialog({
  open,
  onOpenChange,
  studentId,
  studentName,
  period,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentId: string;
  studentName: string;
  period: FeePeriodRecord;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(() => centsToDollars(period.remainingCents));
  const [method, setMethod] = useState<"cash" | "mobile_money" | "bank_transfer">("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form to this period's own current values every time the
  // dialog is (re)opened for a (possibly different) row — "adjust state
  // during render" (see this file's identical pattern above for
  // editingId/selectedBatchId), not an effect: purely derived from props.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setAmount(centsToDollars(period.remainingCents));
      setMethod("cash");
      setReference("");
      setNotes("");
      setReceivedAt(new Date().toISOString().slice(0, 16));
      setError(null);
    }
  }

  async function handleSubmit() {
    setError(null);
    const amountCents = dollarsToCents(amount);
    if (amountCents === null || amountCents <= 0) {
      setError("Enter a valid amount paid.");
      return;
    }
    // Do not allow the amount to silently exceed this period's remaining
    // balance — same client-side check as the Fee Periods/Student Detail
    // per-period forms; the server independently refuses it too.
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
    onRecorded();
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Record Payment — {studentName}</AlertDialogTitle>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-control border border-border bg-app p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">
                {period.periodStart} – {period.periodEnd}
              </span>
              <Badge label={period.status.replace("_", " ")} tone={getStatusTone(period.status)} />
            </div>
            {/* period.intervalMonths/expectedAmountCents are copied onto the
                period row at generation time (see feePeriods' own schema
                comment) — showing THIS period's own plan rather than
                re-reading the enrollment's current schedule, so the figure
                stays accurate even if the schedule was edited afterward. */}
            <p className="mt-1 text-xs text-muted">
              Payment plan: {INTERVAL_LABELS[period.intervalMonths] ?? `Every ${period.intervalMonths} mo.`} —{" "}
              {formatMoney(period.expectedAmountCents, period.currency)} / period
            </p>
            {period.status === "overdue" && (
              <p className="mt-1 text-xs text-danger">Overdue since {period.dueDate}.</p>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-muted">Expected</p>
                <p className="font-medium text-ink">{formatMoney(period.expectedAmountCents, period.currency)}</p>
              </div>
              <div>
                <p className="text-muted">Paid</p>
                <p className="font-medium text-ink">{formatMoney(period.paidCents, period.currency)}</p>
              </div>
              <div>
                <p className="text-muted">Remaining</p>
                <p className="font-medium text-ink">{formatMoney(period.remainingCents, period.currency)}</p>
              </div>
            </div>
          </div>

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
              <input
                type="datetime-local"
                className={inputClass}
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
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
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button type="button" variant="ghost" disabled={submitting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button type="button" disabled={submitting} onClick={handleSubmit}>
            {submitting ? "Recording..." : "Record Payment"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
