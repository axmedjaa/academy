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
  if (!usage || !limits) {
    return (
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Usage</h2>
        <p style={{ color: "#666" }}>
          {!limits
            ? "No active plan to compare usage against."
            : "Usage has not been calculated yet."}
        </p>
      </section>
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
    <section style={{ marginTop: "1.5rem" }}>
      <h2>Usage{planName ? ` — ${planName} plan` : ""}</h2>
      <p style={{ color: "#666", fontSize: "0.85rem" }}>
        As of {usage.calculatedAt.toLocaleString()}. Informational only — allowance is
        enforced at creation time, not here.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Resource</th>
            <th style={{ textAlign: "left" }}>Used</th>
            <th style={{ textAlign: "left" }}>Limit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const format = row.formatValue ?? ((value: number) => String(value));
            const overLimit = row.limit !== null && row.current >= row.limit;
            return (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td style={overLimit ? { color: "crimson", fontWeight: "bold" } : undefined}>
                  {format(row.current)}
                </td>
                <td>{row.limit !== null ? format(row.limit) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
