"use client";

import { useMemo, useState } from "react";
import {
  createWeeklyTimetableEntry,
  deleteTimetableEntry,
  type TimetableFormState,
} from "@/lib/academies/timetables-actions";
import { showSuccessToast } from "@/lib/ui/toast";
import type { TimetableEntryWithBatch } from "@/lib/academies/timetables";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime, type TimetableDay } from "@/lib/academies/timetable-constants";
import { buildTimetableGrid, filterTimetableEntries } from "@/lib/academies/timetable-grid";
import type { BranchRecord } from "@/lib/academies/branches";
import type { BatchRecord } from "@/lib/academies/batches";
import type { CourseRecord } from "@/lib/academies/courses";
import { EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
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
import { WeeklyGrid, branchToneFor } from "./weekly-grid";

/**
 * `/academy/timetable` — Screen Inventory A09, built from the active design
 * (academy-engine.js `a_timetable`): header with Add class and Print
 * timetable, "Show timetable for" batch cards, the timetable card (academy
 * eyebrow, scope, weekly grid, branch legend; a day-by-day list on narrow
 * screens) and the Manage classes table.
 *
 * Kept from the existing page, because they are real functionality: the
 * compact Branch / Course / Instructor / Day filters (client-side, over the
 * already permission-scoped entries) and the weekly creation form's
 * cascade (branch -> course -> batch), multi-day selection and
 * server-side conflict checks — now in the design's dialog.
 */

const initialState: TimetableFormState = { ok: false };

interface StaffOption {
  id: string;
  fullName: string;
}

interface Props {
  academyName: string;
  entries: TimetableEntryWithBatch[];
  branches: BranchRecord[];
  batches: BatchRecord[];
  courses: CourseRecord[];
  staffOptions: StaffOption[];
  canManage: boolean;
}

interface FilterState {
  branchId: string;
  courseId: string;
  batchId: string;
  instructorId: string;
  dayOfWeek: string;
}

const EMPTY_FILTERS: FilterState = { branchId: "", courseId: "", batchId: "", instructorId: "", dayOfWeek: "" };

function buildPrintHref(filters: FilterState): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const qs = params.toString();
  return `/academy/timetable/print${qs ? `?${qs}` : ""}`;
}

const compactSelect =
  "h-10 rounded-lg border border-border-strong bg-surface px-2.5 text-[13px] font-medium text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";

export function TimetableList({ academyName, entries, branches, batches, courses, staffOptions, canManage }: Props) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [addOpen, setAddOpen] = useState(false);

  const batchCodeById = useMemo(() => new Map(batches.map((batch) => [batch.id, batch.code])), [batches]);
  const branchOrder = useMemo(() => branches.map((branch) => branch.id), [branches]);
  const toneFor = useMemo(() => branchToneFor(branchOrder), [branchOrder]);

  // Option lists come from the entries themselves, so a filter never offers
  // a choice outside what this caller can already see.
  const optionsFrom = (pick: (entry: TimetableEntryWithBatch) => [string, string] | null) => {
    const byId = new Map<string, string>();
    for (const entry of entries) {
      const pair = pick(entry);
      if (pair) byId.set(pair[0], pair[1]);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  };
  const filterBranchOptions = useMemo(() => optionsFrom((e) => [e.branchId, e.branchName]), [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterCourseOptions = useMemo(() => optionsFrom((e) => [e.courseId, e.courseName]), [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterInstructorOptions = useMemo(
    () => optionsFrom((e) => (e.trainerStaffProfileId && e.trainerName ? [e.trainerStaffProfileId, e.trainerName] : null)),
    [entries], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Batch cards: every batch this caller can see that isn't archived (or
  // that still has classes), with its class count — the design lists
  // batches with 0 classes too.
  const batchCards = useMemo(() => {
    const courseName = new Map(courses.map((course) => [course.id, course.name]));
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.batchId, (counts.get(entry.batchId) ?? 0) + 1);
    return batches
      .filter((batch) => batch.status !== "archived" || counts.has(batch.id))
      .map((batch) => ({
        id: batch.id,
        name: batch.code,
        course: batch.courseIds.map((id) => courseName.get(id)).filter(Boolean).join(" + ") || batch.name,
        branchId: batch.branchId,
        count: counts.get(batch.id) ?? 0,
      }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [entries, batches, courses]);

  const filteredEntries = useMemo(
    () =>
      filterTimetableEntries(entries, {
        branchId: filters.branchId || undefined,
        courseId: filters.courseId || undefined,
        batchId: filters.batchId || undefined,
        instructorId: filters.instructorId || undefined,
        dayOfWeek: (filters.dayOfWeek as TimetableDay) || undefined,
      }),
    [entries, filters],
  );
  const gridSlots = useMemo(() => buildTimetableGrid(filteredEntries), [filteredEntries]);
  const sortedEntries = useMemo(
    () =>
      [...filteredEntries].sort((a, b) => {
        const dayDiff = DAYS_OF_WEEK.indexOf(a.dayOfWeek) - DAYS_OF_WEEK.indexOf(b.dayOfWeek);
        return dayDiff !== 0 ? dayDiff : a.startTime.localeCompare(b.startTime);
      }),
    [filteredEntries],
  );
  const hasActiveFilters = Object.values(filters).some((value) => value !== "");
  const usedBranchIds = [...new Set(filteredEntries.map((entry) => entry.branchId))];
  const scopeText = `${filters.batchId ? (batchCodeById.get(filters.batchId) ?? "One batch") : "All batches"}, ${
    filters.branchId ? (filterBranchOptions.find(([id]) => id === filters.branchId)?.[1] ?? "one branch") : "all branches"
  }`;

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Timetable"
        description="Weekly schedule across the academy. Saturday first. Session attendance is not part of this product."
        actions={
          <>
            {canManage && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-4 font-semibold text-ink transition-colors duration-150 hover:bg-app"
              >
                Add class
              </button>
            )}
            <a
              href={buildPrintHref(filters)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center rounded-lg bg-brand px-4 font-semibold !text-white no-underline transition-colors duration-150 hover:bg-brand-hover hover:no-underline"
            >
              Print timetable
            </a>
          </>
        }
      />

      {batchCards.length > 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-surface px-4 pb-3.5 pt-4 shadow-card">
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Show timetable for</div>
          <div className="flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {[{ id: "", name: "All batches", course: "", branchId: "", count: entries.length }, ...batchCards].map((card) => {
              const on = filters.batchId === card.id;
              const tone = card.branchId ? toneFor(card.branchId) : null;
              return (
                <button
                  key={card.id || "all"}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilters({ ...filters, batchId: card.id })}
                  className={`flex min-w-[150px] max-w-[240px] shrink-0 flex-col gap-[3px] rounded-xl border-[1.5px] px-3.5 py-2.5 text-left transition-colors duration-150 ${
                    on ? "border-brand bg-brand-tint" : "border-border bg-surface shadow-[0_1px_2px_rgba(17,24,39,0.04)] hover:border-border-strong"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-bold text-ink">
                    {card.id ? (
                      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${tone?.dot}`} />
                    ) : (
                      <Icon name="layers" width={16} height={16} />
                    )}
                    <span className="truncate">{card.name}</span>
                    {on && <Icon name="check_circle" width={16} height={16} className="ml-auto shrink-0 text-brand" />}
                  </span>
                  <span className="truncate text-xs text-muted">
                    {card.id ? `${card.course} · ` : ""}
                    {card.count} class{card.count === 1 ? "" : "es"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Filter</span>
          {filterBranchOptions.length > 1 && (
            <select aria-label="Branch" className={compactSelect} value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
              <option value="">All branches</option>
              {filterBranchOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Course" className={compactSelect} value={filters.courseId} onChange={(e) => setFilters({ ...filters, courseId: e.target.value })}>
            <option value="">All courses</option>
            {filterCourseOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {filterInstructorOptions.length > 0 && (
            <select aria-label="Instructor" className={compactSelect} value={filters.instructorId} onChange={(e) => setFilters({ ...filters, instructorId: e.target.value })}>
              <option value="">All instructors</option>
              {filterInstructorOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Day" className={compactSelect} value={filters.dayOfWeek} onChange={(e) => setFilters({ ...filters, dayOfWeek: e.target.value })}>
            <option value="">All days</option>
            {DAYS_OF_WEEK.map((day) => (
              <option key={day} value={day}>
                {DAY_LABELS[day]}
              </option>
            ))}
          </select>
          {hasActiveFilters && (
            <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="h-10 px-2 text-[13px] font-semibold text-brand hover:underline">
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="mb-8 overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b-[3px] border-brand px-6 py-5">
          <div className="min-w-0 flex-[1_1_280px]">
            <div className="text-xs font-bold uppercase tracking-[0.12em] text-brand">{academyName}</div>
            <div className="text-[22px] font-bold leading-tight text-ink">Weekly timetable</div>
          </div>
          <div className="text-right text-[13px] text-[#374151]">{scopeText}</div>
        </div>
        <WeeklyGrid slots={gridSlots} toneFor={toneFor} batchCodeById={batchCodeById} />
        {usedBranchIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 px-6 py-3 text-xs text-[#374151]">
            <span className="font-semibold">Branches</span>
            {usedBranchIds.map((branchId) => {
              const tone = toneFor(branchId);
              return (
                <span key={branchId} className="flex items-center gap-2">
                  <span aria-hidden="true" className={`h-3.5 w-1 rounded-sm ${tone.bar}`} />
                  {filteredEntries.find((entry) => entry.branchId === branchId)?.branchName}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <h2 className="mb-2 font-semibold text-ink">Manage classes</h2>
      {sortedEntries.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message={hasActiveFilters ? "No classes match your current filters." : "No classes scheduled yet."}
            icon={<Icon name="calendar" />}
          />
        </Section>
      ) : (
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Course</th>
              <th className={rtTh}>Day</th>
              <th className={rtTh}>Time</th>
              <th className={rtTh}>Trainer</th>
              <th className={rtTh}>Room</th>
              {canManage && <th className={`${rtTh} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <tr key={entry.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Batch">
                  {batchCodeById.get(entry.batchId) ?? entry.batchName}
                </td>
                <td className={rtTd} data-label="Course">
                  {entry.courseName}
                </td>
                <td className={rtTd} data-label="Day">
                  {DAY_LABELS[entry.dayOfWeek]}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Time">
                  {formatTimetableTime(entry.startTime)} to {formatTimetableTime(entry.endTime)}
                </td>
                <td className={rtTd} data-label="Trainer">
                  {entry.trainerName ?? <span className="text-muted">Not assigned</span>}
                </td>
                <td className={rtTd} data-label="Room">
                  {entry.room ?? <span className="text-muted">—</span>}
                </td>
                {canManage && (
                  <td className={`${rtTd} text-right`} data-actions="">
                    <ConfirmButton
                      label="Delete"
                      variant="danger"
                      title="Delete class"
                      description={
                        <>
                          Removes {batchCodeById.get(entry.batchId) ?? entry.batchName} / {entry.courseName} on{" "}
                          {DAY_LABELS[entry.dayOfWeek]}. This cannot be undone.
                        </>
                      }
                      confirmLabel="Delete class"
                      onConfirm={() => deleteTimetableEntry(entry.id, entry.batchId)}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>Conflicts for the batch, trainer and room are checked per day when a class is added.</NoteBlock>

      {canManage && (
        <DesignDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title="Add class"
          description="Pick the batch and every day it meets. Use the same time for all days or set a different time for each day. Conflicts for the batch, trainer and room are checked per day."
        >
          {addOpen && (
            <AddClassForm
              branches={branches}
              batches={batches}
              courses={courses}
              staffOptions={staffOptions}
              onCancel={() => setAddOpen(false)}
              onCreated={() => setAddOpen(false)}
            />
          )}
        </DesignDialog>
      )}
    </section>
  );
}

const ADD_RULES: DesignFormRule[] = [
  { name: "batchId", label: "Batch", required: true, kind: "select" },
  { name: "courseId", label: "Course taught", required: true, kind: "select" },
  {
    name: "daysOfWeek",
    label: "Days",
    check: (_value, data) => (data.getAll("daysOfWeek").length === 0 ? "Choose at least one day." : null),
  },
  {
    name: "endTime",
    label: "End time",
    check: (_value, data) => {
      if (data.get("timeMode") === "each") {
        for (const day of data.getAll("daysOfWeek").map(String)) {
          const start = String(data.get(`start_${day}`) ?? "");
          const end = String(data.get(`end_${day}`) ?? "");
          if (!start || !end) return `Set the start and end time for ${DAY_LABELS[day as TimetableDay]}.`;
          if (end <= start) return `${DAY_LABELS[day as TimetableDay]}: the end time must be after the start time.`;
        }
        return null;
      }
      const start = String(data.get("startTime") ?? "");
      const end = String(data.get("endTime") ?? "");
      if (!start || !end) return "Set the start and end time.";
      return end <= start ? "The end time must be after the start time." : null;
    },
  },
];

const ADD_SERVER_PATTERNS: [RegExp, string][] = [
  [/end time|start time|HH:MM|time/i, "endTime"],
  [/day/i, "daysOfWeek"],
  [/course/i, "courseId"],
  [/batch|branch/i, "batchId"],
];

/**
 * Add class (design A09 form `slot`): Batch, the course it teaches, the days
 * it meets, then either one time for every day or a time per day, and the
 * optional trainer and room. The branch comes from the chosen batch. Each
 * group of days sharing a time is one `createWeeklyTimetableEntry` call, so
 * the server's per-day conflict checks (batch, trainer, room) still run; if
 * a later group is refused, the days already added are reported.
 */
function AddClassForm({
  branches,
  batches,
  courses,
  staffOptions,
  onCancel,
  onCreated,
}: {
  branches: BranchRecord[];
  batches: BatchRecord[];
  courses: CourseRecord[];
  staffOptions: StaffOption[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { formRef, errors, banner, validate, blur, showServerError, setBanner } = useDesignForm(ADD_RULES);
  const [pending, setPending] = useState(false);
  const [batchId, setBatchId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [days, setDays] = useState<Set<TimetableDay>>(new Set(["sat"]));
  const [mode, setMode] = useState<"same" | "each">("same");

  const branchName = useMemo(() => new Map(branches.map((branch) => [branch.id, branch.name])), [branches]);
  const courseName = useMemo(() => new Map(courses.map((course) => [course.id, course.name])), [courses]);
  const selectable = useMemo(
    () =>
      batches
        .filter((batch) => batch.status !== "archived" && batch.status !== "completed")
        .sort((x, y) => x.code.localeCompare(y.code)),
    [batches],
  );
  const chosen = selectable.find((batch) => batch.id === batchId) ?? null;
  const orderedDays = DAYS_OF_WEEK.filter((day) => days.has(day));

  function toggleDay(day: TimetableDay) {
    setDays((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function submit(data: FormData) {
    if (!chosen) return;
    // Group days by their time range; one server call per group.
    const groups = new Map<string, TimetableDay[]>();
    for (const day of orderedDays) {
      const start = mode === "each" ? String(data.get(`start_${day}`) ?? "") : String(data.get("startTime") ?? "");
      const end = mode === "each" ? String(data.get(`end_${day}`) ?? "") : String(data.get("endTime") ?? "");
      const key = `${start}|${end}`;
      groups.set(key, [...(groups.get(key) ?? []), day]);
    }
    setPending(true);
    const added: TimetableDay[] = [];
    for (const [key, groupDays] of groups) {
      const [start, end] = key.split("|");
      const payload = new FormData();
      payload.set("branchId", chosen.branchId);
      payload.set("batchId", chosen.id);
      payload.set("courseId", courseId);
      for (const day of groupDays) payload.append("daysOfWeek", day);
      payload.set("startTime", start);
      payload.set("endTime", end);
      payload.set("trainerStaffProfileId", String(data.get("trainerStaffProfileId") ?? ""));
      payload.set("room", String(data.get("room") ?? ""));
      const result = await createWeeklyTimetableEntry(initialState, payload);
      if (!result.ok) {
        setPending(false);
        const message = result.error?.message ?? "The class could not be added.";
        if (added.length > 0) {
          setBanner(
            `Added for ${added.map((day) => DAY_LABELS[day]).join(", ")}. Not added for ${groupDays
              .map((day) => DAY_LABELS[day])
              .join(", ")}: ${message}`,
          );
          onCreated();
        } else {
          showServerError(message, ADD_SERVER_PATTERNS);
        }
        return;
      }
      added.push(...groupDays);
    }
    setPending(false);
    showSuccessToast(`Class added for ${DAYS_OF_WEEK.filter((day) => added.includes(day)).map((day) => DAY_LABELS[day]).join(", ")}.`);
    onCreated();
  }

  const segment = (on: boolean) =>
    `flex min-h-11 items-center justify-center rounded-lg border px-2.5 text-center text-[13px] font-semibold leading-tight transition-colors duration-150 ${
      on ? "border-brand bg-brand text-white" : "border-border-strong bg-surface text-ink hover:bg-app"
    }`;

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => void submit(data))}
    >
      <input type="hidden" name="timeMode" value={mode} />
      <DialogBody>
        <FieldGrid fill>
          <DField label="Batch" name="batchId" required error={errors.batchId}>
            <select
              name="batchId"
              value={batchId}
              onChange={(event) => {
                setBatchId(event.target.value);
                // A batch with one course needs no choice.
                const next = selectable.find((b) => b.id === event.target.value);
                setCourseId(next && next.courseIds.length === 1 ? next.courseIds[0] : "");
              }}
              onBlur={blur("batchId")}
              className={controlClass(Boolean(errors.batchId))}
              {...invalidProps("batchId", errors.batchId)}
            >
              <option value="">{selectable.length === 0 ? "No planned or active batches" : "Choose a batch"}</option>
              {selectable.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.code} · {branchName.get(batch.branchId) ?? batch.name}
                </option>
              ))}
            </select>
          </DField>
          <DField
            label="Course taught"
            name="courseId"
            required
            error={errors.courseId}
            hint={chosen ? `At ${branchName.get(chosen.branchId) ?? "its branch"}.` : undefined}
          >
            <select
              name="courseId"
              value={courseId}
              disabled={!chosen}
              onChange={(event) => setCourseId(event.target.value)}
              onBlur={blur("courseId")}
              className={controlClass(Boolean(errors.courseId))}
              {...invalidProps("courseId", errors.courseId)}
            >
              <option value="">{chosen ? "Choose the course" : "Choose a batch first"}</option>
              {chosen?.courseIds.map((id) => (
                <option key={id} value={id}>
                  {courseName.get(id) ?? "Unavailable course"}
                </option>
              ))}
            </select>
          </DField>

          <div className="flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink">
            <span id="tt-days-label">
              Days (pick one or more)<span aria-hidden="true" className="text-[#B91C1C]"> *</span>
            </span>
            <div role="group" aria-labelledby="tt-days-label" className="grid grid-cols-2 gap-2">
              {DAYS_OF_WEEK.map((day) => {
                const on = days.has(day);
                return (
                  <label
                    key={day}
                    className={`${segment(on)} cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30 ${day === "fri" ? "col-span-2" : ""}`}
                  >
                    <input
                      type="checkbox"
                      name="daysOfWeek"
                      value={day}
                      checked={on}
                      onChange={() => toggleDay(day)}
                      className="sr-only"
                      {...(errors.daysOfWeek && day === "sat" ? invalidProps("daysOfWeek", errors.daysOfWeek) : {})}
                    />
                    {DAY_LABELS[day]}
                  </label>
                );
              })}
            </div>
            {errors.daysOfWeek && (
              <span id="fe-daysOfWeek" role="alert" className="text-xs font-medium text-[#B91C1C]">
                {errors.daysOfWeek}
              </span>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink">
            <span id="tt-mode-label">Class times</span>
            <div role="radiogroup" aria-labelledby="tt-mode-label" className="grid grid-cols-2 gap-2">
              <button type="button" role="radio" aria-checked={mode === "same"} onClick={() => setMode("same")} className={segment(mode === "same")}>
                Same time every day
              </button>
              <button type="button" role="radio" aria-checked={mode === "each"} onClick={() => setMode("each")} className={segment(mode === "each")}>
                Different time on each day
              </button>
            </div>
          </div>

          {mode === "same" ? (
            <>
              <DField label="Start time" name="startTime" required>
                <input type="time" name="startTime" defaultValue="08:00" className={controlClass(false)} />
              </DField>
              <DField label="End time" name="endTime" required error={errors.endTime}>
                <input
                  type="time"
                  name="endTime"
                  defaultValue="10:00"
                  onBlur={blur("endTime")}
                  className={controlClass(Boolean(errors.endTime))}
                  {...invalidProps("endTime", errors.endTime)}
                />
              </DField>
            </>
          ) : (
            <div className="col-span-full flex flex-col gap-2 text-[13px] font-semibold text-ink">
              <span>Time for each day</span>
              {orderedDays.length === 0 && <span className="font-normal text-muted">Pick the days first.</span>}
              {orderedDays.map((day, index) => (
                <div key={day} className="grid grid-cols-[minmax(84px,auto)_1fr_1fr] items-center gap-2">
                  <span>{DAY_LABELS[day]}</span>
                  <input
                    type="time"
                    name={`start_${day}`}
                    defaultValue="08:00"
                    aria-label={`${DAY_LABELS[day]} start time`}
                    className={controlClass(false)}
                  />
                  <input
                    type="time"
                    name={`end_${day}`}
                    defaultValue="10:00"
                    aria-label={`${DAY_LABELS[day]} end time`}
                    onBlur={blur("endTime")}
                    className={controlClass(Boolean(errors.endTime))}
                    {...(index === 0 ? invalidProps("endTime", errors.endTime) : {})}
                  />
                </div>
              ))}
              {errors.endTime && (
                <span id="fe-endTime" role="alert" className="text-xs font-medium text-[#B91C1C]">
                  {errors.endTime}
                </span>
              )}
            </div>
          )}

          <DField label="Trainer (optional)" name="trainerStaffProfileId">
            <select name="trainerStaffProfileId" defaultValue="" className={controlClass(false)}>
              <option value="">No trainer assigned</option>
              {staffOptions.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.fullName}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Room (optional)" name="room">
            <input type="text" name="room" placeholder="Lab 1" maxLength={100} className={controlClass(false)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Add class" pendingLabel="Adding…" pending={pending} />
    </form>
  );
}
