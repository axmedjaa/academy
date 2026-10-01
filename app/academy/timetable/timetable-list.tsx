"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import {
  createWeeklyTimetableEntry,
  deleteTimetableEntry,
  type TimetableFormState,
} from "@/lib/academies/timetables-actions";
import type { TimetableEntryWithBatch } from "@/lib/academies/timetables";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime, type TimetableDay } from "@/lib/academies/timetable-constants";
import { buildTimetableGrid, filterTimetableEntries } from "@/lib/academies/timetable-grid";
import type { BranchRecord } from "@/lib/academies/branches";
import type { BatchRecord } from "@/lib/academies/batches";
import type { CourseRecord } from "@/lib/academies/courses";
import { Button, EmptyState, ErrorMessage, Field, LinkButton, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { WeeklyGrid } from "./weekly-grid";

const initialState: TimetableFormState = { ok: false };

interface StaffOption {
  id: string;
  fullName: string;
}

interface Props {
  entries: TimetableEntryWithBatch[];
  branches: BranchRecord[];
  batches: BatchRecord[];
  /** Academy-wide, not branch-specific (courses have no branch_id of their
   * own) — "courses available at a branch" is derived below from which
   * courses actually have a batch at the selected branch. */
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
  if (filters.branchId) params.set("branchId", filters.branchId);
  if (filters.courseId) params.set("courseId", filters.courseId);
  if (filters.batchId) params.set("batchId", filters.batchId);
  if (filters.instructorId) params.set("instructorId", filters.instructorId);
  if (filters.dayOfWeek) params.set("dayOfWeek", filters.dayOfWeek);
  const qs = params.toString();
  return `/academy/timetable/print${qs ? `?${qs}` : ""}`;
}

export function TimetableList({ entries, branches, batches, courses, staffOptions, canManage }: Props) {
  const [createState, createFormAction, createPending] = useActionState(
    createWeeklyTimetableEntry,
    initialState,
  );
  const [isPending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Cascading selection state for the CREATE form — independent of the
  // filter state below (a user can be filtering the view to one batch while
  // creating entries for a completely different one).
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [selectedDays, setSelectedDays] = useState<Set<TimetableDay>>(new Set());

  // Filter state for the DISPLAY (weekly grid + management table) — purely
  // client-side, narrowing the already permission-scoped `entries` prop;
  // never a new server round-trip (approved review §14).
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

  const coursesForBranch = useMemo(() => {
    if (!selectedBranchId) return [];
    const courseIds = new Set(
      batches.filter((batch) => batch.branchId === selectedBranchId).map((batch) => batch.courseId),
    );
    return courses.filter((course) => courseIds.has(course.id));
  }, [batches, courses, selectedBranchId]);

  const batchesForSelection = useMemo(() => {
    return batches.filter(
      (batch) =>
        (!selectedBranchId || batch.branchId === selectedBranchId) &&
        (!selectedCourseId || batch.courseId === selectedCourseId),
    );
  }, [batches, selectedBranchId, selectedCourseId]);

  // Filter dropdown option lists are derived from the already-loaded
  // `entries` themselves (not from the full branches/courses/batches/staff
  // lists) — so a filter never offers a choice that would produce zero
  // results, and never exposes a branch/course/batch/instructor outside
  // what this caller can already see in the timetable.
  const filterCourseOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) byId.set(entry.courseId, entry.courseName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const filterBatchOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) byId.set(entry.batchId, entry.batchName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const filterInstructorOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) {
      if (entry.trainerStaffProfileId && entry.trainerName) byId.set(entry.trainerStaffProfileId, entry.trainerName);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const filterBranchOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) byId.set(entry.branchId, entry.branchName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);

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
        if (dayDiff !== 0) return dayDiff;
        return a.startTime.localeCompare(b.startTime);
      }),
    [filteredEntries],
  );

  const hasActiveFilters = Object.values(filters).some((value) => value !== "");

  function handleBranchChange(branchId: string) {
    setSelectedBranchId(branchId);
    setSelectedCourseId("");
    setSelectedBatchId("");
  }

  function handleCourseChange(courseId: string) {
    setSelectedCourseId(courseId);
    setSelectedBatchId("");
  }

  function toggleDay(day: TimetableDay) {
    setSelectedDays((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  function handleDelete(entryId: string, batchId: string) {
    setDeleteError(null);
    startTransition(async () => {
      const result = await deleteTimetableEntry(entryId, batchId);
      if (!result.ok) setDeleteError(result.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Weekly timetable</h2>
          <div className="flex flex-wrap gap-2">
            {hasActiveFilters && (
              <Button type="button" variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </Button>
            )}
            <LinkButton href={buildPrintHref(filters)} variant="secondary" target="_blank">
              Print Timetable
            </LinkButton>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Branch">
            <select className={inputClass} value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
              <option value="">All branches</option>
              {filterBranchOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Course">
            <select className={inputClass} value={filters.courseId} onChange={(e) => setFilters({ ...filters, courseId: e.target.value })}>
              <option value="">All courses</option>
              {filterCourseOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Batch">
            <select className={inputClass} value={filters.batchId} onChange={(e) => setFilters({ ...filters, batchId: e.target.value })}>
              <option value="">All batches</option>
              {filterBatchOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Instructor">
            <select className={inputClass} value={filters.instructorId} onChange={(e) => setFilters({ ...filters, instructorId: e.target.value })}>
              <option value="">All instructors</option>
              {filterInstructorOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <select className={inputClass} value={filters.dayOfWeek} onChange={(e) => setFilters({ ...filters, dayOfWeek: e.target.value })}>
              <option value="">All days</option>
              {DAYS_OF_WEEK.map((day) => (
                <option key={day} value={day}>
                  {DAY_LABELS[day]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <WeeklyGrid slots={gridSlots} />
      </section>

      {canManage && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink">Create weekly timetable</h2>
          <Section>
            <form action={createFormAction} className="flex max-w-md flex-col gap-3">
              <Field label="Branch">
                <select
                  name="branchId"
                  required
                  className={inputClass}
                  value={selectedBranchId}
                  onChange={(event) => handleBranchChange(event.target.value)}
                >
                  <option value="" disabled>
                    Select a branch…
                  </option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Course / Program">
                <select
                  className={inputClass}
                  value={selectedCourseId}
                  disabled={!selectedBranchId}
                  onChange={(event) => handleCourseChange(event.target.value)}
                >
                  <option value="">
                    {selectedBranchId ? "All courses at this branch" : "Select a branch first"}
                  </option>
                  {coursesForBranch.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Batch">
                <select
                  name="batchId"
                  required
                  className={inputClass}
                  value={selectedBatchId}
                  disabled={!selectedBranchId}
                  onChange={(event) => setSelectedBatchId(event.target.value)}
                >
                  <option value="" disabled>
                    {selectedBranchId ? "Select a batch…" : "Select a branch first"}
                  </option>
                  {batchesForSelection.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Teaching days">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  {DAYS_OF_WEEK.map((day) => (
                    <label key={day} className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        name="daysOfWeek"
                        value={day}
                        checked={selectedDays.has(day)}
                        onChange={() => toggleDay(day)}
                      />
                      {DAY_LABELS[day]}
                    </label>
                  ))}
                </div>
                {selectedDays.size === 0 && (
                  <p className="mt-1 text-xs text-muted">Select at least one teaching day.</p>
                )}
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Start time">
                  <input type="time" name="startTime" required className={inputClass} />
                </Field>
                <Field label="End time">
                  <input type="time" name="endTime" required className={inputClass} />
                </Field>
              </div>
              <Field label="Instructor (optional)">
                <select name="trainerStaffProfileId" className={inputClass} defaultValue="">
                  <option value="">No instructor assigned</option>
                  {staffOptions.map((staff) => (
                    <option key={staff.id} value={staff.id}>
                      {staff.fullName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Room (optional)">
                <input type="text" name="room" className={inputClass} />
              </Field>
              {createState.error && <ErrorMessage message={createState.error.message} />}
              {createState.ok && createState.createdDays && createState.createdDays.length > 0 && (
                <p className="text-sm font-medium text-success">
                  Weekly timetable created for{" "}
                  {createState.createdDays.map((day) => DAY_LABELS[day as TimetableDay]).join(", ")}.
                </p>
              )}
              <Button type="submit" disabled={createPending || selectedDays.size === 0} className="self-start">
                {createPending ? "Creating..." : "Create Weekly Timetable"}
              </Button>
            </form>
          </Section>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink">Manage entries</h2>
        {sortedEntries.length === 0 ? (
          <Section>
            <EmptyState
              message={
                hasActiveFilters
                  ? "No timetable entries match your current filters."
                  : "No timetable entries yet."
              }
              icon={<Icon name="fact_check" />}
              action={
                hasActiveFilters ? (
                  <Button type="button" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </Section>
        ) : (
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Branch</th>
              <th className={th}>Course</th>
              <th className={th}>Batch</th>
              <th className={th}>Day</th>
              <th className={th}>Time</th>
              <th className={th}>Room</th>
              <th className={th}>Instructor</th>
              {canManage && <th className={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <tr key={entry.id} className={trHover}>
                <td className={td}>{entry.branchName}</td>
                <td className={td}>{entry.courseName}</td>
                <td className={`${td} font-medium`}>{entry.batchName}</td>
                <td className={td}>{DAY_LABELS[entry.dayOfWeek]}</td>
                <td className={td}>
                  {formatTimetableTime(entry.startTime)}–{formatTimetableTime(entry.endTime)}
                </td>
                <td className={td}>{entry.room ?? "—"}</td>
                <td className={td}>{entry.trainerName ?? "—"}</td>
                {canManage && (
                  <td className={td}>
                    <Button
                      type="button"
                      variant="danger"
                      className="px-2.5 py-1 text-xs"
                      disabled={isPending}
                      onClick={() => handleDelete(entry.id, entry.batchId)}
                    >
                      Delete
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>
        )}
        {deleteError && (
          <div className="mt-2">
            <ErrorMessage message={deleteError} />
          </div>
        )}
      </section>
    </div>
  );
}
