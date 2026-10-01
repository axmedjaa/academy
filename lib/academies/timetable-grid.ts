/**
 * Pure timetable grid-building/filtering logic — deliberately split out of
 * lib/academies/timetables.ts (server-only, imports `pg`) and lib/academies/
 * timetable-print.ts (server-only, imports `db`) so the exact same
 * functions can be imported by:
 *
 *   - the live weekly grid (client component)
 *   - the print data resolver (server)
 *
 * This is what guarantees the printed timetable and the on-screen weekly
 * grid can never silently diverge (approved review's own "print grouping
 * matches the weekly grid" requirement) — there is only ever one grouping
 * implementation, not two that could drift apart.
 *
 * Only `TimetableEntryWithBatch`'s TYPE is imported from timetables.ts
 * (erased at compile time, so it adds no runtime dependency on that
 * server-only module) — see lib/academies/book-stock.ts for the identical
 * pattern used for the Books module.
 */

import { DAYS_OF_WEEK, type TimetableDay } from "@/lib/academies/timetable-constants";
import type { TimetableEntryWithBatch } from "@/lib/academies/timetables";

export interface TimetableFilters {
  branchId?: string;
  courseId?: string;
  batchId?: string;
  instructorId?: string;
  dayOfWeek?: TimetableDay;
}

/** Narrows an already permission-scoped entry list by whichever filters are
 * set — never widens it, never re-derives tenant scope (that's entirely
 * the job of whatever already produced `entries`, e.g. `listAcademyTimetable`). */
export function filterTimetableEntries(
  entries: TimetableEntryWithBatch[],
  filters: TimetableFilters,
): TimetableEntryWithBatch[] {
  return entries.filter((entry) => {
    if (filters.branchId && entry.branchId !== filters.branchId) return false;
    if (filters.courseId && entry.courseId !== filters.courseId) return false;
    if (filters.batchId && entry.batchId !== filters.batchId) return false;
    if (filters.instructorId && entry.trainerStaffProfileId !== filters.instructorId) return false;
    if (filters.dayOfWeek && entry.dayOfWeek !== filters.dayOfWeek) return false;
    return true;
  });
}

export interface TimetableGridSlot {
  startTime: string;
  endTime: string;
  byDay: Record<TimetableDay, TimetableEntryWithBatch[]>;
}

/**
 * Groups entries into (startTime, endTime) rows × day-of-week columns. Rows
 * are the DISTINCT time ranges actually present in the given entries,
 * sorted chronologically — never a fixed/invented time-slot system (nothing
 * in this application uses fixed school-bell slots). A cell is a LIST, not
 * a single entry — two legitimate, non-conflicting entries (different
 * batch/room/instructor) can share the exact same day+time and both must
 * render, never silently overwritten.
 */
export function buildTimetableGrid(entries: TimetableEntryWithBatch[]): TimetableGridSlot[] {
  const slotsByKey = new Map<string, TimetableGridSlot>();

  for (const entry of entries) {
    const key = `${entry.startTime}|${entry.endTime}`;
    let slot = slotsByKey.get(key);
    if (!slot) {
      const byDay = {} as Record<TimetableDay, TimetableEntryWithBatch[]>;
      for (const day of DAYS_OF_WEEK) byDay[day] = [];
      slot = { startTime: entry.startTime, endTime: entry.endTime, byDay };
      slotsByKey.set(key, slot);
    }
    slot.byDay[entry.dayOfWeek].push(entry);
  }

  return [...slotsByKey.values()].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime),
  );
}
