"use client";

import { useMemo, useState } from "react";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import type { ProgramBatchOption } from "@/lib/academies/program-enrollments";
import type { RegistrationEnrollment } from "@/lib/academies/register-student-actions";
import { formatDate } from "@/lib/ui/date";
import { dollarsToCents, formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { PaymentPlanField } from "@/app/academy/_shell/payment-plan-field";
import { DField, controlClass } from "@/app/academy/_shell/design-form";

/**
 * The registration form's enrollment step: Don't enroll yet / Individual
 * courses / Complete program.
 *
 * - Individual courses: one card per course, each with ITS OWN batch (only
 *   course-based batches that run it), fee, discount, payment plan, amount
 *   paid now and payment method. Duplicate courses can't be added; any card
 *   can be removed before saving.
 * - Complete program: a program-based batch (its program and included
 *   courses with their dates are shown), ONE program fee, discount and number
 *   of monthly installments, and an optional first payment. The included
 *   courses carry no fees.
 *
 * Money is typed in (no catalog prices). Final fee = fee − discount;
 * outstanding = final − paid now. The server re-validates everything before
 * the student is even created. Payment fields appear only for staff who may
 * record payments.
 */

export type EnrollmentMode = "none" | "courses" | "program";
type Method = "cash" | "mobile_money" | "bank_transfer";

const METHODS: { value: Method; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "bank_transfer", label: "Bank transfer" },
];
const PROGRAM_INSTALLMENTS = [1, 2, 3, 4, 6, 12] as const;
const CURRENCY = "USD";

interface MoneyDraft {
  fee: string;
  discount: string;
  installments: number;
  paid: string;
  method: Method | "";
}
interface CourseLine extends MoneyDraft {
  key: string;
  courseId: string;
  batchId: string;
}

const emptyMoney = (installments: number): MoneyDraft => ({ fee: "", discount: "", installments, paid: "", method: "" });
const toCents = (value: string) => (value.trim() === "" ? 0 : dollarsToCents(value));

interface MoneyFigures {
  feeCents: number | null;
  discountCents: number | null;
  paidCents: number | null;
  finalCents: number | null;
  outstandingCents: number | null;
  problem: string | null;
  status: "Fully paid" | "Partially paid" | "Unpaid" | null;
}

function figures(draft: MoneyDraft, canRecordPayments: boolean): MoneyFigures {
  const feeCents = draft.fee.trim() ? dollarsToCents(draft.fee) : null;
  const discountCents = toCents(draft.discount);
  const paidCents = canRecordPayments ? toCents(draft.paid) : 0;
  let problem: string | null = null;
  if (feeCents === null || feeCents <= 0) problem = "Enter the fee, for example 100 or 100.50.";
  else if (discountCents === null) problem = "Enter the discount as an amount, for example 10.";
  else if (discountCents >= feeCents) problem = "The discount must be less than the fee.";
  else if (paidCents === null) problem = "Enter the amount paid, for example 40.";
  else if (paidCents > feeCents - discountCents) problem = "The amount paid is more than the fee after discount.";
  else if (paidCents > 0 && !draft.method) problem = "Choose how the payment was made.";
  const finalCents = feeCents !== null && discountCents !== null ? Math.max(0, feeCents - discountCents) : null;
  const outstandingCents = finalCents !== null && paidCents !== null ? Math.max(0, finalCents - paidCents) : null;
  const status = finalCents === null || paidCents === null ? null : paidCents <= 0 ? "Unpaid" : paidCents >= finalCents ? "Fully paid" : "Partially paid";
  return { feeCents, discountCents, paidCents, finalCents, outstandingCents, problem, status };
}

function MoneyFields({
  idPrefix,
  draft,
  onChange,
  canRecordPayments,
  feeLabel,
  plan,
}: {
  idPrefix: string;
  draft: MoneyDraft;
  onChange: (next: MoneyDraft) => void;
  canRecordPayments: boolean;
  feeLabel: string;
  plan: React.ReactNode;
}) {
  const set = (patch: Partial<MoneyDraft>) => onChange({ ...draft, ...patch });
  const money = figures(draft, canRecordPayments);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <DField label={feeLabel} name={`${idPrefix}-fee`} required>
        <input
          type="text"
          inputMode="decimal"
          value={draft.fee}
          onChange={(event) => set({ fee: event.target.value })}
          placeholder="0.00"
          className={controlClass(false)}
        />
      </DField>
      <DField label="Discount (USD, optional)" name={`${idPrefix}-discount`}>
        <input
          type="text"
          inputMode="decimal"
          value={draft.discount}
          onChange={(event) => set({ discount: event.target.value })}
          placeholder="0.00"
          className={controlClass(false)}
        />
      </DField>
      <div className="col-span-full">{plan}</div>
      {canRecordPayments && (
        <>
          <DField label="Amount paid now (USD, optional)" name={`${idPrefix}-paid`}>
            <input
              type="text"
              inputMode="decimal"
              value={draft.paid}
              onChange={(event) => set({ paid: event.target.value })}
              placeholder="0.00"
              className={controlClass(false)}
            />
          </DField>
          <DField label="Payment method" name={`${idPrefix}-method`} required={toCents(draft.paid) !== 0}>
            <select value={draft.method} onChange={(event) => set({ method: event.target.value as Method | "" })} className={controlClass(false)}>
              <option value="">{toCents(draft.paid) ? "Choose a method" : "No payment now"}</option>
              {METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </DField>
        </>
      )}
      <div className="col-span-full flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-app px-3 py-2 text-[13px] tabular-nums text-ink">
        <span>
          Final fee: <strong>{money.finalCents !== null ? formatMoney(money.finalCents, CURRENCY) : "—"}</strong>
        </span>
        {canRecordPayments && (
          <span>
            Outstanding: <strong>{money.outstandingCents !== null ? formatMoney(money.outstandingCents, CURRENCY) : "—"}</strong>
          </span>
        )}
        {canRecordPayments && money.status && <span className="text-muted">{money.status}</span>}
      </div>
      {money.problem && (draft.fee || draft.discount || draft.paid) && (
        <span role="alert" className="col-span-full text-xs font-medium text-[#B91C1C]">
          {money.problem}
        </span>
      )}
    </div>
  );
}

export interface RegistrationEnrollmentValue {
  mode: EnrollmentMode;
  /** null when nothing is chosen yet or a line is incomplete. */
  payload: RegistrationEnrollment | null;
  /** The first problem to fix before saving, if any. */
  problem: string | null;
  summary: { label: string; detail: string; finalCents: number; paidCents: number; outstandingCents: number; method: string | null }[];
}

/** The starting value for a form that has no "Don't enroll yet" choice. */
export const NO_COURSE_YET: RegistrationEnrollmentValue = {
  mode: "courses",
  payload: null,
  problem: "Add at least one course, or choose a complete program.",
  summary: [],
};

export function RegistrationEnrollmentFields({
  enrollBatches,
  programBatches: allProgramBatches,
  canRecordPayments,
  onChange,
  allowNone = true,
  takenCourseIds = [],
  takenProgramIds = [],
}: {
  enrollBatches: EnrollBatchOption[];
  programBatches: ProgramBatchOption[];
  canRecordPayments: boolean;
  onChange: (value: RegistrationEnrollmentValue) => void;
  /** Registration offers "Don't enroll yet"; enrolling an existing student doesn't. */
  allowNone?: boolean;
  /** An existing student's active courses / programs: not offered again
   * (the server refuses duplicates regardless). */
  takenCourseIds?: string[];
  takenProgramIds?: string[];
}) {
  // Only the choices that have something to offer (e.g. a program batch page
  // offers only Complete program; a course batch page only Individual courses).
  const hasCourses = enrollBatches.some((batch) => batch.courses.some((course) => !takenCourseIds.includes(course.id)));
  const hasPrograms = allProgramBatches.some((batch) => !takenProgramIds.includes(batch.programId));
  const modes: EnrollmentMode[] = [...(allowNone ? (["none"] as const) : []), ...(hasCourses || !hasPrograms ? (["courses"] as const) : []), ...(hasPrograms ? (["program"] as const) : [])];
  const [mode, setMode] = useState<EnrollmentMode>(modes[0] ?? "courses");
  const programBatches = useMemo(
    () => allProgramBatches.filter((batch) => !takenProgramIds.includes(batch.programId)),
    [allProgramBatches, takenProgramIds],
  );
  const [lines, setLines] = useState<CourseLine[]>([]);
  const [programBatchId, setProgramBatchId] = useState("");
  const [program, setProgram] = useState<MoneyDraft>(emptyMoney(12));

  // Courses offered for individual enrollment, with the course-based batches running each.
  const courseCatalog = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; batches: EnrollBatchOption[] }>();
    for (const batch of enrollBatches) {
      for (const course of batch.courses) {
        if (takenCourseIds.includes(course.id)) continue;
        const entry = byId.get(course.id) ?? { id: course.id, name: course.name, batches: [] };
        entry.batches.push(batch);
        byId.set(course.id, entry);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [enrollBatches, takenCourseIds]);
  const programBatch = programBatches.find((batch) => batch.batchId === programBatchId) ?? null;

  function compute(nextMode: EnrollmentMode, nextLines: CourseLine[], nextProgramBatchId: string, nextProgram: MoneyDraft): RegistrationEnrollmentValue {
    const methodLabel = (method: Method | "") => METHODS.find((option) => option.value === method)?.label ?? null;
    if (nextMode === "courses") {
      if (nextLines.length === 0) {
        return { mode: nextMode, payload: null, problem: allowNone ? "Add at least one course, or choose “Don't enroll yet”." : NO_COURSE_YET.problem, summary: [] };
      }
      let problem: string | null = null;
      const summary: RegistrationEnrollmentValue["summary"] = [];
      for (const line of nextLines) {
        const course = courseCatalog.find((entry) => entry.id === line.courseId);
        const batch = course?.batches.find((entry) => entry.id === line.batchId);
        const money = figures(line, canRecordPayments);
        if (!problem && !batch) problem = `${course?.name ?? "A course"}: choose its batch.`;
        if (!problem && money.problem) problem = `${course?.name ?? "A course"}: ${money.problem}`;
        summary.push({
          label: course?.name ?? "Course",
          detail: `${batch ? batch.name : "No batch chosen"} · ${describePaymentPlan(money.finalCents ?? 0, line.installments, CURRENCY)}`,
          finalCents: money.finalCents ?? 0,
          paidCents: money.paidCents ?? 0,
          outstandingCents: money.outstandingCents ?? 0,
          method: (money.paidCents ?? 0) > 0 ? methodLabel(line.method) : null,
        });
      }
      const payload: RegistrationEnrollment | null = problem
        ? null
        : {
            type: "courses",
            lines: nextLines.map((line) => {
              const money = figures(line, canRecordPayments);
              return {
                courseId: line.courseId,
                courseName: courseCatalog.find((entry) => entry.id === line.courseId)?.name ?? "Course",
                batchId: line.batchId,
                feeCents: money.feeCents ?? 0,
                discountCents: money.discountCents ?? 0,
                installments: line.installments,
                paidCents: money.paidCents ?? 0,
                method: (money.paidCents ?? 0) > 0 && line.method ? line.method : undefined,
              };
            }),
          };
      return { mode: nextMode, payload, problem, summary };
    }
    if (nextMode === "program") {
      const batch = programBatches.find((entry) => entry.batchId === nextProgramBatchId);
      if (!batch) {
        return { mode: nextMode, payload: null, problem: allowNone ? "Choose the program batch, or choose “Don't enroll yet”." : "Choose the program batch.", summary: [] };
      }
      const money = figures(nextProgram, canRecordPayments);
      const summary = [
        {
          label: `${batch.programName} (complete program)`,
          detail: `${batch.batchName} · ${batch.courses.length} course${batch.courses.length === 1 ? "" : "s"} · ${describePaymentPlan(money.finalCents ?? 0, nextProgram.installments, CURRENCY)}`,
          finalCents: money.finalCents ?? 0,
          paidCents: money.paidCents ?? 0,
          outstandingCents: money.outstandingCents ?? 0,
          method: (money.paidCents ?? 0) > 0 ? methodLabel(nextProgram.method) : null,
        },
      ];
      if (money.problem) return { mode: nextMode, payload: null, problem: `${batch.programName}: ${money.problem}`, summary };
      return {
        mode: nextMode,
        problem: null,
        summary,
        payload: {
          type: "program",
          batchId: batch.batchId,
          programName: batch.programName,
          feeCents: money.feeCents ?? 0,
          discountCents: money.discountCents ?? 0,
          installments: nextProgram.installments,
          paidCents: money.paidCents ?? 0,
          method: (money.paidCents ?? 0) > 0 && nextProgram.method ? nextProgram.method : undefined,
        },
      };
    }
    return { mode: "none", payload: { type: "none" }, problem: null, summary: [] };
  }

  function update(next: { mode?: EnrollmentMode; lines?: CourseLine[]; programBatchId?: string; program?: MoneyDraft }) {
    const nextMode = next.mode ?? mode;
    const nextLines = next.lines ?? lines;
    const nextProgramBatchId = next.programBatchId ?? programBatchId;
    const nextProgram = next.program ?? program;
    if (next.mode !== undefined) setMode(next.mode);
    if (next.lines !== undefined) setLines(next.lines);
    if (next.programBatchId !== undefined) setProgramBatchId(next.programBatchId);
    if (next.program !== undefined) setProgram(next.program);
    onChange(compute(nextMode, nextLines, nextProgramBatchId, nextProgram));
  }

  function addCourse(courseId: string) {
    const course = courseCatalog.find((entry) => entry.id === courseId);
    if (!course || lines.some((line) => line.courseId === courseId)) return;
    update({
      lines: [
        ...lines,
        { key: `${courseId}-${Date.now()}`, courseId, batchId: course.batches.length === 1 ? course.batches[0].id : "", ...emptyMoney(1) },
      ],
    });
  }
  const setLine = (key: string, patch: Partial<CourseLine>) => update({ lines: lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) });

  const segment = (on: boolean) =>
    `flex min-h-11 items-center justify-center rounded-lg border px-2.5 text-center text-[13px] font-semibold leading-tight transition-colors duration-150 ${
      on ? "border-brand bg-brand text-white" : "border-border-strong bg-surface text-ink hover:bg-app"
    }`;
  const remainingCourses = courseCatalog.filter((course) => !lines.some((line) => line.courseId === course.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span id="reg-enroll-type" className="text-[13px] font-semibold text-ink">
          Enrollment type
        </span>
        <div role="radiogroup" aria-labelledby="reg-enroll-type" className={`grid grid-cols-1 gap-2 ${modes.length === 3 ? "sm:grid-cols-3" : modes.length === 2 ? "sm:grid-cols-2" : ""}`}>
          {(
            [
              ["none", "Don't enroll yet"],
              ["courses", "Individual courses"],
              ["program", "Complete program"],
            ] as [EnrollmentMode, string][]
          ).filter(([value]) => modes.includes(value)).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => update({ mode: value })} className={segment(mode === value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          {mode === "courses"
            ? "Each course is its own enrollment, with its own batch, fee, payment method and balance."
            : mode === "program"
              ? "The student pays one program fee in monthly installments. The program's courses carry no separate fees."
              : "You can enroll the student later from the student's page."}
        </span>
      </div>

      {mode === "courses" && (
        <div className="flex flex-col gap-3">
          {lines.map((line) => {
            const course = courseCatalog.find((entry) => entry.id === line.courseId);
            return (
              <div key={line.key} className="rounded-xl border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-ink">{course?.name ?? "Course"}</span>
                  <button
                    type="button"
                    onClick={() => update({ lines: lines.filter((entry) => entry.key !== line.key) })}
                    aria-label={`Remove ${course?.name ?? "this course"}`}
                    className="text-xs font-semibold text-[#B91C1C] hover:underline"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  <DField label="Batch" name={`line-${line.key}-batch`} required>
                    <select value={line.batchId} onChange={(event) => setLine(line.key, { batchId: event.target.value })} className={controlClass(!line.batchId)}>
                      <option value="">Choose a batch</option>
                      {course?.batches.map((batch) => (
                        <option key={batch.id} value={batch.id}>
                          {batch.name}
                        </option>
                      ))}
                    </select>
                  </DField>
                  <MoneyFields
                    idPrefix={`line-${line.key}`}
                    draft={line}
                    onChange={(next) => setLine(line.key, next)}
                    canRecordPayments={canRecordPayments}
                    feeLabel="Course fee (USD)"
                    plan={
                      <PaymentPlanField
                        name={`line-${line.key}-plan`}
                        value={line.installments}
                        onChange={(installments) => setLine(line.key, { installments })}
                      />
                    }
                  />
                </div>
              </div>
            );
          })}
          {remainingCourses.length > 0 ? (
            <DField label={lines.length === 0 ? "Add a course" : "Add another course"} name="reg-add-course">
              <select value="" onChange={(event) => addCourse(event.target.value)} className={controlClass(false)}>
                <option value="">Choose a course</option>
                {remainingCourses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </DField>
          ) : (
            courseCatalog.length === 0 && <span className="text-[13px] text-muted">No course-based batches are open for enrollment.</span>
          )}
        </div>
      )}

      {mode === "program" && (
        <div className="flex flex-col gap-3">
          <DField label="Program batch" name="reg-program-batch" required>
            <select value={programBatchId} onChange={(event) => update({ programBatchId: event.target.value })} className={controlClass(false)}>
              <option value="">{programBatches.length === 0 ? "No program batches are open" : "Choose a program batch"}</option>
              {programBatches.map((batch) => (
                <option key={batch.batchId} value={batch.batchId}>
                  {batch.programName} · {batch.batchName}
                </option>
              ))}
            </select>
          </DField>
          {programBatch && (
            <>
              <div className="rounded-xl border border-border bg-surface p-3">
                <div className="mb-1.5 text-[13px] font-semibold text-ink">
                  Included courses ({programBatch.courses.length})
                </div>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {programBatch.courses.map((course) => (
                    <li key={course.courseId} className="flex flex-wrap justify-between gap-x-3">
                      <span className="text-ink">{course.courseName}</span>
                      <span className="tabular-nums text-muted">
                        {course.startDate || course.endDate
                          ? `${course.startDate ? formatDate(course.startDate) : "No start"} – ${course.endDate ? formatDate(course.endDate) : "No end"}`
                          : "Dates not set"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <MoneyFields
                idPrefix="program"
                draft={program}
                onChange={(next) => update({ program: next })}
                canRecordPayments={canRecordPayments}
                feeLabel="Program fee (USD)"
                plan={
                  <DField label="Monthly installments" name="program-installments" hint={(() => {
                    const money = figures(program, canRecordPayments);
                    return money.finalCents ? describePaymentPlan(money.finalCents, program.installments, CURRENCY) : undefined;
                  })()}>
                    <select
                      value={program.installments}
                      onChange={(event) => update({ program: { ...program, installments: Number(event.target.value) } })}
                      className={controlClass(false)}
                    >
                      {PROGRAM_INSTALLMENTS.map((count) => (
                        <option key={count} value={count}>
                          {count === 1 ? "1 (pay in full)" : `${count} months`}
                        </option>
                      ))}
                    </select>
                  </DField>
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The confirmation summary shown before the registration is saved. */
export function RegistrationSummary({ value, canRecordPayments }: { value: RegistrationEnrollmentValue; canRecordPayments: boolean }) {
  if (value.mode === "none" || value.summary.length === 0) return null;
  const total = value.summary.reduce(
    (sum, row) => ({ final: sum.final + row.finalCents, paid: sum.paid + row.paidCents, outstanding: sum.outstanding + row.outstandingCents }),
    { final: 0, paid: 0, outstanding: 0 },
  );
  return (
    <div className="rounded-xl border border-brand/40 bg-brand-tint/40 p-3" aria-live="polite">
      <div className="mb-2 text-sm font-semibold text-ink">
        Summary — {value.mode === "program" ? "complete program enrollment" : "individual course enrollment"}
      </div>
      <ul className="flex flex-col gap-2 text-[13px]">
        {value.summary.map((row, index) => (
          <li key={index} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-b-0 last:pb-0">
            <span className="font-semibold text-ink">{row.label}</span>
            <span className="text-muted">{row.detail}</span>
            <span className="tabular-nums text-ink">
              Final {formatMoney(row.finalCents, CURRENCY)}
              {canRecordPayments && (
                <>
                  {" "}
                  · Paid now {formatMoney(row.paidCents, CURRENCY)}
                  {row.method ? ` (${row.method})` : ""} · Outstanding {formatMoney(row.outstandingCents, CURRENCY)}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {value.summary.length > 1 && (
        <div className="mt-2 border-t border-border pt-2 text-[13px] font-semibold tabular-nums text-ink">
          Total {formatMoney(total.final, CURRENCY)}
          {canRecordPayments && ` · Paid now ${formatMoney(total.paid, CURRENCY)} · Outstanding ${formatMoney(total.outstanding, CURRENCY)}`}
        </div>
      )}
    </div>
  );
}
