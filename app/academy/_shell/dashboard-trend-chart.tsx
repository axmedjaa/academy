"use client";

import { useId, useState } from "react";

/**
 * Dashboard trend card body — the reference's own chart (Platform Console
 * `chart()` helper, used by both A01 "Enrollment" and P01 "Active
 * academies"): a header with the latest value and a month-over-month delta
 * chip, a smoothed burgundy line over a soft area fill, three gridlines with
 * axis labels, one dot per month, and a dark tooltip that follows hover or
 * keyboard focus (defaulting to the latest month). Each month column is a
 * real button so the chart is fully keyboard reachable; a visually hidden
 * summary carries the whole series for screen readers.
 */
export interface DashboardTrendPoint {
  /** Short axis label, e.g. "Oct". */
  label: string;
  /** Tooltip heading, e.g. "October 2026". */
  fullLabel: string;
  value: number;
}

const NICE_TOPS = [4, 8, 10, 12, 20, 25, 40, 50, 60, 80, 100, 120, 150, 200, 240, 300, 400, 500, 600, 800, 1000];

function niceTop(max: number): number {
  const target = Math.max(1, max * 1.08);
  const fixed = NICE_TOPS.find((top) => top >= target);
  if (fixed) return fixed;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  return Math.ceil(target / magnitude) * magnitude;
}

export function DashboardTrendChart({
  title,
  subtitle,
  points,
  noun,
  unit,
  deltaSuffix,
  legend,
}: {
  title: string;
  subtitle: string;
  points: DashboardTrendPoint[];
  /** Used in aria text: "{value} {noun}". */
  noun: string;
  /** Used in the tooltip: "{value} {unit}". */
  unit: string;
  /** Appended to the delta chip, e.g. "vs Sep". Omit to hide the chip. */
  deltaSuffix?: string;
  legend?: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [hovered, setHovered] = useState<number | null>(null);
  const count = points.length;
  const last = count - 1;
  const active = hovered ?? last;
  const values = points.map((point) => point.value);
  const top = niceTop(Math.max(0, ...values));
  const x = (i: number) => ((i + 0.5) / count) * 100;
  const y = (v: number) => 100 - (v / top) * 100;
  const coords = points.map((point, i) => ({ x: Math.round(x(i) * 100) / 100, y: Math.round(y(point.value) * 100) / 100 }));

  let line = coords.length ? `M${coords[0].x},${coords[0].y}` : "";
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i - 1];
    const q = coords[i];
    const c = (p.x + q.x) / 2;
    line += ` C${c},${p.y} ${c},${q.y} ${q.x},${q.y}`;
  }
  const area = coords.length ? `${line} L${coords[last].x},100 L${coords[0].x},100 Z` : "";
  const grid = [0, 1, 2].map((i) => ({ value: Math.round((top / 2) * i), pct: i * 50 }));
  const activeCoord = coords[active];
  const latest = values[last] ?? 0;
  const delta = count > 1 ? latest - values[last - 1] : 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <div className="text-right">
          <div className="text-[28px] font-bold leading-[1.1] tabular-nums text-ink">{latest.toLocaleString()}</div>
          {deltaSuffix && count > 1 && (
            <span
              className={`mt-1 inline-flex h-[22px] items-center rounded-full px-2 text-xs font-semibold ${
                delta > 0 ? "bg-[#DCFCE7] text-[#166534]" : delta < 0 ? "bg-danger-bg text-danger" : "bg-app text-muted"
              }`}
            >
              {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} {Math.abs(delta).toLocaleString()} {deltaSuffix}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-stretch gap-2 pt-8">
        <div className="relative h-[170px] w-8 shrink-0" aria-hidden="true">
          {grid.map((g) => (
            <span
              key={g.pct}
              className="absolute right-0 translate-y-1/2 text-xs leading-none tabular-nums text-muted"
              style={{ bottom: `${g.pct}%` }}
            >
              {g.value}
            </span>
          ))}
        </div>
        <div className="relative h-[170px] min-w-0 flex-1">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="dd-chart absolute inset-0 h-full w-full overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#850019" stopOpacity=".14" />
                <stop offset="100%" stopColor="#850019" stopOpacity="0" />
              </linearGradient>
            </defs>
            {grid.map((g, i) => (
              <line
                key={g.pct}
                x1="0"
                x2="100"
                y1={100 - g.pct}
                y2={100 - g.pct}
                stroke={i === 0 ? "#CBD5E1" : "#E2E5EA"}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={area} fill={`url(#${gradientId})`} />
            <path
              d={line}
              fill="none"
              stroke="#850019"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {activeCoord && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-0 border-l border-dashed border-brand/45"
              style={{ left: `${activeCoord.x}%` }}
            />
          )}
          {coords.map((c, i) => {
            const on = i === active;
            return (
              <span
                key={i}
                aria-hidden="true"
                className={`pointer-events-none absolute z-[1] box-border rounded-full ${
                  on
                    ? "-ml-[7px] -mt-[7px] h-3.5 w-3.5 border-[3px] border-white bg-brand shadow-[0_0_0_4px_rgba(133,0,25,0.15)]"
                    : "-ml-1 -mt-1 h-2 w-2 border-2 border-brand bg-white"
                }`}
                style={{ left: `${c.x}%`, top: `${c.y}%` }}
              />
            );
          })}
          {activeCoord && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-[2] whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-center text-white shadow-[0_8px_24px_rgba(17,24,39,0.25)]"
              style={{
                left: `${Math.min(Math.max(activeCoord.x, 16), 84)}%`,
                top: `${activeCoord.y}%`,
                transform: "translate(-50%, -100%) translateY(-14px)",
              }}
            >
              <div className="text-xs text-[#D1D5DB]">{points[active].fullLabel}</div>
              <div className="text-sm font-semibold">
                {points[active].value.toLocaleString()} {unit}
              </div>
            </div>
          )}
          <div className="absolute inset-0 z-[3] flex">
            {points.map((point, i) => (
              <button
                key={point.fullLabel}
                type="button"
                aria-label={`${point.fullLabel}: ${point.value} ${noun}`}
                onMouseEnter={() => setHovered(i)}
                onFocus={() => setHovered(i)}
                onClick={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onBlur={() => setHovered(null)}
                className="h-full flex-1 cursor-pointer rounded-md border-0 bg-transparent p-0"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-2" aria-hidden="true">
        <div className="w-8 shrink-0" />
        <div className="flex flex-1">
          {points.map((point, i) => (
            <span
              key={point.fullLabel}
              className={`flex-1 text-center text-[13px] ${i === active ? "font-semibold text-ink" : "text-muted"}`}
            >
              {point.label}
            </span>
          ))}
        </div>
      </div>
      <span className="sr-only">
        {title} by month, from {values[0] ?? 0} in {points[0]?.fullLabel} to {latest} in {points[last]?.fullLabel}.
      </span>
      {legend && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span className="h-[3px] w-3 rounded-sm bg-brand" />
          {legend}
        </div>
      )}
    </div>
  );
}
