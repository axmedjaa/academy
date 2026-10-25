import type { ReactNode } from "react";
import { PAGE_WRAP, PageHeader } from "./ui";
import { DataTable, rtTd, rtTh } from "./page-blocks";

/**
 * Loading skeletons for the Academy and account pages (route `loading.tsx`
 * files and in-page Suspense fallbacks).
 *
 * - The console shell (sidebar, top bar) comes from the layout and never
 *   shows a skeleton. Each page skeleton renders the page's real title and,
 *   when it does not depend on the viewer, its real description, so the
 *   heading stays in place while the data loads.
 * - Shapes reuse the real components' dimensions (the table skeleton is the
 *   real `DataTable` frame, so it stacks into cards at the same widths) to
 *   keep layout shift low when the content arrives.
 * - Bones are neutral grey, decorative (`aria-hidden`), and pulse only when
 *   the viewer allows motion. The region is `role="status"` with
 *   `aria-busy` and a screen-reader label.
 */

/** One decorative placeholder block. */
export function Bone({ className = "" }: { className?: string }) {
  // A rounding class passed in (rounded-full for avatars, ...) replaces the default.
  const rounding = /\brounded(-|\b)/.test(className) ? "" : "rounded-md";
  return <span aria-hidden="true" className={`block ${rounding} bg-[#EEF0F3] motion-safe:animate-pulse ${className}`} />;
}

/** The loading region: page width, status semantics, an accessible label. */
export function SkeletonPage({ label, wrap = PAGE_WRAP, children }: { label: string; wrap?: string; children: ReactNode }) {
  return (
    <div className={wrap} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

/** Content-only region (inside a page whose header is already on screen). */
export function SkeletonRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

/**
 * The page header with its real title. `description`: the real text, or
 * `true` when it depends on the viewer (a placeholder line is shown).
 * `actions`: how many header buttons the page shows.
 */
export function SkeletonHeader({
  title,
  description,
  actions = 0,
  back = false,
}: {
  title: string;
  description?: string | true;
  actions?: number;
  back?: boolean;
}) {
  return (
    <>
      {back && <Bone className="mb-3 h-5 w-36" />}
      <PageHeader
        title={title}
        description={description === true ? <Bone className="mt-1 h-4 w-[min(420px,80%)]" /> : description}
        actions={
          actions > 0 ? (
            <>
              {Array.from({ length: actions }).map((_, i) => (
                <Bone key={i} className={`h-11 rounded-lg ${i === actions - 1 ? "w-36" : "w-28"}`} />
              ))}
            </>
          ) : undefined
        }
      />
    </>
  );
}

/** A detail page header: the name is data, so it is a placeholder. */
export function SkeletonDetailHeader({ backLabel, actions = 0 }: { backLabel: string; actions?: number }) {
  return (
    <>
      <span className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-brand">‹ {backLabel}</span>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-[1_1_280px]">
          <Bone className="h-8 w-[min(340px,90%)]" />
          <Bone className="mt-2.5 h-4 w-[min(260px,70%)]" />
        </div>
        {actions > 0 && (
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: actions }).map((_, i) => (
              <Bone key={i} className="h-11 w-32 rounded-lg" />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Pill tabs (Finance, Reports, Students detail) with their real labels;
 * none is marked active, since which one opens depends on the URL. */
export function SkeletonTabs({ labels, count = 3, variant = "pill" }: { labels?: string[]; count?: number; variant?: "pill" | "underline" }) {
  // Tabs that depend on the viewer's role are shown as placeholders, not labels.
  if (!labels) {
    return (
      <div aria-hidden="true" className="mb-6 flex flex-wrap gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <Bone key={i} className="h-11 w-24 rounded-full" />
        ))}
      </div>
    );
  }
  return variant === "underline" ? (
    <div aria-hidden="true" className="mb-7 flex overflow-x-auto border-b border-border">
      {labels.map((label) => (
        <span key={label} className="inline-flex min-h-11 shrink-0 items-center px-3 text-[14px] font-medium text-[#9CA3AF] sm:px-4 sm:text-[15px]">
          {label}
        </span>
      ))}
    </div>
  ) : (
    <div aria-hidden="true" className="mb-6 flex flex-wrap gap-1">
      {labels.map((label) => (
        <span key={label} className="inline-flex min-h-11 items-center rounded-full px-4 text-[15px] font-semibold text-[#9CA3AF]">
          {label}
        </span>
      ))}
    </div>
  );
}

/** Segmented status chips (ChipParamFilter). */
export function SkeletonChips({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="mb-4 flex w-fit max-w-full gap-1 rounded-xl bg-[#EEF0F3] p-1">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className={`block h-10 rounded-lg ${i === 0 ? "w-16 bg-surface" : "w-24 bg-[#E2E5EA]"}`} />
      ))}
    </div>
  );
}

/** FilterBar: a search box, dropdown filters and date fields. */
export function SkeletonFilters({ search = true, dropdowns = 0, dates = 0 }: { search?: boolean; dropdowns?: number; dates?: number }) {
  return (
    <div aria-hidden="true" className="mb-8 flex flex-wrap items-center gap-3">
      {search && <span className="block h-11 min-w-[200px] max-w-[380px] flex-[1_1_220px] rounded-lg border border-border-strong bg-surface" />}
      {Array.from({ length: dropdowns }).map((_, i) => (
        <span key={`d${i}`} className="block h-12 w-40 rounded-[10px] border border-border-strong bg-surface" />
      ))}
      {Array.from({ length: dates }).map((_, i) => (
        <span key={`t${i}`} className="block h-11 w-44 rounded-lg border border-border-strong bg-surface" />
      ))}
    </div>
  );
}

/** StatRow: compact metric cards (label, icon tile, value, hint). */
export function SkeletonStatRow({ count }: { count: number }) {
  return (
    <div className="@container mb-8" aria-hidden="true">
      <div className="grid grid-cols-1 gap-6 @[480px]:grid-cols-2 @[880px]:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex min-h-[146px] min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card">
            <span className="flex items-start justify-between gap-3">
              <Bone className="mt-1 h-3.5 w-28" />
              <Bone className="h-9 w-9 rounded-[10px]" />
            </span>
            <Bone className="mt-3 h-8 w-32" />
            <Bone className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** StatBento: one large card and stacked small cards (Books). */
export function SkeletonBento({ side = 3 }: { side?: number }) {
  return (
    <div className="@container mb-8" aria-hidden="true">
      <div className="grid grid-cols-1 gap-6 @[520px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex min-h-[200px] flex-col justify-between rounded-card border border-border bg-surface p-7 shadow-card">
          <span className="flex items-center gap-3">
            <Bone className="h-11 w-11 rounded-xl" />
            <Bone className="h-4 w-40" />
          </span>
          <Bone className="h-14 w-24" />
          <Bone className="h-4 w-36" />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {Array.from({ length: side }).map((_, i) => (
            <div key={i} className="flex min-h-[70px] items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card">
              <Bone className="h-10 w-10 shrink-0 rounded-[10px]" />
              <span className="flex flex-1 flex-col gap-1.5">
                <Bone className="h-3.5 w-28" />
                <Bone className="h-3 w-20" />
              </span>
              <Bone className="h-6 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The real DataTable frame with the page's real column headings and
 * placeholder rows. `avatar`: the first column is a person (photo + two
 * lines). Uses the same stacking breakpoint as the loaded table.
 */
export function SkeletonTable({
  headers,
  rows = 6,
  avatar = false,
  actions = false,
  stackBelow = 900,
}: {
  headers: string[];
  rows?: number;
  avatar?: boolean;
  actions?: boolean;
  stackBelow?: 600 | 760 | 900 | 1040;
}) {
  const widths = ["w-24", "w-20", "w-28", "w-16", "w-24", "w-20"];
  return (
    <div aria-hidden="true">
      <DataTable stackBelow={stackBelow}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className={rtTh}>
                {header}
              </th>
            ))}
            {actions && (
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            // Rows past the third are dropped when the table stacks into cards (globals.css).
            <tr key={r} data-skel-extra={r >= 3 ? "" : undefined}>
              {headers.map((header, c) => (
                <td key={header} className={rtTd} data-label={header}>
                  {c === 0 && avatar ? (
                    <span className="flex items-center gap-3">
                      <Bone className="h-10 w-10 shrink-0 rounded-full" />
                      <span className="flex flex-col gap-1.5">
                        <Bone className="h-3.5 w-32" />
                        <Bone className="h-3 w-20" />
                      </span>
                    </span>
                  ) : (
                    <Bone className={`h-3.5 ${c === 0 ? "w-36" : widths[c % widths.length]}`} />
                  )}
                </td>
              ))}
              {actions && (
                <td className={`${rtTd} text-right`} data-actions="">
                  <Bone className="ml-auto h-10 w-20 rounded-lg" />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}

/** A card holding a vertical list of rows (notifications, activity, ID card students). */
export function SkeletonList({ rows = 6, avatar = true, trailing = true }: { rows?: number; avatar?: boolean; trailing?: boolean }) {
  return (
    <div aria-hidden="true" className="mb-8 overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
          {avatar && <Bone className="h-11 w-11 shrink-0 rounded-full" />}
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bone className="h-3.5 w-[min(220px,70%)]" />
            <Bone className="h-3 w-[min(160px,50%)]" />
          </span>
          {trailing && <Bone className="h-6 w-20 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

/** A grid of chart cards (BarList / StackBar). */
export function SkeletonCharts({ count = 2 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card">
          <Bone className="h-4 w-40" />
          <Bone className="mt-1.5 h-3 w-56 max-w-full" />
          <div className="mt-5 flex flex-col gap-3.5">
            {Array.from({ length: 3 }).map((_, r) => (
              <span key={r} className="grid grid-cols-[minmax(6rem,1fr)_minmax(2.5rem,10rem)_auto] items-center gap-x-3">
                <Bone className="h-3 w-20" />
                <Bone className="h-2.5 w-full rounded-full" />
                <Bone className="h-3 w-12" />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A card of label / value rows (KvCard, profile sections). */
export function SkeletonKv({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div aria-hidden="true" className="mb-6 rounded-card border border-border bg-surface p-5 shadow-card">
      {title && <Bone className="mb-4 h-4 w-32" />}
      <div className="flex flex-col divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <span key={i} className="grid grid-cols-1 gap-1.5 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-3.5 w-[min(240px,80%)]" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** A form card: labelled fields in a two-column grid and a submit button. */
export function SkeletonForm({ fields = 6 }: { fields?: number }) {
  return (
    <div aria-hidden="true" className="mb-6 rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {Array.from({ length: fields }).map((_, i) => (
          <span key={i} className="flex flex-col gap-2">
            <Bone className="h-3.5 w-24" />
            <span className="block h-11 rounded-lg border border-border-strong bg-surface" />
          </span>
        ))}
      </div>
      <Bone className="mt-6 h-11 w-32 rounded-lg" />
    </div>
  );
}

/** A plain card block of a given height (panels, calendars, previews). */
export function SkeletonPanel({ className = "h-64" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`mb-6 rounded-card border border-border bg-surface p-5 shadow-card ${className}`}>
      <Bone className="h-4 w-40" />
      <Bone className="mt-4 h-[calc(100%-2.5rem)] w-full rounded-lg" />
    </div>
  );
}
