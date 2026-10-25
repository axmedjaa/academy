"use client";

import { startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { updateStudentEnrollment, type BatchAssignmentFormState } from "@/lib/academies/batch-assignments-actions";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { formatDate } from "@/lib/ui/date";
import { PAYMENT_PLAN_OPTIONS, describePaymentPlan, parseDollarsToCents } from "@/lib/ui/payment-plan";
import { showSuccessToast } from "@/lib/ui/toast";
import {
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
} from "./design-form";
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedEnroll = guardAction(updateStudentEnrollment);

/**
 * Enroll in courses (design A02/A03/A08 form `enroll`): pick the student
 * (when not fixed), a batch from cards, then one or more of that batch's
 * courses, the payment plan and the total fee per course. Each chosen
 * course becomes its own enrollment with its own fee schedule, in one
 * transaction (`updateStudentEnrollment` -> `enrollStudentInBatch`). It
 * only adds: the student's other enrollments are untouched. Courses the
 * student already takes in a batch are shown as enrolled and can't be
 * picked again; the server rejects duplicates regardless.
 */

const initialState: BatchAssignmentFormState = { ok: false };

export interface EnrollStudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
}

const pairKey = (batchId: string, courseId: string) => `${batchId}:${courseId}`;

function EnrollFields({
  student,
  students,
  batches,
  lockedBatchId,
  enrolledPairs,
  studentsNote,
  onCancel,
  onSaved,
}: {
  student: EnrollStudentOption | null;
  studentsNote?: string;
  students: EnrollStudentOption[];
  batches: EnrollBatchOption[];
  lockedBatchId?: string;
  enrolledPairs: Record<string, string[]>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedEnroll, initialState);
  const [studentId, setStudentId] = useState(student?.id ?? "");
  const [query, setQuery] = useState("");
  const [batchId, setBatchId] = useState(lockedBatchId ?? (batches.length === 1 ? batches[0].id : ""));
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [plan, setPlan] = useState(1);
  const [amount, setAmount] = useState("");

  const rules = useMemo<DesignFormRule[]>(
    () => [
      ...(student ? [] : [{ name: "studentId", label: "Student", required: true, kind: "select" as const }]),
      { name: "batchId", label: "Batch", required: true, kind: "select" },
      {
        name: "courseIds",
        label: "Courses",
        check: (_value, data) => (data.getAll("courseIds").length === 0 ? "Pick at least one course." : null),
      },
      {
        name: "paymentPlanAmountDollars",
        label: "Total fee per course (USD)",
        required: true,
        check: (value) => {
          const cents = parseDollarsToCents(value);
          return cents === null || cents <= 0 ? "Enter the fee for each course, for example 180 or 180.00." : null;
        },
      },
    ],
    [student],
  );
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(rules);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(courseIds.length > 1 ? `Enrolled in ${courseIds.length} courses.` : "Student enrolled.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/fee|amount|payment/i, "paymentPlanAmountDollars"],
        [/course/i, "courseIds"],
        [/batch/i, "batchId"],
        [/student/i, student ? "courseIds" : "studentId"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const taken = new Set(enrolledPairs[studentId] ?? []);
  const batch = batches.find((b) => b.id === batchId) ?? null;
  const needle = query.trim().toLowerCase();
  // On a batch page, only students who can still join it are listed: those
  // with at least one of its courses they don't already take.
  const lockedBatch = lockedBatchId ? (batches.find((b) => b.id === lockedBatchId) ?? null) : null;
  const eligibleStudents = lockedBatch
    ? students.filter((s) => lockedBatch.courses.some((c) => !(enrolledPairs[s.id] ?? []).includes(pairKey(lockedBatch.id, c.id))))
    : students;
  const visibleStudents = needle
    ? eligibleStudents.filter((s) => s.fullName.toLowerCase().includes(needle) || s.studentNumber.toLowerCase().includes(needle))
    : eligibleStudents;
  const chosenStudent = student ?? students.find((s) => s.id === studentId) ?? null;
  const cents = parseDollarsToCents(amount);
  const courseNames = batch ? batch.courses.filter((c) => courseIds.includes(c.id)).map((c) => c.name) : [];

  function pickBatch(id: string) {
    setBatchId(id);
    // Preselect the only course a batch runs, unless already taken.
    const next = batches.find((b) => b.id === id);
    const open = next ? next.courses.filter((c) => !taken.has(pairKey(id, c.id))) : [];
    setCourseIds(open.length === 1 ? [open[0].id] : []);
    window.setTimeout(blur("batchId"), 0);
  }

  function toggleCourse(id: string) {
    setCourseIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    window.setTimeout(blur("courseIds"), 0);
  }

  const visibleBatches = lockedBatchId ? batches.filter((b) => b.id === lockedBatchId) : batches;

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      {student && <input type="hidden" name="studentId" value={student.id} />}
      <input type="hidden" name="batchId" value={batchId} />
      {courseIds.map((id) => (
        <input key={id} type="hidden" name="courseIds" value={id} />
      ))}
      <DialogBody>
        <FormSummary
          items={[
            { label: "Student", value: chosenStudent ? chosenStudent.fullName : "Not chosen" },
            { label: "Batch", value: batch ? batch.code : "Not chosen" },
            { label: "Courses", value: courseNames.length ? courseNames.join(", ") : "None selected" },
            {
              label: "Fee for each course",
              value: cents && cents > 0 ? describePaymentPlan(cents, plan, "USD") : "Not entered",
            },
          ]}
        />
        <FieldGrid fill>
          {!student && (
            <DField label="Student" name="studentId" required error={errors.studentId} full={!lockedBatchId} hint={studentsNote}>
              {eligibleStudents.length > 8 && (
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name or student number"
                  aria-label="Search students"
                  className={`${controlClass(false)} mb-2`}
                />
              )}
              <select
                name="studentId"
                value={studentId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setStudentId(nextId);
                  // A batch with one open course for this student needs no choice.
                  const takenNext = new Set(enrolledPairs[nextId] ?? []);
                  const open = batch ? batch.courses.filter((c) => !takenNext.has(pairKey(batch.id, c.id))) : [];
                  setCourseIds(open.length === 1 ? [open[0].id] : []);
                }}
                onBlur={blur("studentId")}
                className={controlClass(Boolean(errors.studentId))}
                {...invalidProps("studentId", errors.studentId)}
              >
                <option value="">
                  {eligibleStudents.length === 0
                    ? lockedBatch
                      ? "Every listed student already takes all of this batch's courses"
                      : "No student to enroll"
                    : visibleStudents.length === 0
                      ? "No student matches"
                      : "Choose a student"}
                </option>
                {visibleStudents.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.studentNumber})
                  </option>
                ))}
              </select>
            </DField>
          )}

          <div className={`${lockedBatchId ? "" : "col-span-full "}flex min-w-0 flex-col gap-1.5`}>
            <span id="enroll-batch-label" className="text-[13px] font-semibold text-ink">
              {lockedBatchId ? "Batch (from this page)" : "Batch"}
              <span aria-hidden="true" className="text-[#B91C1C]">
                {" "}
                *
              </span>
            </span>
            {visibleBatches.length === 0 ? (
              <span className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-[13px] text-muted">
                No planned or active batch to enroll in yet.
              </span>
            ) : (
              <div
                role="radiogroup"
                aria-labelledby="enroll-batch-label"
                aria-describedby={errors.batchId ? "fe-batchId" : undefined}
                className="flex max-h-56 flex-col gap-2 overflow-y-auto p-0.5"
              >
                {visibleBatches.map((option) => {
                  const on = option.id === batchId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-invalid={errors.batchId && !batchId ? true : undefined}
                      disabled={Boolean(lockedBatchId)}
                      onClick={() => pickBatch(option.id)}
                      className={`flex items-start justify-between gap-3 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-colors duration-150 disabled:cursor-default ${
                        on ? "border-brand bg-brand-tint" : errors.batchId ? "border-[#B91C1C] bg-surface" : "border-border bg-surface hover:border-[#9CA3AF]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">
                          {option.code} · {option.courses.map((c) => c.name).join(" + ")}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {option.branchName} · starts {formatDate(option.startDate)} · {option.status === "active" ? "Active" : "Planned"}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-[1.5px] ${on ? "border-[6px] border-brand" : "border-border-strong"}`}
                      />
                    </button>
                  );
                })}
              </div>
            )}
            {errors.batchId && (
              <span id="fe-batchId" role="alert" className="flex items-start gap-1.5 text-xs font-medium leading-snug text-[#B91C1C]">
                <span
                  aria-hidden="true"
                  className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#B91C1C] text-[11px] font-bold text-white"
                >
                  !
                </span>
                {errors.batchId}
              </span>
            )}
          </div>

          <div className="col-span-full flex min-w-0 flex-col gap-1.5">
            <span id="enroll-courses-label" className="text-[13px] font-semibold text-ink">
              Courses to take (pick one or more)
              <span aria-hidden="true" className="text-[#B91C1C]">
                {" "}
                *
              </span>
            </span>
            {!batch ? (
              <span className="text-[13px] text-muted">Choose a batch to see its courses.</span>
            ) : (
              <div role="group" aria-labelledby="enroll-courses-label" className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                {batch.courses.map((course) => {
                  const already = taken.has(pairKey(batch.id, course.id));
                  const on = courseIds.includes(course.id);
                  return (
                    <label
                      key={course.id}
                      className={`relative flex min-h-11 flex-col items-center justify-center rounded-lg border px-4 py-2 text-center text-sm font-semibold leading-snug transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30 ${
                        already
                          ? "cursor-not-allowed border-border bg-app text-muted"
                          : on
                            ? "cursor-pointer border-brand bg-brand text-white"
                            : "cursor-pointer border-border-strong bg-surface text-ink hover:bg-app"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={already}
                        onChange={() => toggleCourse(course.id)}
                        className="sr-only"
                        {...(errors.courseIds && !already && !courseIds.length ? invalidProps("courseIds", errors.courseIds) : {})}
                      />
                      {course.name}
                      {already && <span className="text-xs font-medium">Already enrolled</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {errors.courseIds && (
              <span id="fe-courseIds" role="alert" className="flex items-start gap-1.5 text-xs font-medium leading-snug text-[#B91C1C]">
                <span
                  aria-hidden="true"
                  className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#B91C1C] text-[11px] font-bold text-white"
                >
                  !
                </span>
                {errors.courseIds}
              </span>
            )}
          </div>

          <DField label="Payment plan" name="paymentPlanIntervalMonths" required>
            <select
              name="paymentPlanIntervalMonths"
              value={plan}
              onChange={(event) => setPlan(Number(event.target.value))}
              className={controlClass(false)}
            >
              {PAYMENT_PLAN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </DField>
          <DField
            label="Total fee per course (USD)"
            name="paymentPlanAmountDollars"
            required
            error={errors.paymentPlanAmountDollars}
            hint={courseIds.length > 1 ? `Each of the ${courseIds.length} courses gets its own fee plan.` : undefined}
          >
            <input
              type="text"
              inputMode="decimal"
              name="paymentPlanAmountDollars"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              onBlur={blur("paymentPlanAmountDollars")}
              className={controlClass(Boolean(errors.paymentPlanAmountDollars))}
              {...invalidProps("paymentPlanAmountDollars", errors.paymentPlanAmountDollars)}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={courseIds.length > 1 ? `Enroll in ${courseIds.length} courses` : "Enroll now"}
        pendingLabel="Enrolling…"
        pending={pending}
        disabled={visibleBatches.length === 0}
      />
    </form>
  );
}

export function EnrollCoursesDialog({
  open,
  onOpenChange,
  student = null,
  students = [],
  batches,
  lockedBatchId,
  enrolledPairs,
  title,
  studentsNote,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fixed student (Student detail, Admissions). Omit to pick one. */
  student?: EnrollStudentOption | null;
  students?: EnrollStudentOption[];
  batches: EnrollBatchOption[];
  /** Batch detail: enrollment into this batch only. */
  lockedBatchId?: string;
  /** Active "batchId:courseId" pairs per student id. */
  enrolledPairs: Record<string, string[]>;
  title?: string;
  /** Shown under the student picker (e.g. when the list is cut off). */
  studentsNote?: string;
  onEnrolled?: () => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? (student ? `Enroll ${student.fullName}` : "Enroll a student")}
      description={
        lockedBatchId
          ? "Only students who can still join this batch are listed. Pick the student, then the courses they take."
          : "Pick the batch, then the courses the student takes in it. Each course gets its own fee plan."
      }
    >
      {open && (
        <EnrollFields
          student={student}
          students={students}
          batches={batches}
          lockedBatchId={lockedBatchId}
          enrolledPairs={enrolledPairs}
          studentsNote={studentsNote}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onEnrolled?.();
          }}
        />
      )}
    </DesignDialog>
  );
}

