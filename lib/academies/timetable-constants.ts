/**
 * Pure timetable constants, deliberately split out of lib/academies/
 * timetables.ts (a server-only module that imports the `pg` driver) so
 * client components (the weekly grid, filters, print view) can use the day
 * list/labels/time formatting without pulling server-only code into the
 * browser bundle — same reasoning, same fix, as lib/academies/book-stock.ts
 * for the Books module's stock-status logic. No DB, no "use server" — safe
 * to import from either side.
 */

/**
 * PRESENTATION order only — Saturday first (the academy's week start), per
 * the business requirement. This is deliberately NOT the order the
 * `day_of_week` Postgres enum was declared in (`lib/db/schema.ts`'s
 * `dayOfWeekEnum` stays `mon..sun`, unchanged — enum declaration order has
 * no bearing on application behavior, Postgres enums don't sort by
 * declaration order, and nothing here touches the schema). Every place that
 * displays, lists, groups, or sorts days — the weekly grid, the print view,
 * the create form's checkboxes, the management table's sort, the "Weekly
 * timetable created for ..." confirmation message — imports this ONE array
 * rather than keeping its own copy, so the live grid and the printed
 * timetable can never silently use a different week order. Conflict
 * detection is entirely unaffected: it compares `day_of_week` values for
 * equality (`eq(timetables.dayOfWeek, ...)`), never this array's index.
 */
export const DAYS_OF_WEEK = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;

export type TimetableDay = (typeof DAYS_OF_WEEK)[number];

export const DAY_LABELS: Record<TimetableDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** Postgres `time` columns round-trip with seconds ("09:00:00") — this
 * strips that for display ("09:00"). */
export function formatTimetableTime(time: string): string {
  return time.slice(0, 5);
}
