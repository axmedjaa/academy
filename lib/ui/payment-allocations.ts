/**
 * How a payment's fee-period allocations read in a payments list. A payment
 * is one row however many periods it funded; this names what it was applied
 * to from the allocation rows themselves (never inferred), one entry per
 * enrollment, in the order first allocated.
 */
export interface AllocationLine {
  enrollmentId: string;
  courseName: string;
  batchName: string;
}

export function describeAllocations(periods: AllocationLine[]): { label: string; detail: string | null } {
  const enrollments = new Map<string, string>();
  for (const period of periods) {
    if (!enrollments.has(period.enrollmentId)) enrollments.set(period.enrollmentId, `${period.courseName} · ${period.batchName}`);
  }
  const label = [...enrollments.values()].join("; ");
  const detail = periods.length > 1 ? `${periods.length} fee periods` : null;
  return { label, detail };
}
