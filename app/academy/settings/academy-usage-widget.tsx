import type { OwnAcademyUsageLimits, OwnAcademyUsageMetrics } from "@/lib/academies/settings";
import { Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

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
  if (!usage || !limits) {
    return (
      <Section>
        <h2 className="text-base font-semibold text-ink">Usage</h2>
        <p className="mt-1 text-sm text-muted">
          {!limits ? "No active plan to compare usage against." : "Usage has not been calculated yet."}
        </p>
      </Section>
    );
  }

  const rows: Row[] = [
    { label: "Branches", current: usage.branchCount, limit: limits.maxBranches },
    { label: "Students", current: usage.activeStudentsCount, limit: limits.maxStudents },
    { label: "Staff", current: usage.activeStaffCount, limit: limits.maxStaff },
    { label: "Courses", current: usage.courseCount, limit: limits.maxCourses },
    {
      label: "Storage",
      current: usage.storageUsedBytes,
      limit: limits.maxStorageBytes,
      formatValue: formatBytes,
    },
  ];

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Usage{planName ? ` — ${planName} plan` : ""}</h2>
      <p className="mt-1 text-sm text-muted">
        As of {usage.calculatedAt.toLocaleString()}. Informational only — allowance is enforced at
        creation time, not here.
      </p>
      <div className="mt-4">
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Resource</th>
              <th className={th}>Used</th>
              <th className={th}>Limit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const format = row.formatValue ?? ((value: number) => String(value));
              const overLimit = row.limit !== null && row.current >= row.limit;
              const pct = row.limit !== null && row.limit > 0 ? Math.min(100, (row.current / row.limit) * 100) : null;
              return (
                <tr key={row.label}>
                  <td className={`${td} font-medium`}>{row.label}</td>
                  <td className={td}>
                    <div className={overLimit ? "font-bold text-danger" : undefined}>{format(row.current)}</div>
                    {pct !== null && (
                      <div className="mt-1.5 h-1.5 w-32 overflow-hidden rounded-full bg-app">
                        <div
                          className={`h-full rounded-full ${overLimit ? "bg-danger" : "bg-brand"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </td>
                  <td className={td}>{row.limit !== null ? format(row.limit) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </div>
    </Section>
  );
}
