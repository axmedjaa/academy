"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { createBatch, updateBatch, type BatchFormState } from "@/lib/academies/batches-actions";
import type { BatchRecord } from "@/lib/academies/batches";
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

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateBatch = guardAction(createBatch);
const guardedUpdateBatch = guardAction(updateBatch);

/**
 * New batch / Edit batch (design A08 forms `batch` and `editBatch`): Branch,
 * one or more Courses chosen from searchable cards (selected ones shown as
 * chips), Batch name and code, Start and End dates. The end date follows
 * the longest selected course until the user sets it themselves. On edit,
 * courses can be added or removed; the server refuses to remove a course
 * that students, classes or exams in this batch use, and re-checks branch
 * scope, every course, code uniqueness and the dates.
 */

const initialState: BatchFormState = { ok: false };

export interface BatchCourseOption {
  id: string;
  name: string;
  code: string | null;
  programName: string | null;
  durationWeeks: number | null;
  status: "active" | "archived";
}

export interface BatchBranchOption {
  id: string;
  name: string;
  status: "active" | "archived";
}

const RULES: DesignFormRule[] = [
  { name: "branchId", label: "Branch", required: true, kind: "select" },
  {
    name: "courseIds",
    label: "Courses",
    check: (_value, data) => (data.getAll("courseIds").length === 0 ? "Pick at least one course." : null),
  },
  { name: "name", label: "Batch name", required: true },
  { name: "code", label: "Batch code", required: true },
  { name: "startDate", label: "Start date", required: true },
  {
    name: "endDate",
    label: "End date",
    check: (value, data) => {
      const start = String(data.get("startDate") ?? "");
      return value && start && value < start ? "The end date can't be before the start date." : null;
    },
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/branch/i, "branchId"],
  [/course/i, "courseIds"],
  [/code/i, "code"],
  [/name/i, "name"],
  [/end date|before the start/i, "endDate"],
  [/start date/i, "startDate"],
];

/** Start date plus the course length, as YYYY-MM-DD (the last day). */
function endFromWeeks(start: string, weeks: number | null): string {
  if (!start || !weeks) return "";
  const date = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + weeks * 7 - 1);
  return date.toISOString().slice(0, 10);
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

  const [courseIds, setCourseIds] = useState<string[]>(
    batch?.courseIds ?? (courseOptions.length === 1 ? [courseOptions[0].id] : []),
  );
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState(batch?.startDate ?? "");
  const [endDate, setEndDate] = useState(batch?.endDate ?? "");
  // Until the user types an end date, it follows the course length.
  const [endTouched, setEndTouched] = useState(Boolean(batch?.endDate));

  const selected = courseOptions.filter((course) => courseIds.includes(course.id));
  // The end date follows the longest selected course.
  const longestWeeks = Math.max(0, ...selected.map((course) => course.durationWeeks ?? 0)) || null;
  const suggestedEnd = endFromWeeks(startDate, longestWeeks);
  const shownEnd = endTouched ? endDate : suggestedEnd;

  function toggleCourse(id: string) {
    setCourseIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
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

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      {batch && <input type="hidden" name="batchId" value={batch.id} />}
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
                const on = courseIds.includes(course.id);
                return (
                  <button
                    key={course.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-invalid={errors.courseIds && courseIds.length === 0 ? true : undefined}
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

          <DField label="Batch name" name="name" required error={errors.name}>
            <input
              type="text"
              name="name"
              defaultValue={batch?.name ?? ""}
              maxLength={200}
              placeholder="Morning cohort"
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
          <DField label="Start date" name="startDate" required error={errors.startDate}>
            <input
              type="date"
              name="startDate"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              onBlur={blur("startDate")}
              className={controlClass(Boolean(errors.startDate))}
              {...invalidProps("startDate", errors.startDate)}
            />
          </DField>
          <DField
            label="End date"
            name="endDate"
            error={errors.endDate}
            hint={!endTouched && suggestedEnd ? `Follows the longest course (${longestWeeks} weeks).` : undefined}
          >
            <input
              type="date"
              name="endDate"
              value={shownEnd}
              onChange={(event) => {
                setEndTouched(true);
                setEndDate(event.target.value);
              }}
              onBlur={blur("endDate")}
              className={controlClass(Boolean(errors.endDate))}
              {...invalidProps("endDate", errors.endDate)}
            />
          </DField>
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
          ? "Add or remove courses, move the dates or change the branch. Students already enrolled keep their fee plan. A course that students, classes or exams use in this batch can't be removed."
          : "Pick one or more existing courses (search to narrow the list), then the start date. The end date follows the longest selected course and you can still change it."
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
