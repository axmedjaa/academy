import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTimetableGrid, filterTimetableEntries } from "./timetable-grid";
import type { TimetableEntryWithBatch } from "./timetables";
import { DAYS_OF_WEEK } from "./timetable-constants";

/**
 * Pure data-transformation tests (per the approved review's own "test the
 * data transformation used by the print view rather than trying to test
 * browser printing itself") — no DB, no server, just plain objects. Both
 * the live weekly grid and the print view call these exact functions, so
 * these tests cover both at once by construction.
 */
function makeEntry(overrides: Partial<TimetableEntryWithBatch> = {}): TimetableEntryWithBatch {
  const now = new Date();
  return {
    id: randomUUID(),
    academyId: "academy-1",
    branchId: "branch-1",
    batchId: "batch-1",
    dayOfWeek: "mon",
    startTime: "09:00:00",
    endTime: "11:00:00",
    room: "Room A",
    trainerStaffProfileId: "staff-1",
    createdAt: now,
    updatedAt: now,
    batchName: "Batch 03",
    courseId: "course-1",
    courseName: "Web Development",
    branchName: "Main Branch",
    trainerName: "Ahmed",
    ...overrides,
  };
}

describe("filterTimetableEntries", () => {
  it("returns everything when no filters are set", () => {
    const entries = [makeEntry(), makeEntry({ id: randomUUID() })];
    expect(filterTimetableEntries(entries, {})).toHaveLength(2);
  });

  it("filters by branch", () => {
    const entries = [makeEntry({ branchId: "branch-1" }), makeEntry({ branchId: "branch-2" })];
    const result = filterTimetableEntries(entries, { branchId: "branch-2" });
    expect(result).toHaveLength(1);
    expect(result[0].branchId).toBe("branch-2");
  });

  it("filters by course", () => {
    const entries = [makeEntry({ courseId: "course-1" }), makeEntry({ courseId: "course-2" })];
    const result = filterTimetableEntries(entries, { courseId: "course-2" });
    expect(result).toHaveLength(1);
    expect(result[0].courseId).toBe("course-2");
  });

  it("filters by batch", () => {
    const entries = [makeEntry({ batchId: "batch-1" }), makeEntry({ batchId: "batch-2" })];
    const result = filterTimetableEntries(entries, { batchId: "batch-2" });
    expect(result).toHaveLength(1);
    expect(result[0].batchId).toBe("batch-2");
  });

  it("filters by instructor", () => {
    const entries = [
      makeEntry({ trainerStaffProfileId: "staff-1" }),
      makeEntry({ trainerStaffProfileId: "staff-2" }),
      makeEntry({ trainerStaffProfileId: null }),
    ];
    const result = filterTimetableEntries(entries, { instructorId: "staff-2" });
    expect(result).toHaveLength(1);
    expect(result[0].trainerStaffProfileId).toBe("staff-2");
  });

  it("filters by day", () => {
    const entries = [makeEntry({ dayOfWeek: "mon" }), makeEntry({ dayOfWeek: "wed" })];
    const result = filterTimetableEntries(entries, { dayOfWeek: "wed" });
    expect(result).toHaveLength(1);
    expect(result[0].dayOfWeek).toBe("wed");
  });

  it("applies combined filters as an AND, not an OR", () => {
    const entries = [
      makeEntry({ branchId: "branch-1", courseId: "course-1", dayOfWeek: "mon" }),
      makeEntry({ branchId: "branch-1", courseId: "course-2", dayOfWeek: "mon" }),
      makeEntry({ branchId: "branch-2", courseId: "course-1", dayOfWeek: "mon" }),
    ];
    const result = filterTimetableEntries(entries, { branchId: "branch-1", courseId: "course-1" });
    expect(result).toHaveLength(1);
    expect(result[0].branchId).toBe("branch-1");
    expect(result[0].courseId).toBe("course-1");
  });

  it("an empty filter result is a well-formed empty array, not an error", () => {
    const entries = [makeEntry({ branchId: "branch-1" })];
    const result = filterTimetableEntries(entries, { branchId: "nonexistent-branch" });
    expect(result).toEqual([]);
  });
});

describe("buildTimetableGrid", () => {
  it("groups entries into the correct day column", () => {
    const entries = [makeEntry({ dayOfWeek: "mon", id: "a" }), makeEntry({ dayOfWeek: "wed", id: "b" })];
    const slots = buildTimetableGrid(entries);
    expect(slots).toHaveLength(1); // same time range -> one row
    expect(slots[0].byDay.mon.map((e) => e.id)).toEqual(["a"]);
    expect(slots[0].byDay.wed.map((e) => e.id)).toEqual(["b"]);
    expect(slots[0].byDay.tue).toEqual([]);
  });

  it("derives rows from the actual distinct time ranges present, sorted chronologically — never a fixed slot system", () => {
    const entries = [
      makeEntry({ startTime: "13:00:00", endTime: "15:00:00" }),
      makeEntry({ startTime: "09:00:00", endTime: "11:00:00" }),
      makeEntry({ startTime: "10:00:00", endTime: "12:00:00" }),
    ];
    const slots = buildTimetableGrid(entries);
    expect(slots.map((s) => s.startTime)).toEqual(["09:00:00", "10:00:00", "13:00:00"]);
  });

  it("preserves MULTIPLE legitimate entries sharing the same day and time — never discards one", () => {
    const entries = [
      makeEntry({ id: "a", dayOfWeek: "mon", batchName: "Batch 03", room: "Room A" }),
      makeEntry({ id: "b", dayOfWeek: "mon", batchName: "Batch 05", room: "Room B" }),
    ];
    const slots = buildTimetableGrid(entries);
    expect(slots).toHaveLength(1);
    expect(slots[0].byDay.mon).toHaveLength(2);
    expect(slots[0].byDay.mon.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("every day column exists even when empty", () => {
    const slots = buildTimetableGrid([makeEntry({ dayOfWeek: "mon" })]);
    expect(Object.keys(slots[0].byDay).sort()).toEqual([...DAYS_OF_WEEK].sort());
    for (const day of DAYS_OF_WEEK) {
      if (day !== "mon") expect(slots[0].byDay[day]).toEqual([]);
    }
  });

  it("returns an empty slot list for an empty entry list", () => {
    expect(buildTimetableGrid([])).toEqual([]);
  });

  it("two different time ranges on the same day produce two separate rows, both correctly populated", () => {
    const entries = [
      makeEntry({ id: "a", dayOfWeek: "mon", startTime: "09:00:00", endTime: "11:00:00" }),
      makeEntry({ id: "b", dayOfWeek: "mon", startTime: "13:00:00", endTime: "15:00:00" }),
    ];
    const slots = buildTimetableGrid(entries);
    expect(slots).toHaveLength(2);
    expect(slots[0].byDay.mon.map((e) => e.id)).toEqual(["a"]);
    expect(slots[1].byDay.mon.map((e) => e.id)).toEqual(["b"]);
  });
});
