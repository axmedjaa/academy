"use client";

import { startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { createBatch, updateBatch, type BatchFormState } from "@/lib/academies/batches-actions";
import type { BatchRecord } from "@/lib/academies/batches";
import { formatDate } from "@/lib/ui/date";
import { showSuccessToast } from "@/lib/ui/toast";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { guardAction } from "@/lib/ui/guard-action";
import { Icon } from "@/app/academy/_shell/icons";
import { EDITABLE_STATUS_OPTIONS } from "./batch-status";

/** Edit Batch status (design B09): the dropdown plus one card per choice
 * explaining it; the chosen one is highlighted. Archived is never a choice. */
function StatusField({ initial }: { initial: "planned" | "active" | "completed" }) {
  const [value, setValue] = useState<string>(initial);
  return (
    <DField label="Status" name="status" required full hint="To archive this batch, use the Archive action.">
      <select name="status" value={value} onChange={(event) => setValue(event.target.value)} className={controlClass(false)}>
        {EDITABLE_STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="mt-2 flex flex-col gap-1.5">
        {EDITABLE_STATUS_OPTIONS.map((option) => (
          <span
            key={option.value}
            className={`rounded-lg border px-3 py-2 text-[13px] ${value === option.value ? "border-brand bg-brand-tint" : "border-border bg-surface"}`}
          >
            <b className="font-semibold text-ink">{option.label}</b> <span className="text-[#4B5563]">{option.description}</span>
          </span>
        ))}
      </span>
    </DField>
  );
}

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateBatch = guardAction(createBatch);
const guardedUpdateBatch = guardAction(updateBatch);

/**
 * New batch / Edit batch (design A08 forms `batch` and `editBatch`): Branch,
 * batch type, the courses, Batch name and code.
 *
 * - Course-based batch: one or more courses chosen from searchable cards
 *   (selected ones shown as chips). On edit, courses can be added or removed;
 *   the server refuses to remove a course that students, classes or exams in
 *   this batch use.
 * - Program-based batch: pick a program and every active course of it is
 *   included automatically (the server takes them from the program). The
 *   type and program can't change after creation.
 *
 * A batch has NO overall start or end date. Each course in it has its own
 * optional start and end date (batch_courses.start_date/end_date), shown as
 * one compact row per course that expands to edit — never filled in
 * automatically. The server re-checks branch scope, every course, code
 * uniqueness and the course dates.
 */

const initialState: BatchFormState = { ok: false };

export interface BatchCourseOption {
  id: string;
  name: string;
  code: string | null;
  programId: string;
  programName: string | null;
  durationWeeks: number | null;
  status: "active" | "archived";
}

export interface BatchBranchOption {
  id: string;
  name: string;
  status: "active" | "archived";
}

type BatchType = "course" | "program";

const RULES: DesignFormRule[] = [
  { name: "branchId", label: "Branch", required: true, kind: "select" },
  {
    name: "programId",
    label: "Program",
    check: (value, data) => (data.get("batchType") === "program" && !value ? "Choose a program." : null),
  },
  {
    name: "courseIds",
    label: "Courses",
    check: (_value, data) =>
      data.get("batchType") !== "program" && data.getAll("courseIds").length === 0 ? "Pick at least one course." : null,
  },
  { name: "name", label: "Batch name", required: true },
  { name: "code", label: "Batch code", required: true },
  {
    name: "courseDates",
    label: "Course dates",
    check: (_value, data) => {
      for (const id of data.getAll("courseIds").map(String)) {
        const start = String(data.get(`courseStart_${id}`) ?? "");
        const end = String(data.get(`courseEnd_${id}`) ?? "");
        if (start && end && end < start) return "A course's end date can't be before its start date.";
      }
      return null;
    },
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/branch/i, "branchId"],
  [/program/i, "programId"],
  [/course's end date|course date/i, "courseDates"],
  [/course/i, "courseIds"],
  [/code/i, "code"],
  [/name/i, "name"],
];

/** One course's own dates: a compact summary row that expands to edit. The
 * inputs stay in the form while collapsed, so saved dates are always sent. */
function CourseDatesRow({
  course,
  initial,
  hasFormError,
  onBlur,
}: {
  course: { id: string; name: string };
  initial: { startDate: string | null; endDate: string | null } | undefined;
  hasFormError: boolean;
  onBlur: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(initial?.startDate ?? "");
  const [end, setEnd] = useState(initial?.endDate ?? "");
  const invalid = Boolean(start && end && end < start);
  const expanded = open || invalid;
  const summary =
    start || end ? `${start ? formatDate(start) : "No start"} – ${end ? formatDate(end) : "No end"}` : "Not scheduled";
  const panelId = `course-dates-${course.id}`;

  return (
    <div className={`rounded-xl border bg-surface ${invalid ? "border-[#B91C1C]" : "border-border"}`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink [overflow-wrap:anywhere]">{course.name}</span>
          <span className={`block text-xs tabular-nums ${start || end ? "text-ink" : "text-muted"}`}>{summary}</span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-brand">{expanded ? "Done" : start || end ? "Edit dates" : "Set dates"}</span>
      </button>
      <div id={panelId} hidden={!expanded} className="grid grid-cols-1 gap-2 border-t border-border px-3 pb-3 pt-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
          Start date
          <input
            type="date"
            name={`courseStart_${course.id}`}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            onBlur={onBlur}
            aria-label={`${course.name} start date`}
            className={controlClass(invalid || hasFormError)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
          End date
          <input
            type="date"
            name={`courseEnd_${course.id}`}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            onBlur={onBlur}
            aria-label={`${course.name} end date`}
            className={controlClass(invalid || hasFormError)}
          />
        </label>
        {invalid && (
          <span role="alert" className="col-span-full text-xs font-medium text-[#B91C1C]">
            The end date can&apos;t be before the start date.
          </span>
        )}
        {(start || end) && (
          <button
            type="button"
            onClick={() => {
              setStart("");
              setEnd("");
            }}
            className="col-span-full w-fit text-xs font-semibold text-muted hover:text-ink hover:underline"
          >
            Clear dates
          </button>
        )}
      </div>
    </div>
  );
}

function BatchFields({
  batch,
  branches,
  courses,
  onCancel,
  onSaved,
}: {
  batch: BatchRecord | null;
  branches: BatchBranchOption[];
  courses: BatchCourseOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(batch ? guardedUpdateBatch : guardedCreateBatch, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);
  const branchOptions = branches.filter((branch) => branch.status === "active" || branch.id === batch?.branchId);
  const courseOptions = courses.filter((course) => course.status === "active" || batch?.courseIds.includes(course.id));

  // Type and program are fixed once the batch exists.
  const [batchType, setBatchType] = useState<BatchType>(batch?.programId ? "program" : "course");
  const [programId, setProgramId] = useState(batch?.programId ?? "");
  const typeLocked = Boolean(batch);

  // Programs that have at least one active course (only those can make a batch).
  const programOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; courseCount: number }>();
    for (const course of courses) {
      if (course.status !== "active") continue;
      const entry = byId.get(course.programId) ?? { id: course.programId, name: course.programName ?? "Program", courseCount: 0 };
      entry.courseCount += 1;
      byId.set(course.programId, entry);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [courses]);

  const [pickedCourseIds, setPickedCourseIds] = useState<string[]>(
    batch?.courseIds ?? (courseOptions.length === 1 ? [courseOptions[0].id] : []),
  );
  // A program batch runs the program's active courses (plus, on edit, the
  // ones it already has). The server derives the same list authoritatively.
  const courseIds =
    batchType === "program"
      ? [
          ...new Set([
            ...(batch?.courseIds ?? []),
            ...courses.filter((course) => course.programId === programId && course.status === "active").map((course) => course.id),
          ]),
        ]
      : pickedCourseIds;
  const [query, setQuery] = useState("");

  const selected = courseIds
    .map((id) => courses.find((course) => course.id === id))
    .filter((course): course is BatchCourseOption => Boolean(course));

  function toggleCourse(id: string) {
    setPickedCourseIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    // Re-check once the hidden fields hold the new selection.
    window.setTimeout(blur("courseIds"), 0);
  }
  const needle = query.trim().toLowerCase();
  const visibleCourses = needle
    ? courseOptions.filter((course) =>
        [course.name, course.code, course.programName].some((value) => value?.toLowerCase().includes(needle)),
      )
    : courseOptions;

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(batch ? "Batch updated." : "Batch created.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_PATTERNS);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const segment = (on: boolean) =>
    `flex min-h-11 items-center justify-center rounded-lg border px-2.5 text-center text-[13px] font-semibold leading-tight transition-colors duration-150 ${
      on ? "border-brand bg-brand text-white" : "border-border-strong bg-surface text-ink hover:bg-app"
    } disabled:cursor-not-allowed disabled:opacity-60`;

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      {batch && <input type="hidden" name="batchId" value={batch.id} />}
      <input type="hidden" name="batchType" value={batchType} />
      {/* The server reads it only on create; an existing batch keeps its program. */}
      {batchType === "program" && <input type="hidden" name="programId" value={programId} />}
      {courseIds.map((id) => (
        <input key={id} type="hidden" name="courseIds" value={id} />
      ))}
      <DialogBody>
        <FieldGrid fill>
          <DField label="Branch" name="branchId" required error={errors.branchId}>
            <select
              name="branchId"
              defaultValue={batch?.branchId ?? (branchOptions.length === 1 ? branchOptions[0].id : "")}
              onBlur={blur("branchId")}
              className={controlClass(Boolean(errors.branchId))}
              {...invalidProps("branchId", errors.branchId)}
            >
              <option value="">Choose a branch</option>
              {branchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </DField>

          <div className="flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink">
            <span id="batch-type-label">Batch type</span>
            <div role="radiogroup" aria-labelledby="batch-type-label" className="grid grid-cols-2 gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={batchType === "course"}
                disabled={typeLocked}
                onClick={() => setBatchType("course")}
                className={segment(batchType === "course")}
              >
                Course-based
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={batchType === "program"}
                disabled={typeLocked}
                onClick={() => setBatchType("program")}
                className={segment(batchType === "program")}
              >
                Program-based
              </button>
            </div>
            <span className="text-xs font-normal text-muted">
              {typeLocked
                ? "The batch type can't change after the batch is created."
                : batchType === "program"
                  ? "Every active course of the program is included. Program students pay one program fee."
                  : "Pick individual courses. Each enrolled course has its own fee."}
            </span>
          </div>

          {batchType === "program" ? (
            <div className="col-span-full flex min-w-0 flex-col gap-1.5">
              <DField label="Program" name="programId" required error={errors.programId}>
                <select
                  value={programId}
                  disabled={typeLocked}
                  onChange={(event) => setProgramId(event.target.value)}
                  onBlur={blur("programId")}
                  className={controlClass(Boolean(errors.programId))}
                  {...invalidProps("programId", errors.programId)}
                >
                  <option value="">{programOptions.length === 0 ? "No programs with active courses" : "Choose a program"}</option>
                  {typeLocked && batch?.programId && !programOptions.some((p) => p.id === batch.programId) && (
                    <option value={batch.programId}>{selected[0]?.programName ?? "Current program"}</option>
                  )}
                  {programOptions.map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name} ({program.courseCount} course{program.courseCount === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              </DField>
              {programId && (
                <span aria-live="polite" className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-brand">Included courses:</span>
                  {selected.map((course) => (
                    <span key={course.id} className="inline-flex min-h-8 items-center rounded-full bg-brand-tint px-2.5 text-xs font-semibold text-brand">
                      {course.name}
                    </span>
                  ))}
                  {selected.length === 0 && <span className="text-[13px] text-muted">This program has no active courses.</span>}
                </span>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink" id="batch-course-label">
                Courses
                <span aria-hidden="true" className="text-[#B91C1C]">
                  {" "}
                  *
                </span>
              </span>
              <span aria-live="polite" className="flex flex-wrap items-center gap-1.5">
                {selected.length === 0 ? (
                  <span className="text-[13px] font-medium text-muted">Pick one or more courses.</span>
                ) : (
                  <>
                    <span className="text-[13px] font-medium text-brand">{selected.length} selected:</span>
                    {selected.map((course) => (
                      <button
                        key={course.id}
                        type="button"
                        onClick={() => toggleCourse(course.id)}
                        aria-label={`Remove ${course.name}`}
                        className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full bg-brand-tint px-2.5 text-left text-xs font-semibold text-brand hover:bg-[#F2D3DA]"
                      >
                        {course.name}
                        <span aria-hidden="true">×</span>
                      </button>
                    ))}
                  </>
                )}
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search courses"
                aria-label="Search courses"
                className={`${controlClass(false)} h-10`}
              />
              <div
                role="group"
                aria-labelledby="batch-course-label"
                aria-describedby={errors.courseIds ? "fe-courseIds" : undefined}
                className="flex max-h-[232px] flex-col gap-2.5 overflow-y-auto p-0.5"
              >
                {visibleCourses.map((course) => {
                  const on = pickedCourseIds.includes(course.id);
                  return (
                    <button
                      key={course.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-invalid={errors.courseIds && pickedCourseIds.length === 0 ? true : undefined}
                      onClick={() => toggleCourse(course.id)}
                      className={`flex min-h-[64px] shrink-0 items-start justify-between gap-3 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-colors duration-150 ${
                        on ? "border-brand bg-brand-tint" : errors.courseIds ? "border-[#B91C1C] bg-surface" : "border-border bg-surface hover:border-[#9CA3AF]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink">{course.name}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {[course.programName, course.durationWeeks ? `${course.durationWeeks} weeks` : null, course.code]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] ${on ? "border-brand bg-brand text-white" : "border-border-strong"}`}
                      >
                        {on && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M5 12.5 10 17 19 7" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
                {visibleCourses.length === 0 && (
                  <span className="col-span-full py-3 text-[13px] text-muted">
                    {courseOptions.length === 0 ? "No active courses yet. Create a course first." : "No course matches that search."}
                  </span>
                )}
              </div>
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
          )}

          <DField label="Batch name" name="name" required error={errors.name}>
            <input
              type="text"
              name="name"
              defaultValue={batch?.name ?? ""}
              maxLength={200}
              placeholder="1232"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Batch code" name="code" required error={errors.code}>
            <input
              type="text"
              name="code"
              defaultValue={batch?.code ?? ""}
              maxLength={50}
              placeholder="WD101-C"
              onBlur={blur("code")}
              className={controlClass(Boolean(errors.code))}
              {...invalidProps("code", errors.code)}
            />
          </DField>

          {batch && batch.status !== "archived" && <StatusField initial={batch.status} />}
          {batch && batch.status === "archived" && (
            <div role="note" className="col-span-full flex items-start gap-3 rounded-lg bg-app px-4 py-3 text-sm text-[#374151]">
              <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted">
                <Icon name="archive" width={18} height={18} />
              </span>
              <span>
                <span className="block font-semibold text-ink">Status</span>
                This batch is archived. Use Restore to bring it back.
              </span>
            </div>
          )}

          {selected.length > 0 && (
            <div className="col-span-full flex min-w-0 flex-col gap-2">
              <span className="text-[13px] font-semibold text-ink" id="batch-course-dates-label">
                Course schedule
                <span className="font-normal text-muted"> (optional)</span>
              </span>
              <span className="text-xs text-muted">
                Each course can have its own start and end date. Open a course to set or change them.
              </span>
              <div role="group" aria-labelledby="batch-course-dates-label" className="flex flex-col gap-2">
                {selected.map((course) => (
                  <CourseDatesRow
                    key={course.id}
                    course={course}
                    initial={batch?.courseDates?.[course.id]}
                    hasFormError={Boolean(errors.courseDates)}
                    onBlur={blur("courseDates")}
                  />
                ))}
              </div>
              {errors.courseDates && (
                <span id="fe-courseDates" role="alert" className="text-xs font-medium text-[#B91C1C]">
                  {errors.courseDates}
                </span>
              )}
            </div>
          )}
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={batch ? "Save changes" : "Create batch"}
        pendingLabel={batch ? "Saving…" : "Creating…"}
        pending={pending}
      />
    </form>
  );
}

export function BatchFormDialog({
  open,
  onOpenChange,
  batch,
  branches,
  courses,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: BatchRecord | null;
  branches: BatchBranchOption[];
  courses: BatchCourseOption[];
  onSaved?: () => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={batch ? "Edit batch" : "New batch"}
      description={
        batch
          ? "Change the name, branch, courses or each course's dates. Students already enrolled keep their fee plan. A course that students, classes or exams use in this batch can't be removed."
          : "Choose a course-based batch (pick courses) or a program-based batch (a whole program). Course dates are optional and set per course."
      }
    >
      {open && (
        <BatchFields
          key={batch?.id ?? "new"}
          batch={batch}
          branches={branches}
          courses={courses}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      )}
    </DesignDialog>
  );
}
