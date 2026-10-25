import type { DashboardTrendPoint } from "@/app/academy/_shell/dashboard-trend-chart";

/**
 * Builds the reference's fixed seven-month window ending this month from a
 * sparse "YYYY-MM" series. `cumulative` turns per-month counts into a
 * running total that includes everything before the window, so the line
 * always ends on the real current total.
 */
export function buildMonthlyWindow(
  series: { period: string; count: number }[],
  { months = 7, cumulative = false, now = new Date() }: { months?: number; cumulative?: boolean; now?: Date } = {},
): DashboardTrendPoint[] {
  const byPeriod = new Map(series.map((row) => [row.period, row.count]));
  const keys: { key: string; date: Date }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push({ key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, date });
  }
  const firstKey = keys[0].key;
  let running = cumulative
    ? series.filter((row) => row.period < firstKey).reduce((total, row) => total + row.count, 0)
    : 0;
  return keys.map(({ key, date }) => {
    const count = byPeriod.get(key) ?? 0;
    running = cumulative ? running + count : count;
    return {
      label: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      fullLabel: date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      value: running,
    };
  });
}
