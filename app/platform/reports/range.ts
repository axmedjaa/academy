/**
 * The report's date-range presets, shared by the server page (initial
 * fetch) and the client manager (refetches). Plain module on purpose: the
 * server page calls `rangeToMonths`, which it could not do through a
 * "use client" module.
 */
export type ReportRange = "3" | "6" | "12" | "24" | "all";

export const RANGE_OPTIONS: readonly { value: ReportRange; label: string }[] = [
  { value: "3", label: "3M" },
  { value: "6", label: "6M" },
  { value: "12", label: "12M" },
  { value: "24", label: "24M" },
  { value: "all", label: "All time" },
];

/** Trailing months including the current one; null = all time. */
export function rangeToMonths(range: ReportRange): number | null {
  return range === "all" ? null : Number(range);
}
