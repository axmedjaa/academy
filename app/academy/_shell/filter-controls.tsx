"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "./icons";

/**
 * The design's filter bar (`bar` block): a search field and labelled
 * dropdown filters, each option with a record count. Every control writes a
 * URL search param and the server page re-renders, so filtering and
 * pagination stay server-side and bookmarkable. Changing any filter resets
 * `page`.
 */

function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  function write(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("page");
    const query = next.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }
  return { write, pending, searchParams };
}

export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-8 flex flex-wrap items-center gap-3">{children}</div>;
}

export function SearchField({ param = "q", placeholder }: { param?: string; placeholder: string }) {
  const { write, searchParams } = useParamWriter();
  const current = searchParams.get(param) ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <label className="relative block min-w-[200px] max-w-[380px] flex-[1_1_220px]">
      <span className="sr-only">{placeholder}</span>
      <span className="pointer-events-none absolute left-3 top-3 text-muted">
        <Icon name="search" />
      </span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => write({ [param]: next.trim() || null }), 300);
        }}
        className="h-11 w-full rounded-lg border border-border-strong bg-surface pl-[42px] pr-3 text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
      />
    </label>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export function FilterDropdown({
  param,
  label,
  icon,
  options,
}: {
  param: string;
  label: string;
  icon: string;
  /** First option is the "all" option and must have value "". */
  options: FilterOption[];
}) {
  const { write, pending, searchParams } = useParamWriter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = searchParams.get(param) ?? "";
  const selected = options.find((option) => option.value === current) ?? options[0];
  const active = current !== "";

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected.label}`}
        onClick={() => setOpen(!open)}
        className={`inline-flex h-12 items-center gap-2.5 rounded-[10px] border px-3.5 shadow-[0_1px_2px_rgba(17,24,39,0.04)] transition-[border-color,box-shadow,background-color] duration-150 ${
          open
            ? "border-brand shadow-[0_0_0_3px_rgba(133,0,25,0.12)]"
            : active
              ? "border-[#D9A5AF] bg-[#FBF3F5]"
              : "border-border-strong bg-surface"
        } ${pending ? "opacity-70" : ""}`}
      >
        <span className="inline-flex text-brand">
          <Icon name={icon} width={18} height={18} />
        </span>
        <span className="flex min-w-0 flex-col items-start leading-[1.15]">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</span>
          <span className="whitespace-nowrap text-sm font-semibold text-ink">{selected.label}</span>
        </span>
        <Icon name="expand_more" width={16} height={16} className={`ml-1 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="cs-menu absolute left-0 top-14 z-40 max-h-[300px] min-w-[230px] overflow-auto rounded-xl border border-border bg-surface p-1.5 shadow-[0_12px_32px_rgba(17,24,39,0.16)]"
        >
          {options.map((option) => {
            const on = option.value === current;
            return (
              <button
                key={option.value || "__all"}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  setOpen(false);
                  write({ [param]: option.value || null });
                }}
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg border-0 px-2.5 text-left text-sm text-ink transition-colors duration-150 hover:bg-app ${
                  on ? "bg-brand-tint font-semibold" : "bg-transparent font-medium"
                }`}
              >
                <span className="inline-flex w-[18px] text-brand">{on && <Icon name="check_circle" width={16} height={16} />}</span>
                <span className="flex-1 whitespace-nowrap">{option.label}</span>
                {option.count !== undefined && <span className="text-xs font-semibold text-muted">{option.count}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Shown only while at least one of `params` is set. `compact` matches the
 * 44px plain-select filter bars (Payments). */
export function ClearFilters({ params, compact = false }: { params: string[]; compact?: boolean }) {
  const { write, searchParams } = useParamWriter();
  if (!params.some((key) => searchParams.get(key))) return null;
  return (
    <button
      type="button"
      onClick={() => write(Object.fromEntries(params.map((key) => [key, null])))}
      className={`${compact ? "h-11 text-sm" : "h-12"} border-0 bg-transparent px-3.5 font-semibold text-brand hover:underline`}
    >
      Clear filters
    </button>
  );
}

/**
 * A plain native select that writes one URL param (design P07 Payments
 * filters: 44px, labelled for assistive tech only). The first option is
 * the "all" option and must have value "". A value in the URL that is not
 * one of `options` shows as "all".
 */
export function FilterSelect({ param, label, options }: { param: string; label: string; options: FilterOption[] }) {
  const { write, pending, searchParams } = useParamWriter();
  const fromUrl = searchParams.get(param) ?? "";
  const current = options.some((option) => option.value === fromUrl) ? fromUrl : "";
  // Shows the choice at once while the server re-renders (as SearchField
  // does), then follows the URL again (back button, Clear filters).
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        write({ [param]: event.target.value || null });
      }}
      className={`h-11 min-w-[140px] max-w-full rounded-lg border bg-surface px-3 sm:max-w-[240px] text-sm text-ink transition-[border-color,opacity] duration-150 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 ${
        value ? "border-brand" : "border-border-strong"
      } ${pending ? "opacity-70" : ""}`}
    >
      {options.map((option) => (
        <option key={option.value || "__all"} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A labelled date filter that writes one URL param (e.g. a "from" or "to"
 * bound). An empty value removes the param. */
export function DateParamField({ param, label }: { param: string; label: string }) {
  const { write, searchParams } = useParamWriter();
  return (
    <label className="flex h-11 items-center gap-2 rounded-lg border border-border-strong bg-surface pl-3 pr-2 text-[13px] font-semibold text-[#374151] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
      {label}
      <input
        type="date"
        defaultValue={searchParams.get(param) ?? ""}
        onChange={(event) => write({ [param]: event.target.value || null })}
        className="h-9 border-0 bg-transparent text-[14px] font-normal text-ink outline-none"
      />
    </label>
  );
}

/** Segmented chips that write one URL param ("" means all). */
export function ChipParamFilter({
  param,
  label,
  options,
}: {
  param: string;
  label: string;
  /** `icon` is optional; when given it leads the label (e.g. A17's status chips). */
  options: { value: string; label: string; count?: number; icon?: string }[];
}) {
  const { write, searchParams } = useParamWriter();
  const current = searchParams.get(param) ?? "";
  return (
    <div role="group" aria-label={label} className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-[#EEF0F3] p-1">
      {options.map((option) => {
        const on = current === option.value;
        return (
          <button
            key={option.value || "all"}
            type="button"
            aria-pressed={on}
            onClick={() => write({ [param]: option.value || null })}
            className={`inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg px-3.5 text-[13px] font-semibold transition-colors duration-150 ${
              on ? "bg-surface text-brand shadow-card" : "text-[#374151] hover:text-ink"
            }`}
          >
            {option.icon && <Icon name={option.icon} width={16} height={16} className="mr-1.5" />}
            {option.label}
            {option.count !== undefined && (
              <span className={`ml-1.5 rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-brand-tint" : "bg-surface/70"}`}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
