import type { ReactNode } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";

/** Shared presentational blocks of the Book Management sections (design
 * B01-B12). Server components; no data access. */

export function SectionHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold leading-snug text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-[680px] text-sm text-[#4B5563]">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** The design's summary cards (B03, B06-B08): a plain white card with the
 * label above a large figure. An optional line under the figure for the
 * sections that explain a number (Receive, Reports). */
export function KpiGrid({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:gap-4">
      {items.map((k) => (
        <div key={k.label} className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface px-5 py-4 shadow-card">
          <span className="text-[13px] leading-tight text-[#4B5563]">{k.label}</span>
          <span className="mt-2 text-2xl font-bold leading-[1.1] tracking-[-0.01em] tabular-nums [overflow-wrap:anywhere]">{k.value}</span>
          {k.sub && <span className="mt-1 text-xs text-muted">{k.sub}</span>}
        </div>
      ))}
    </div>
  );
}

export function EmptyCard({ title, description, action }: { title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-5 py-10 text-center shadow-card">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mb-4 mt-1.5 max-w-[420px] text-[#4B5563]">{description}</p>
      {action}
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] px-4 py-3 text-sm leading-relaxed text-[#1E3A8A]">
      <span className="mt-0.5 shrink-0">
        <Icon name="info" width={20} height={20} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function MoneyBoxes({ items }: { items: { label: string; value: string; tone?: "danger" | "success" }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {items.map((m) => (
        <div
          key={m.label}
          className={`min-w-0 rounded-xl px-3 py-2.5 ${m.tone === "danger" ? "bg-[#FEF2F2]" : m.tone === "success" ? "bg-[#F0FDF4]" : "bg-app"}`}
        >
          <div className="text-xs text-muted">{m.label}</div>
          <div
            className={`mt-0.5 truncate text-[17px] font-bold tabular-nums ${m.tone === "danger" ? "text-[#B91C1C]" : m.tone === "success" ? "text-[#166534]" : "text-ink"}`}
          >
            {m.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProgressBar({ percent, color = "bg-brand", label }: { percent: number; color?: string; label?: ReactNode }) {
  return (
    <div>
      <div className="h-2 overflow-hidden rounded bg-[#F1F2F5]">
        <div className={`h-full rounded ${color}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      {label && <div className="mt-1 text-xs text-muted">{label}</div>}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: Record<string, string | string[] | undefined>;
}) {
  return <PaginationNav page={page} pageSize={pageSize} totalCount={total} searchParams={params} />;
}

/** URL param helpers shared by the section pages. */
export function readParams(params: Record<string, string | string[] | undefined>) {
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const pageParam = Number.parseInt(get("page"), 10);
  return { get, page: Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1 };
}

export function paginate<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice((page - 1) * size, page * size);
}

export const CARD = "rounded-2xl border border-border bg-surface shadow-card";
export const BTN_SECONDARY =
  "inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-4 font-semibold !text-ink !no-underline transition-colors duration-150 hover:bg-app hover:!no-underline";
export const BTN_PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border-0 bg-brand px-4 font-semibold !text-white !no-underline transition-colors duration-150 hover:bg-brand-hover hover:!no-underline";
