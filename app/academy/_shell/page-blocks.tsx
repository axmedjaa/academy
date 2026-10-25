import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Page-level building blocks shared by the Academy Console pages, each one a
 * direct translation of a block type from the active design's page template
 * (Platform Console.dc.html `isAcList`, fed by academy-engine.js `view()`):
 * `bento`, `note`, the table's person / progress cells, and the table frame
 * that turns into stacked cards on narrow content widths. Server-safe: no
 * client state, so pages stay server-rendered.
 */

/** Design `bento`: one tinted hero metric beside a column of compact side
 * metrics. Collapses to one column on narrow content widths. */
export function StatBento({
  hero,
  side,
}: {
  hero: { label: string; value: ReactNode; hint?: ReactNode; icon: string; href?: string };
  side: { label: string; value: ReactNode; hint?: ReactNode; icon: string; tone?: "brand" | "gold" | "slate"; href?: string }[];
}) {
  const heroBody = (
    <>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-brand">
          <Icon name={hero.icon} />
        </span>
        <span className="min-w-0 font-semibold text-ink">{hero.label}</span>
      </div>
      <div>
        <div className="text-[44px] font-bold leading-none tracking-[-0.02em] text-brand tabular-nums sm:text-[56px]">
          {hero.value}
        </div>
        {hero.hint && <div className="mt-2 text-[#374151]">{hero.hint}</div>}
      </div>
    </>
  );
  const heroClass =
    "flex min-w-0 flex-col justify-center gap-5 rounded-2xl border border-border bg-[linear-gradient(135deg,#F9E8EC_0%,#E9C3CC_100%)] p-6 !text-ink no-underline hover:no-underline";
  return (
    <div className="@container mb-8">
      <div className="dd-grid grid grid-cols-1 gap-6 @[520px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {hero.href ? (
          <Link href={hero.href} className={heroClass}>
            {heroBody}
          </Link>
        ) : (
          <div className={heroClass}>{heroBody}</div>
        )}
        <div className="flex min-w-0 flex-col gap-5">
          {side.map((item) => {
            const tone = SIDE_TONE[item.tone ?? "brand"];
            const body = (
              <>
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${tone}`}>
                  <Icon name={item.icon} />
                </span>
                <span className="min-w-0 flex-auto">
                  <span className="block text-[13px] leading-snug text-[#374151]">{item.label}</span>
                  {item.hint && <span className="block text-xs text-muted">{item.hint}</span>}
                </span>
                <span className="shrink-0 whitespace-nowrap text-[22px] font-bold tabular-nums text-ink">{item.value}</span>
              </>
            );
            const cls =
              "dd-lift flex min-w-0 items-center gap-3.5 rounded-card border border-border bg-surface px-[18px] py-3.5 shadow-card !text-ink no-underline hover:no-underline";
            return item.href ? (
              <Link key={item.label} href={item.href} className={cls}>
                {body}
              </Link>
            ) : (
              <div key={item.label} className={cls}>
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SIDE_TONE = {
  brand: "bg-brand-tint text-brand",
  gold: "bg-[rgba(245,182,56,0.28)] text-ink",
  slate: "bg-[#EEF2F6] text-[#374151]",
} as const;

/** Design `note`: a quiet amber explanation under a section. */
export function NoteBlock({ children }: { children: ReactNode }) {
  return (
    <div className="mb-8 flex gap-3 rounded-card border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-[13px] text-[#78350F]">
      {children}
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** Design table `person` cell: 40px avatar (photo or initials), the name as
 * a brand-coloured link, and a muted sub-line. */
export function PersonCell({
  name,
  sub,
  href,
  photoUrl,
}: {
  name: string;
  sub?: ReactNode;
  href?: string;
  photoUrl?: string | null;
}) {
  const avatar = photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img>
    <img src={photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full border-2 border-white object-cover shadow-[0_0_0_1px_#E2E5EA]" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[13px] font-bold text-brand">
      {initialsOf(name)}
    </span>
  );
  const text = (
    <span className="flex min-w-0 flex-col justify-center gap-0.5">
      <span className="font-semibold leading-snug text-brand [overflow-wrap:anywhere]">{name}</span>
      {sub && <span className="text-xs leading-snug text-muted">{sub}</span>}
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-3">
      {avatar}
      {href ? (
        <Link href={href} className="min-h-11 min-w-0 flex items-center no-underline hover:no-underline">
          {text}
        </Link>
      ) : (
        text
      )}
    </span>
  );
}

/** Design table `prog` cell: a 6px progress bar with a caption under it. */
export function FeeProgress({ percent, caption }: { percent: number; caption: ReactNode }) {
  const width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  return (
    <span className="block min-w-0 flex-1">
      <span className="block h-1.5 overflow-hidden rounded-full bg-[#EEF0F3]">
        <span className="block h-1.5 rounded-full bg-brand" style={{ width }} />
      </span>
      <span className="mt-1 block text-xs tabular-nums text-[#374151]">{caption}</span>
    </span>
  );
}

/**
 * The design's table frame: white card, uppercase 12px header on #FAFBFC.
 * When its own container is narrower than `stackBelow`, rows become the
 * design's stacked cards (each cell labelled from its `data-label`) — the
 * same rule the design applies when the columns no longer fit. Cells opt in
 * with `data-label="…"`; `data-actions` right-aligns a buttons cell.
 */
export function DataTable({
  stackBelow = 900,
  children,
  footer,
}: {
  stackBelow?: 600 | 760 | 900 | 1040;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={`rt-wrap mb-8 rt-${stackBelow}`}>
      <div className="rt-frame overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <table className="rt w-full border-collapse text-sm">{children}</table>
      </div>
      {footer}
    </div>
  );
}

export const rtTh =
  "border-b border-border bg-[#FAFBFC] px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.04em] text-[#374151]";
export const rtTd = "border-b border-border px-4 py-3 align-middle text-ink";

/** Design `kv`: a titled card of label / value rows (detail pages). Labels
 * sit in a fixed column on wide cards and above their value when narrow. */
export function KvCard({
  title,
  rows,
  actions,
}: {
  title: string;
  rows: [label: string, value: ReactNode][];
  actions?: ReactNode;
}) {
  return (
    <section className="@container mb-8 rounded-card border border-border bg-surface px-5 pb-2 pt-4 shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-1 gap-1 border-b border-border py-3 last:border-b-0 @[520px]:grid-cols-[176px_minmax(0,1fr)] @[520px]:gap-4"
          >
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="min-w-0 text-sm text-ink [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Design table `title`: the 15px heading that sits above a titled table. */
export function BlockTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-[15px] font-semibold text-ink">{children}</h2>
      {actions}
    </div>
  );
}

/** Design table row buttons: 40px, 13px semibold; primary is burgundy,
 * danger is the outlined red the design uses for reversible-but-serious
 * actions (Reverse, Cancel). */
export const ROW_BTN =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold !text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline disabled:cursor-not-allowed disabled:opacity-50";
export const ROW_BTN_PRIMARY =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border-0 bg-brand px-3.5 text-[13px] font-semibold !text-white no-underline transition-colors duration-150 hover:bg-brand-hover hover:no-underline disabled:cursor-not-allowed disabled:opacity-50";
export const ROW_BTN_DANGER =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 text-[13px] font-semibold !text-[#B91C1C] no-underline transition-colors duration-150 hover:bg-[#FEE2E2] hover:no-underline disabled:cursor-not-allowed disabled:opacity-50";

/** Design table `chip`: a tinted pill with a leading icon (finance
 * categories, payment methods). */
export function Chip({ label, icon, tone = "slate" }: { label: string; icon: string; tone?: keyof typeof SIDE_TONE }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold ${SIDE_TONE[tone]}`}>
      <Icon name={icon} width={15} height={15} className="shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </span>
  );
}

/** Design `tabs`: pill tabs. Each tab is a link (`?tab=…`), so the page
 * reads only what the open tab shows and the tab survives a reload. */
export function TabLinks({
  tabs,
  current,
  label,
}: {
  tabs: { key: string; label: string; href: string }[];
  current: string;
  label: string;
}) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={label} className="mb-6 flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            scroll={false}
            className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-[15px] font-semibold no-underline transition-colors duration-150 hover:no-underline ${
              on ? "bg-brand-tint !text-brand" : "!text-[#374151] hover:bg-app"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Design `charts` card shell: title and caption above a chart. */
function ChartCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Design `bars` chart: one labelled horizontal bar per row, scaled to the
 * largest value, with the value written out (never colour alone). */
export function BarList({
  title,
  sub,
  rows,
  empty = "Nothing to show yet.",
}: {
  title: string;
  sub?: string;
  rows: { label: string; value: number; text: string; muted?: boolean }[];
  empty?: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ChartCard title={title} sub={sub}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{empty}</p>
      ) : (
        // Design: label, bar and value on one line, at every width.
        <ul role="list" aria-label={title} className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.label}
              className="grid min-w-0 grid-cols-[minmax(6rem,1fr)_minmax(2.5rem,10rem)_auto] items-center gap-x-3 text-[13px]"
            >
              <span className="min-w-0 break-words text-[#374151]">{row.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-[#EEF0F3]" aria-hidden="true">
                <span
                  className={`block h-full rounded-full ${row.muted ? "bg-[#9CA3AF]" : "bg-brand"}`}
                  style={{ width: `${row.value > 0 ? Math.max(4, Math.round((row.value / max) * 100)) : 0}%` }}
                />
              </span>
              <span className="min-w-[2ch] text-right font-semibold tabular-nums text-ink">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}

const STACK_COLORS = ["bg-brand", "bg-[#F5B638]", "bg-[#CBD5E1]", "bg-[#9CA3AF]"];

/** Design `stack` chart: one bar split into shares, with a legend that
 * states each value and share. */
export function StackBar({
  title,
  sub,
  segments,
  empty = "Nothing to show yet.",
}: {
  title: string;
  sub?: string;
  segments: { label: string; value: number; text: string; color?: string }[];
  empty?: string;
}) {
  const colorOf = (i: number) => segments[i]?.color ?? STACK_COLORS[i % STACK_COLORS.length];
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <ChartCard title={title} sub={sub}>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{empty}</p>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-full bg-[#EEF0F3]" aria-hidden="true">
            {segments.map((segment, i) =>
              segment.value > 0 ? (
                <div
                  key={segment.label}
                  className={`${colorOf(i)} h-full border-r-2 border-white last:border-r-0`}
                  style={{ width: `${(segment.value / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <ul role="list" aria-label={title} className="mt-4 flex flex-col gap-2.5">
            {segments.map((segment, i) => (
              <li key={segment.label} className="flex items-center gap-2.5 text-[13px]">
                <span className={`h-3 w-3 shrink-0 rounded-sm ${colorOf(i)}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-[#374151]">{segment.label}</span>
                <span className="font-semibold tabular-nums text-ink">{segment.text}</span>
                <span className="w-11 text-right tabular-nums text-muted">{Math.round((segment.value / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}

/** Design `stats`: a row of compact metric cards on a 24px gap. */
export function StatRow({ items }: { items: { label: string; value: ReactNode; hint?: ReactNode; icon: string }[] }) {
  // Design `stat` card: label top left, icon tile top right, the value
  // large underneath and a muted hint; one row of equal cards when there
  // is room, two columns on tablets, one on phones.
  return (
    <div className="@container mb-8">
      <div className="grid grid-cols-1 gap-6 @[480px]:grid-cols-2 @[880px]:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card">
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0 pt-1 text-[13px] leading-snug text-[#374151]">{item.label}</span>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-tint text-brand">
                <Icon name={item.icon} width={20} height={20} />
              </span>
            </span>
            <span className="mt-3 block text-[28px] font-bold leading-tight tracking-[-0.01em] tabular-nums text-ink [overflow-wrap:anywhere]">
              {item.value}
            </span>
            {item.hint && <span className="mt-1.5 block text-xs text-muted">{item.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
