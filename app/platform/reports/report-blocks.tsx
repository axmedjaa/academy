"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

/*
 * Building blocks for /platform/reports, taken from the REPORTS screen of the
 * Claude Design file "Platform Console.dc.html" (the `isReports` block and its
 * `rp()` view model). Colours, sizes and breakpoints are copied from that file:
 *   - "wide"   = viewport >= 1025px (two-column section grids, hero spans 2 rows)
 *   - "mobile" = viewport <  640px  (tables become cards, smaller chart canvases)
 */

/* ------------------------------------------------------------------ */
/* Shared styles                                                       */
/* ------------------------------------------------------------------ */

export const CARD =
  "min-w-0 rounded-xl border border-[#E2E5EA] bg-white p-6 shadow-[0_1px_3px_rgba(17,24,39,.07),0_1px_2px_rgba(17,24,39,.04)]";

export const CARD_TITLE = "text-base font-semibold tracking-[-0.005em] text-[#111827]";
export const CARD_SUB = "mt-0.5 text-[13px] text-[#4B5563]";

/** Burgundy-to-gold rule used on the header and every section heading. */
export const BRAND_RULE = "linear-gradient(90deg,#850019 0 72%,#F5B638 72% 100%)";

export const PCT_PILL =
  "min-w-[44px] rounded-md border border-[#E2E5EA] bg-[#F7F8FA] px-1.5 py-px text-center text-xs tabular-nums";

export const SECONDARY_BTN =
  "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-[#CBD5E1] bg-white px-4 text-sm font-semibold text-[#111827] transition-colors duration-150 hover:border-[#850019] hover:bg-[#FCF5F6] hover:text-[#850019] disabled:cursor-not-allowed disabled:opacity-50";

export const HATCH = "repeating-linear-gradient(135deg,#F9E8EC 0 3px,#fff 3px 6px)";

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** "$60,640" — amounts summed as recorded; currencies are not converted. */
export function money(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

/** "$28,172.48" */
export function money2(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Axis label: "$2.5k", "$750". */
function moneyAxis(cents: number): string {
  const v = cents / 100;
  return v >= 1000 ? "$" + (v / 1000).toFixed(1).replace(".0", "") + "k" : "$" + Math.round(v);
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

function niceCeil(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
  return ([1, 2, 2.5, 5, 10].find((k) => k * p >= v) ?? 10) * p;
}

/* ------------------------------------------------------------------ */
/* Viewport                                                            */
/* ------------------------------------------------------------------ */

function subscribe(query: string) {
  return (cb: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  };
}

const MOBILE_QUERY = "(max-width: 639px)";
const subscribeMobile = subscribe(MOBILE_QUERY);

/** The design's `mobile` flag (viewport under 640px). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ */
/* Headings, notices                                                   */
/* ------------------------------------------------------------------ */

export function SectionHeading({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="relative mb-6 border-t border-[#E2E5EA] pt-[22px]">
      <span aria-hidden="true" className="absolute -top-0.5 left-0 h-[3px] w-14" style={{ background: BRAND_RULE }} />
      <h2 id={id} className="m-0 text-2xl font-bold leading-[1.2] tracking-[-0.01em] text-[#111827]">
        {title}
      </h2>
      <div className="mt-1.5 max-w-[720px] text-sm leading-[1.55] text-[#4B5563]">{children}</div>
    </div>
  );
}

/** Grey "i" card the design shows to platform admins in owner-only sections. */
export function Restricted({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className={`${CARD} flex items-center gap-3 !bg-[#F7F8FA]`}>
      <span aria-hidden="true" className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-[#EEF0F3] font-bold text-[#374151]">
        i
      </span>
      <div>
        <div className="font-semibold text-[#111827]">{title}</div>
        <div className="text-[13px] text-[#6B7280]">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

/** Grey track with a burgundy selected pill (date range, group-by tabs). */
export function PillGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  asTabs,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  asTabs?: boolean;
}) {
  return (
    <div
      role={asTabs ? "tablist" : "group"}
      aria-label={label}
      className={
        asTabs
          ? "grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-1 rounded-xl border border-[#E2E5EA] bg-[#F1F3F6] p-1"
          : "flex flex-[1_1_280px] gap-1 rounded-xl border border-[#E2E5EA] bg-[#F1F3F6] p-1"
      }
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={asTabs ? "tab" : undefined}
            aria-selected={asTabs ? on : undefined}
            aria-pressed={asTabs ? undefined : on}
            disabled={disabled}
            onClick={() => !on && onChange(option.value)}
            className={`min-w-0 whitespace-nowrap px-2.5 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed ${
              asTabs ? "min-h-10 rounded-[9px]" : "h-9 flex-auto rounded-lg tracking-[0.01em] tabular-nums"
            } ${on ? "bg-[#850019] text-white shadow-[0_1px_3px_rgba(133,0,25,.35)]" : "text-[#374151] hover:bg-[#E5E7EB]"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const PAGER_BTN =
  "h-10 rounded-lg border border-[#CBD5E1] bg-white px-3 text-[13px] font-medium text-[#111827] disabled:cursor-not-allowed disabled:opacity-40";

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#E2E5EA] pt-3">
      <button type="button" className={PAGER_BTN} disabled={page <= 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
        Previous
      </button>
      <div className="text-center text-[13px] text-[#374151]">
        Page {page + 1} of {pages}
      </div>
      <button type="button" className={PAGER_BTN} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">
        Next
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bars                                                                */
/* ------------------------------------------------------------------ */

/** Pill, bar, count, percentage — status distribution and lifecycle rows. */
export function BarRow({
  label,
  bg,
  fg,
  n,
  total,
  mobile,
}: {
  label: string;
  bg: string;
  fg: string;
  n: number;
  total: number;
  mobile: boolean;
}) {
  const width = total > 0 ? `${(n / total) * 100}%` : "0%";
  return (
    <div
      className="grid items-center gap-3"
      style={{ gridTemplateColumns: mobile ? "auto minmax(40px,1fr) 28px 48px" : "150px minmax(0,1fr) 32px 52px" }}
    >
      <span className="justify-self-start whitespace-nowrap rounded-full px-2.5 py-[3px] text-xs font-semibold" style={{ background: bg, color: fg }}>
        {label}
      </span>
      <span className="block h-2 rounded bg-[#F1F3F6]">
        <span className="block h-2 rounded bg-[#850019]" style={{ width }} />
      </span>
      <span className="text-right font-semibold tabular-nums text-[#111827]">{n.toLocaleString("en-US")}</span>
      <span className={PCT_PILL}>{pct(n, total)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

export interface TipRow {
  l: string;
  v: string;
}

/**
 * The design's `chart()` helper: an SVG drawn on a fixed viewBox that scales
 * to the card width, with HTML axis labels laid over it in percentages and a
 * dark tooltip on hover or keyboard focus.
 */
export function TrendChart({
  labels,
  titles,
  series,
  kind,
  isMoney,
  small,
  mobile,
  ariaLabel,
  tip,
}: {
  /** Short axis labels, one per month ("Oct 26"). */
  labels: string[];
  /** Tooltip titles, one per month. */
  titles: string[];
  /** series[0] is the solid line / bars; series[1] the dashed "expected" line. */
  series: number[][];
  kind: "line" | "bar";
  isMoney: boolean;
  small: boolean;
  mobile: boolean;
  ariaLabel: string;
  tip: (index: number) => TipRow[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const W = small ? (mobile ? 330 : 480) : mobile ? 340 : 720;
  const H = small ? 210 : 330;
  const pL = isMoney ? 46 : 30;
  const pR = 8;
  const pT = 12;
  const pB = 40;
  const pw = W - pL - pR;
  const ph = H - pT - pB;
  const mx = Math.max(0, ...series.flat());
  const top = isMoney ? niceCeil(mx || 100) : Math.max(2, Math.ceil(mx / 2) * 2);
  const ticks = isMoney ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  const grid = ticks.map((t) => {
    const y = pT + ph * (1 - t);
    return { y, ly: `${(y / H) * 100}%`, t: isMoney ? moneyAxis(top * t) : String(Math.round(top * t * 100) / 100) };
  });
  const labelWidth = `${((pL - 6) / W) * 100}%`;
  const step = Math.max(1, Math.ceil(n / (mobile ? 4 : small ? 5 : 6)));
  const band = n > 0 ? pw / n : pw;
  const pos = (i: number) => (kind === "line" ? (n <= 1 ? pL + pw / 2 : pL + (pw * i) / (n - 1)) : pL + band * i + band / 2);
  const xl = labels
    .map((t, i) => ({ i, t, lx: `${(pos(i) / W) * 100}%`, tf: i === n - 1 ? "translateX(-100%)" : i === 0 ? "none" : "translateX(-50%)" }))
    .filter((g) => (n - 1 - g.i) % step === 0);

  const yOf = (v: number) => pT + ph * (1 - v / top);
  const smooth = (pts: [number, number][]) =>
    pts
      .map((p, i) => {
        if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        const q = pts[i - 1];
        const m = ((q[0] + p[0]) / 2).toFixed(1);
        return `C${m},${q[1].toFixed(1)} ${m},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      })
      .join(" ");

  const pts = kind === "line" ? series[0].map((v, i) => [pos(i), yOf(v)] as [number, number]) : [];
  const pts2 = kind === "line" && series[1] ? series[1].map((v, i) => [pos(i), yOf(v)] as [number, number]) : null;
  const line = pts.length ? smooth(pts) : "";
  const area = pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)},${pT + ph} L${pts[0][0].toFixed(1)},${pT + ph} Z` : "";
  const last = pts.at(-1);

  const bw = Math.min(band * 0.7, 26);
  const bars =
    kind === "bar"
      ? series[0].map((v, i) => {
          const h = v > 0 ? Math.max(2, (v / top) * ph) : 0;
          return { x: pL + band * i + (band - bw) / 2, y: pT + ph - h, w: bw, h };
        })
      : [];

  const hw = kind === "line" ? (n <= 1 ? pw : pw / (n - 1)) : band;
  const tw = small ? 150 : 164;
  let tipBox: { lx: string; ly: string; tf: string } | null = null;
  if (hover != null && hover < n) {
    const cx = pos(hover);
    const flip = cx + hw / 2 + 8 + tw > W - 4;
    const ax = flip ? cx - hw / 2 - 8 : cx + hw / 2 + 8;
    tipBox = { lx: `${(ax / W) * 100}%`, ly: `${((pT + 4) / H) * 100}%`, tf: flip ? "translateX(-100%)" : "none" };
  }
  const gradId = `rpGA-${small ? "s" : "l"}-${kind}`;
  const barId = `rpG1-${small ? "s" : "l"}`;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={ariaLabel} className="block h-auto max-w-full">
        <defs>
          <linearGradient id={barId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#A3203A" />
            <stop offset="1" stopColor="#850019" />
          </linearGradient>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#850019" stopOpacity=".3" />
            <stop offset="1" stopColor="#850019" stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((g) => (
          <line key={g.y} x1={pL} x2={W - pR} y1={g.y} y2={g.y} stroke="#EEF0F3" />
        ))}
        {kind === "bar" &&
          bars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={`url(#${barId})`} />)}
        {kind === "line" && pts.length > 0 && (
          <>
            <path d={area} fill={`url(#${gradId})`} />
            {pts2 && (
              <path d={smooth(pts2)} fill="none" stroke="#850019" strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" opacity={0.6} />
            )}
            <path d={line} fill="none" stroke="#850019" strokeWidth={small ? 2.5 : 3.5} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {hover != null && !pts2 && (
          <rect x={pos(hover) - hw / 2 + 2} y={pT} width={Math.max(0, hw - 4)} height={ph} rx={6} fill="#850019" opacity={0.07} pointerEvents="none" />
        )}
        {kind === "line" && last && !small && (
          <>
            <circle cx={last[0]} cy={last[1]} r={8} fill="#F5B638" opacity={0.4} />
            <circle cx={last[0]} cy={last[1]} r={4.5} fill="#850019" stroke="#fff" strokeWidth={2} />
          </>
        )}
        {kind === "line" && last && small && <circle cx={last[0]} cy={last[1]} r={5} fill="#850019" stroke="#fff" strokeWidth={2} />}
        {hover != null && pts2 && (
          <>
            <line x1={pos(hover)} x2={pos(hover)} y1={pT} y2={pT + ph} stroke="#850019" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} pointerEvents="none" />
            <circle cx={pts2[hover][0]} cy={pts2[hover][1]} r={4.5} fill="#fff" stroke="#850019" strokeWidth={2} opacity={0.7} pointerEvents="none" />
          </>
        )}
        {hover != null && kind === "line" && pts[hover] && (
          <circle cx={pts[hover][0]} cy={pts[hover][1]} r={5} fill="#fff" stroke="#850019" strokeWidth={2.5} pointerEvents="none" />
        )}
        {labels.map((_, i) => (
          <rect
            key={i}
            x={pos(i) - hw / 2}
            y={pT}
            width={hw}
            height={ph}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={`${titles[i]}: ${tip(i)
              .map((r) => `${r.l} ${r.v}`)
              .join(", ")}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            className="outline-none"
          />
        ))}
      </svg>
      {grid.map((g) => (
        <span
          key={g.y}
          className="pointer-events-none absolute left-0 -translate-y-1/2 text-right text-[13px] font-medium leading-none tabular-nums text-[#374151]"
          style={{ top: g.ly, width: labelWidth }}
        >
          {g.t}
        </span>
      ))}
      {xl.map((g) => (
        <span
          key={g.i}
          className="pointer-events-none absolute bottom-1.5 whitespace-nowrap text-[13px] font-medium leading-none text-[#374151]"
          style={{ left: g.lx, transform: g.tf }}
        >
          {g.t}
        </span>
      ))}
      {tipBox && hover != null && (
        <div
          className="pointer-events-none absolute z-[3] min-w-[150px] rounded-lg bg-[#111827] px-3.5 py-2.5 text-[13px] text-white shadow-[0_8px_24px_rgba(17,24,39,.25)]"
          style={{ left: tipBox.lx, top: tipBox.ly, transform: tipBox.tf }}
        >
          <div className="mb-1.5 text-xs font-semibold text-[#F5B638]">{titles[hover]}</div>
          {tip(hover).map((r) => (
            <div key={r.l} className="flex justify-between gap-4 leading-[1.6]">
              <span className="text-[#D1D5DB]">{r.l}</span>
              <span className="font-semibold tabular-nums">{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Plan adoption ring: 160px, radius 60, stroke 22 (26 when hovered). */
export function Donut({
  segments,
  total,
  hovered,
  onHover,
}: {
  segments: { key: string; label: string; n: number; color: string }[];
  total: number;
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  const C = 2 * Math.PI * 60;
  const gap = segments.length > 1 ? 3 : 0;
  const lengths = segments.map((s) => (total > 0 ? (s.n / total) * C : 0));
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  const sel = hovered != null ? segments[hovered] : null;
  return (
    <svg
      viewBox="0 0 160 160"
      width={160}
      height={160}
      className="flex-none"
      role="img"
      aria-label={`Academies by plan: ${segments.map((s) => `${s.label} ${s.n}`).join(", ")}`}
    >
      <circle cx={80} cy={80} r={60} fill="none" stroke="#F7F8FA" strokeWidth={22} />
      {segments.map((s, i) => {
        const dash = Math.max(lengths[i] - gap, 0.5);
        const off = -starts[i];
        return (
          <circle
            key={s.key}
            cx={80}
            cy={80}
            r={60}
            fill="none"
            stroke={s.color}
            strokeWidth={hovered === i ? 26 : 22}
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={off}
            transform="rotate(-90 80 80)"
            opacity={hovered == null || hovered === i ? 1 : 0.35}
            className="cursor-pointer outline-none transition-opacity duration-150"
            tabIndex={0}
            role="button"
            aria-label={`${s.label}: ${s.n} academies`}
            onMouseEnter={() => onHover(i)}
            onFocus={() => onHover(i)}
            onClick={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onBlur={() => onHover(null)}
          />
        );
      })}
      <text x={80} y={80} textAnchor="middle" fontSize={30} fontWeight={700} fill="#111827">
        {sel ? sel.n : total}
      </text>
      <text x={80} y={100} textAnchor="middle" fontSize={13} fill="#6B7280">
        {sel ? sel.label : "academies"}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Sortable table (desktop) and cards (mobile)                         */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  label: string;
  align: "left" | "right";
  sortValue: (row: T) => number | string;
  render: (row: T) => ReactNode;
  /** Design cell weight / colour, e.g. collected amounts in bold burgundy. */
  strong?: boolean;
  brand?: boolean;
}

export type SortState = { key: string; dir: "asc" | "desc" };

export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState): T[] {
  const column = columns.find((c) => c.key === sort.key);
  if (!column) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = column.sortValue(a);
    const y = column.sortValue(b);
    return (typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y)) * sign;
  });
}

/** Header click rule from the design: same column flips, a new column starts
 * ascending for the name column and descending for numbers. */
export function nextSort(current: SortState, key: string, firstKey: string): SortState {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === firstKey ? "asc" : "desc" };
}

export function SortTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  footer,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort: SortState;
  onSort: (key: string) => void;
  footer?: ReactNode[];
  label: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#E2E5EA]">
      <table aria-label={label} className="w-full table-auto border-collapse text-sm tabular-nums">
        <thead>
          <tr>
            {columns.map((c) => {
              const on = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className="border-b border-[#E2E5EA] bg-[#F7F8FA] p-0"
                  style={{ textAlign: c.align }}
                >
                  <button
                    type="button"
                    onClick={() => onSort(c.key)}
                    className="min-h-11 w-full whitespace-normal bg-transparent px-2.5 py-1.5 text-[11px] font-semibold uppercase leading-[1.2] tracking-[0.03em] text-[#374151] hover:text-[#850019]"
                    style={{ textAlign: c.align }}
                  >
                    {c.label}{" "}
                    <span aria-hidden="true" style={{ color: on ? "#850019" : "#9CA3AF" }}>
                      {on ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="transition-colors duration-150 hover:bg-[#FCF5F6]">
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className="border-t border-[#E2E5EA] px-2.5 py-3.5 [overflow-wrap:anywhere]"
                  style={{
                    textAlign: c.align,
                    fontWeight: i === 0 ? 600 : c.strong ? 600 : 400,
                    color: c.brand ? "#850019" : "#111827",
                  }}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="bg-[#F7F8FA]">
              {footer.map((cell, i) => (
                <td
                  key={i}
                  className="border-t-2 border-[#850019] px-2.5 py-3.5 font-bold text-[#111827]"
                  style={{ textAlign: columns[i]?.align ?? "right" }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Mobile row card: title and a burgundy headline amount, details below. */
export function RowCard({ title, amount, children, total }: { title: string; amount: string; children: ReactNode; total?: boolean }) {
  return (
    <div
      className={`rounded-xl px-4 py-3.5 ${total ? "border border-[#E9C3CC] bg-[#F9E8EC]" : "border border-[#E2E5EA] bg-white"}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-[15px] [overflow-wrap:anywhere] ${total ? "font-bold" : "font-semibold"}`}>{title}</span>
        <span className="text-xl font-bold tabular-nums text-[#850019]">{amount}</span>
      </div>
      {children}
    </div>
  );
}

export function CardFacts({ children, total }: { children: ReactNode; total?: boolean }) {
  return (
    <div
      className={`mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 border-t pt-2 text-[13px] text-[#4B5563] ${
        total ? "border-[rgba(133,0,25,.2)]" : "border-[#EEF0F3]"
      }`}
    >
      {children}
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <strong className="text-[#111827]">{value}</strong>
    </span>
  );
}
