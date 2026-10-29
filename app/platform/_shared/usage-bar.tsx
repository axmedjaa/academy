/**
 * One allowance bar (design `usage` rows): label, "used / limit", and a
 * thin bar that is green under 80%, amber from 80% and red at or over the
 * limit. The figures are always written out, never colour alone. Shared by
 * the Usage page and the academy detail page.
 */
const GB = 1024 ** 3;

export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  if (gb === 0) return "0";
  if (gb < 0.1) return gb.toFixed(2);
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

/** Green under 80%, amber from 80%, red at or over the limit. */
function barTone(current: number, limit: number): string {
  if (current >= limit) return "bg-danger";
  if (limit > 0 && current / limit >= 0.8) return "bg-warning";
  return "bg-success";
}

export function UsageBar({ label, current, limit, format = String }: { label: string; current: number; limit: number; format?: (value: number) => string }) {
  const percent = limit > 0 ? Math.min(100, (current / limit) * 100) : 100;
  const atLimit = current >= limit;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-[#374151]">{label}</span>
        <span className={`tabular-nums ${atLimit ? "font-semibold text-danger" : "text-[#374151]"}`}>
          {format(current)} / {format(limit)}
          {atLimit && <span className="sr-only"> (at limit)</span>}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-[#EEF0F3]"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(current, limit)}
      >
        <div className={`h-full rounded-full ${barTone(current, limit)}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

