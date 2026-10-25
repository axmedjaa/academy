import type { ReactNode } from "react";
import { color } from "@/lib/ui/theme";

/**
 * Shared chart primitives for `/academy/*` report/dashboard screens —
 * DESIGN.md §9.9's "a simple chart only where the data is genuinely
 * aggregate/trend... chart never replaces the table" rule. Plain inline SVG,
 * no charting library (none exists in this codebase's package.json, and the
 * handful of these charts don't justify one) — server-renderable, with every
 * interactive touch (hover tooltips, the entrance motion) done in pure CSS
 * so no "use client" boundary or chart-specific JS is needed anywhere this
 * is used. Colors come from lib/ui/theme.ts's existing tokens, never new hex
 * values, and never red/green/amber — this file deliberately stays off the
 * §1 status palette (those three colors mean "rejected," "approved," and
 * "pending" everywhere else in the product; a chart bar for "Expenses" is
 * not a status and must not borrow red's meaning by accident).
 *
 * Both chart types below render nothing when given no points — callers
 * already have their own SimpleTable's own "no data" EmptyState for the
 * section, so the empty message here is a short, plain fallback line, not a
 * second EmptyState.
 */

const VIEW_WIDTH = 640;
const MARGIN = { top: 28, right: 20, bottom: 28, left: 8 };

/**
 * Both chart types below render their `<svg>` inside this exact wrapper —
 * same `overflow-x-auto` + fixed `min-w-[640px]` shape as `TableWrap`
 * (app/academy/_shell/ui.tsx), applied for the same reason: an SVG sized by
 * `viewBox` + `width:100%` alone would shrink its TEXT along with everything
 * else on a narrow phone (a nominal 10px label becomes genuinely
 * unreadable once the whole 640-unit viewBox is squeezed into a ~250px
 * mobile content width). Pinning the rendered width to never go below the
 * viewBox's own 640 units means the SVG only ever scales up (harmless) or
 * renders 1:1 — mobile scrolls horizontally to see the rest, exactly like
 * every data table in this app already does, rather than ever rendering
 * illegibly small.
 */
function ChartScrollArea({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">{children}</div>
    </div>
  );
}

/** Rounds a value up to a visually clean axis ceiling (1/2/5 × 10^n) — the
 * same "nice numbers" approach any axis-drawing library uses, so gridlines
 * land on round figures instead of whatever the data's real max happens to
 * be. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const residual = value / magnitude;
  const niceResidual =
    residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return niceResidual * magnitude;
}

function formatPoint(value: number, display?: string): string {
  return display ?? String(value);
}

export interface ChartPoint {
  label: string;
  value: number;
  /** Exact string shown in the value label/tooltip — defaults to the raw
   * number when omitted. Pass this for a percentage suffix or a
   * currency-formatted amount, since the right format can vary per caller
   * (and, for money, per currency within the same chart). */
  display?: string;
}

/**
 * A smooth gradient-filled trend line for genuinely continuous/time-series
 * data (e.g. monthly enrollment counts) — one series only, by design: a
 * second line on the same axis is a different chart, not this one.
 *
 * `id` must be unique per rendered instance (there's no client-side
 * `useId()` available — this is a plain server-rendered SVG) since it
 * namespaces the `<linearGradient>`/clip-path ids; two charts sharing an id
 * on the same page would silently steal each other's gradient.
 */
export function TrendAreaChart({
  id,
  points,
  ariaLabel,
  emptyMessage,
  lineColor = color.primaryBlue,
  formatAxisValue = String,
}: {
  id: string;
  points: ChartPoint[];
  ariaLabel: string;
  emptyMessage: string;
  lineColor?: string;
  /** Formats the one axis-scale label (the ceiling value, top-left) —
   * defaults to the raw number, which is wrong whenever `value` isn't
   * already a plain display number (e.g. money charts, where `value` is
   * cents — see BarChart's own identical prop and IncomeExpenseChart's
   * caller for the bug this fixes). */
  formatAxisValue?: (value: number) => string;
}) {
  if (points.length === 0) {
    return <p className="text-sm text-muted">{emptyMessage}</p>;
  }

  const height = 220;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const ceiling = niceCeiling(maxValue);

  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const coords = points.map((point, i) => ({
    x: MARGIN.left + (points.length > 1 ? i * xStep : plotWidth / 2),
    y: MARGIN.top + plotHeight - (point.value / ceiling) * plotHeight,
    point,
  }));

  const linePath = buildSmoothPath(coords);
  const baselineY = MARGIN.top + plotHeight;
  const areaPath =
    coords.length > 0
      ? `${linePath} L${coords[coords.length - 1].x},${baselineY} L${coords[0].x},${baselineY} Z`
      : "";

  const gridFractions = [0, 0.5, 1];
  const last = coords[coords.length - 1];

  return (
    <ChartScrollArea>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        role="img"
        aria-label={ariaLabel}
        className="block h-auto w-full"
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridFractions.map((fraction) => {
          const y = MARGIN.top + plotHeight * (1 - fraction);
          return (
            <line
              key={fraction}
              x1={MARGIN.left}
              x2={VIEW_WIDTH - MARGIN.right}
              y1={y}
              y2={y}
              stroke={color.border}
              strokeWidth={1}
            />
          );
        })}
        <text
          x={MARGIN.left}
          y={MARGIN.top - 10}
          fontSize="10"
          fill={color.textMuted}
        >
          {formatAxisValue(ceiling)}
        </text>

        <path d={areaPath} fill={`url(#${id}-fill)`} />
        <path
          d={linePath}
          fill="none"
          stroke={lineColor}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="motion-safe:[stroke-dasharray:1] motion-safe:[stroke-dashoffset:1] motion-safe:animate-chart-draw"
        />

        {coords.map(({ x, y, point }, i) => (
          <g key={point.label + i} className="group">
            {/* Wide invisible hit-area — the visible dot is only 3px, far too
              small a hover target on its own. */}
            <rect
              x={MARGIN.left + i * xStep - xStep / 2}
              y={MARGIN.top}
              width={xStep || plotWidth}
              height={plotHeight}
              fill="transparent"
            />
            <line
              x1={x}
              x2={x}
              y1={MARGIN.top}
              y2={baselineY}
              stroke={color.borderStrong}
              strokeWidth={1}
              className="opacity-0 transition-opacity duration-150 group-hover:opacity-60"
            />
            <g
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
              className="transition-transform duration-150 group-hover:scale-150"
            >
              <circle
                cx={x}
                cy={y}
                r={3.5}
                fill={color.card}
                stroke={lineColor}
                strokeWidth={2}
              />
            </g>
            <g className="opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              <TooltipPill
                x={x}
                y={y - 14}
                text={formatPoint(point.value, point.display)}
              />
            </g>
            <text
              x={x}
              y={height - 8}
              fontSize="10"
              textAnchor={
                i === 0 ? "start" : i === coords.length - 1 ? "end" : "middle"
              }
              fill={color.textMuted}
            >
              {point.label}
            </text>
          </g>
        ))}

        {last && (
          <text
            x={Math.min(last.x, VIEW_WIDTH - MARGIN.right - 2)}
            y={Math.max(last.y - 12, 14)}
            fontSize="13"
            fontWeight={700}
            textAnchor="end"
            fill={color.text}
          >
            {formatPoint(last.point.value, last.point.display)}
          </text>
        )}
      </svg>
    </ChartScrollArea>
  );
}

export interface ChartSeries {
  name: string;
  color: string;
}

/**
 * Rounded-top bars for categorical aggregate data (pass rate by batch,
 * income vs. expenses by currency). One series draws a plain bar per group;
 * two series draw a side-by-side pair per group with a small color-key
 * legend above the chart — never more than two, which is already the most
 * this product's data ever genuinely compares at once.
 */
export function BarChart({
  id,
  series,
  groups,
  ariaLabel,
  emptyMessage,
  formatAxisValue = String,
}: {
  id: string;
  series: ChartSeries[];
  groups: { label: string; values: ChartPoint[] }[];
  ariaLabel: string;
  emptyMessage: string;
  /** Formats the one axis-scale label (the ceiling value, top-left) —
   * defaults to the raw number, which is wrong whenever `value` isn't
   * already a plain display number. `IncomeExpenseChart`
   * (finance-reports-view.tsx) passes `value` in CENTS (so the bars scale
   * correctly against each other) but needs this to show real dollars,
   * not a bare four-digit cents figure. */
  formatAxisValue?: (value: number) => string;
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted">{emptyMessage}</p>;
  }

  const height = 220;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const maxValue = Math.max(
    1,
    ...groups.flatMap((g) => g.values.map((v) => v.value)),
  );
  const ceiling = niceCeiling(maxValue);

  const slotWidth = plotWidth / groups.length;
  const barGap = 4;
  const barsPerSlot = series.length;
  const barWidth = Math.max(
    6,
    Math.min(44, (slotWidth - barGap * (barsPerSlot + 1)) / barsPerSlot),
  );
  const groupWidth = barWidth * barsPerSlot + barGap * (barsPerSlot - 1);

  const baselineY = MARGIN.top + plotHeight;
  const gridFractions = [0, 0.5, 1];

  return (
    <div className="flex flex-col gap-2">
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-4">
          {series.map((s) => (
            <span
              key={s.name}
              className="flex items-center gap-1.5 text-xs text-muted"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <ChartScrollArea>
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
          role="img"
          aria-label={ariaLabel}
          className="block h-auto w-full"
        >
          {gridFractions.map((fraction) => {
            const y = MARGIN.top + plotHeight * (1 - fraction);
            return (
              <line
                key={fraction}
                x1={MARGIN.left}
                x2={VIEW_WIDTH - MARGIN.right}
                y1={y}
                y2={y}
                stroke={color.border}
                strokeWidth={1}
              />
            );
          })}
          <text
            x={MARGIN.left}
            y={MARGIN.top - 10}
            fontSize="10"
            fill={color.textMuted}
          >
            {formatAxisValue(ceiling)}
          </text>

          {groups.map((group, groupIndex) => {
            const slotStart = MARGIN.left + groupIndex * slotWidth;
            const groupStart = slotStart + (slotWidth - groupWidth) / 2;
            return (
              <g key={group.label + groupIndex}>
                {group.values.map((point, seriesIndex) => {
                  const barX = groupStart + seriesIndex * (barWidth + barGap);
                  const barHeight = Math.max(
                    1,
                    (point.value / ceiling) * plotHeight,
                  );
                  const barY = baselineY - barHeight;
                  const barId = `${id}-${groupIndex}-${seriesIndex}`;
                  return (
                    <g key={barId} className="group">
                      <rect
                        x={barX - barGap / 2}
                        y={MARGIN.top}
                        width={barWidth + barGap}
                        height={plotHeight}
                        fill="transparent"
                      />
                      <g
                        style={{
                          transformBox: "fill-box",
                          transformOrigin: "bottom",
                          animationDelay: `${(groupIndex * barsPerSlot + seriesIndex) * 40}ms`,
                        }}
                        className="motion-safe:animate-chart-rise"
                      >
                        <path
                          d={roundedTopBarPath(
                            barX,
                            barY,
                            barWidth,
                            barHeight,
                            4,
                          )}
                          fill={series[seriesIndex]?.color ?? color.primaryBlue}
                          className="transition-opacity duration-150 group-hover:opacity-80"
                        />
                      </g>
                      <g className="opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <TooltipPill
                          x={barX + barWidth / 2}
                          y={barY - 12}
                          text={formatPoint(point.value, point.display)}
                        />
                      </g>
                    </g>
                  );
                })}
                <text
                  x={slotStart + slotWidth / 2}
                  y={height - 8}
                  fontSize="10"
                  textAnchor="middle"
                  fill={color.textMuted}
                >
                  {group.label.length > 10
                    ? `${group.label.slice(0, 9)}…`
                    : group.label}
                </text>
              </g>
            );
          })}
        </svg>
      </ChartScrollArea>
    </div>
  );
}

/** Dark ink pill + white text, anchored by its bottom-center point — the
 * one tooltip treatment shared by both chart types above (#111827, the
 * design's tooltip color; the old navy token is now the brand burgundy, so
 * it no longer reads as neutral chrome). The pill's CENTER
 * clamps to stay fully inside the viewBox — an edge point's tooltip would
 * otherwise spill past x=0 or x=VIEW_WIDTH and get clipped by the `<svg>`'s
 * own bounds. */
function TooltipPill({ x, y, text }: { x: number; y: number; text: string }) {
  const paddingX = 6;
  const charWidth = 6;
  const width = text.length * charWidth + paddingX * 2;
  const clampedX = Math.min(
    Math.max(x, width / 2 + 2),
    VIEW_WIDTH - width / 2 - 2,
  );
  return (
    <g>
      <rect
        x={clampedX - width / 2}
        y={y - 18}
        width={width}
        height={20}
        rx={5}
        fill={color.text}
      />
      <text
        x={clampedX}
        y={y - 4}
        fontSize="10"
        fontWeight={600}
        textAnchor="middle"
        fill="#FFFFFF"
      >
        {text}
      </text>
    </g>
  );
}

/** Catmull-Rom-to-cubic-Bezier spline through `coords`, tension 1/6 — the
 * standard conversion, not a from-scratch curve-fit — so the trend line
 * reads as one smooth stroke instead of the sharp polyline joints a plain
 * `L`-segment path would have. */
function buildSmoothPath(coords: { x: number; y: number }[]): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M${coords[0].x},${coords[0].y}`;

  let d = `M${coords[0].x},${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** A bar path with its top two corners rounded and the bottom edge square
 * (flush with the baseline) — `rect rx` rounds all four corners, which
 * looks wrong for a bar sitting on an axis. */
function roundedTopBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}
