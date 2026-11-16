import type { BatchRecord } from "@/lib/academies/batches";

/**
 * How a batch status is shown (design A08 status tones, B09 legend and
 * Edit Batch status cards). Display only: whether a batch takes new
 * enrollments is decided on the server (lib/academies/batch-assignments.ts
 * and program-enrollments.ts accept only Planned and Active batches); these
 * labels and messages just describe that existing rule.
 */

export type BatchStatus = BatchRecord["status"];

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

/** Planned blue, Active green, Completed and Archived gray. */
export const BATCH_STATUS_TONE: Record<BatchStatus, "blue" | "green" | "gray"> = {
  planned: "blue",
  active: "green",
  completed: "gray",
  archived: "gray",
};

/** One short line per status for the list legend. */
export const BATCH_STATUS_HINT: Record<BatchStatus, string> = {
  planned: "Not started",
  active: "Running now",
  completed: "Finished",
  archived: "Use Archive / Restore",
};

/** The same rule the server applies to course and program enrollment. */
export function acceptsEnrollment(status: BatchStatus): boolean {
  return status === "planned" || status === "active";
}

/** The batch page's enrollment availability notice. */
export const BATCH_ENROLLMENT_MESSAGE: Record<BatchStatus, string> = {
  planned: "New students can be enrolled in this batch.",
  active: "Enrollment is open for this batch.",
  completed: "This batch is completed. New students cannot be enrolled.",
  archived: "This batch is archived. Restore it before managing new enrollments.",
};

/** Edit Batch status choices. "Archived" is never one of them: Archive and Restore own it. */
export const EDITABLE_STATUS_OPTIONS: { value: Exclude<BatchStatus, "archived">; label: string; description: string }[] = [
  { value: "planned", label: "Planned", description: "Created, but classes have not started." },
  { value: "active", label: "Active", description: "Classes are currently running." },
  { value: "completed", label: "Completed", description: "Classes have finished." },
];

/** "2026-10-09" -> "Oct 9, 2026" (calendar date, no timezone shift). */
export function formatCourseDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The earliest course start date in a batch (a batch has no overall start date), or null. */
export function batchStartDate(batch: Pick<BatchRecord, "courseDates">): string | null {
  const starts = Object.values(batch.courseDates ?? {})
    .map((dates) => dates.startDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  return starts[0] ?? null;
}
