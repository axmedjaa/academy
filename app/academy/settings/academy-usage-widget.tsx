import type { ReactNode } from "react";
import type { OwnAcademyUsageLimits, OwnAcademyUsageMetrics } from "@/lib/academies/settings";

interface Props {
  planName: string | null;
  usage: OwnAcademyUsageMetrics | null;
  limits: OwnAcademyUsageLimits | null;
}

interface Row {
  label: string;
  current: number;
  limit: number | null;
  formatValue?: (value: number) => string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * DESIGN.md §9.11 "Usage" sub-section of /academy/settings: "Usage-vs-
 * allowance bars (§3) for every capped resource, own-academy view."
 * A plain server component (no interactivity) fed by `getOwnAcademyUsage`
 * (lib/academies/settings.ts). `usage === null` means `recalculateUsage`
 * (lib/subscriptions/usage.ts, Item 29) has never run for this academy —
 * rendered as an explicit "not yet calculated" state, not zeros, so it's
 * never confused with a genuinely-empty academy.
 */
export function AcademyUsageWidget({ planName, usage, limits }: Props) {
  const frame = (body: ReactNode, caption: ReactNode) => (
    <section className="mb-8 rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="usage-title">
      <h2 id="usage-title" className="text-[15px] font-semibold text-ink">
        Plan usage{planName ? `, ${planName}` : ""}
      </h2>
      <p className="mt-0.5 text-[13px] text-muted">{caption}</p>
      {body}
    </section>
  );

  if (!usage || !limits) {
    return frame(null, !limits ? "No active plan to compare usage against." : "Usage has not been calculated yet.");
  }

  const rows: Row[] = [
    { label: "Students", current: usage.activeStudentsCount, limit: limits.maxStudents },
    { label: "Staff", current: usage.activeStaffCount, limit: limits.maxStaff },
    { label: "Branches", current: usage.branchCount, limit: limits.maxBranches },
    { label: "Courses", current: usage.courseCount, limit: limits.maxCourses },
    { label: "Storage", current: usage.storageUsedBytes, limit: limits.maxStorageBytes, formatValue: formatBytes },
  ];

  return frame(
    <ul role="list" className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
      {rows.map((row) => {
        const format = row.formatValue ?? ((value: number) => String(value));
        const ratio = row.limit !== null && row.limit > 0 ? Math.min(1, row.current / row.limit) : null;
        const tone = ratio === null ? "bg-brand" : ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-brand";
        return (
          <li key={row.label} className="min-w-0">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-[#374151]">{row.label}</span>
              <span className={`tabular-nums ${ratio !== null && ratio >= 1 ? "font-bold text-danger" : "font-semibold text-ink"}`}>
                {format(row.current)}
                <span className="font-normal text-muted"> of {row.limit !== null ? format(row.limit) : "no limit"}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#EEF0F3]">
              {ratio !== null && <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` }} />}
            </div>
          </li>
        );
      })}
    </ul>,
    `As of ${usage.calculatedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Limits are checked when something is added, not here.`,
  );
}
