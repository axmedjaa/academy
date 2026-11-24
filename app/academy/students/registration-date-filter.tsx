"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/app/academy/_shell/icons";
import { useParamWriter } from "@/app/academy/_shell/filter-controls";

interface PeriodOption {
  /** A preset key ("7d") or a month ("2026-11"). */
  value: string;
  label: string;
  /** The dates it covers, e.g. "18 – 24 Nov". */
  hint?: string;
  count: number;
}

/**
 * Students page "Registration date" filter, the pattern Stripe, Shopify and
 * Google Analytics share: preset periods first (each with its dates and a
 * student count), then By month, then a Custom range. Writes `reg` (and
 * `regFrom` / `regTo` for a custom range); the server resolves the dates
 * (lib/academies/registration-periods.ts).
 */
export function RegistrationDateFilter({
  total,
  current,
  presets,
  months,
  today,
}: {
  total: number;
  /** The period in the URL, already resolved; null = All time. */
  current: { value: string; label: string; hint: string; from: string; to: string } | null;
  presets: PeriodOption[];
  months: PeriodOption[];
  /** Mogadishu today, "YYYY-MM-DD" (the custom range's latest day). */
  today: string;
}) {
  const { write, pending } = useParamWriter();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(current?.value === "custom" ? current.from : "");
  const [to, setTo] = useState(current?.value === "custom" ? current.to : "");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = current?.value ?? "";

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(value: string) {
    setOpen(false);
    write({ reg: value || null, regFrom: null, regTo: null, month: null });
  }

  const rangeReady = Boolean(from && to);
  const rangeBackwards = rangeReady && from > to;

  // "Last 7 days · 18 – 24 Nov"; a month or custom range shows its dates only.
  const shown = !current ? "All time" : current.value === "custom" ? current.hint : current.hint === "Whole month" ? current.label : `${current.label} · ${current.hint}`;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Registration date: ${shown}`}
        onClick={() => setOpen(!open)}
        className={`inline-flex h-12 items-center gap-2.5 rounded-[10px] border px-3.5 shadow-[0_1px_2px_rgba(17,24,39,0.04)] transition-[border-color,box-shadow,background-color] duration-150 ${
          open ? "border-brand shadow-[0_0_0_3px_rgba(133,0,25,0.12)]" : current ? "border-[#D9A5AF] bg-[#FBF3F5]" : "border-border-strong bg-surface"
        } ${pending ? "opacity-70" : ""}`}
      >
        <span className="inline-flex text-brand">
          <Icon name="calendar" width={18} height={18} />
        </span>
        <span className="flex min-w-0 flex-col items-start leading-[1.15]">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">Registration date</span>
          <span className="whitespace-nowrap text-sm font-semibold text-ink tabular-nums">{shown}</span>
        </span>
        <Icon name="expand_more" width={16} height={16} className={`ml-1 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Registration date"
          className="cs-menu absolute left-0 top-14 z-40 flex max-h-[min(560px,calc(100vh-180px))] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[0_12px_32px_rgba(17,24,39,0.16)]"
        >
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            <PeriodRow label="All time" count={total} on={selected === ""} onClick={() => choose("")} />
            {presets.map((option) => (
              <PeriodRow key={option.value} {...option} on={selected === option.value} onClick={() => choose(option.value)} />
            ))}
            {months.length > 0 && (
              <>
                <SectionTitle>By month</SectionTitle>
                {months.map((option) => (
                  <PeriodRow key={option.value} {...option} on={selected === option.value} onClick={() => choose(option.value)} />
                ))}
              </>
            )}
          </div>

          <form
            className="border-t border-border bg-[#FAFBFC] px-3 pb-3 pt-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rangeReady || rangeBackwards) return;
              setOpen(false);
              write({ reg: "custom", regFrom: from, regTo: to, month: null });
            }}
          >
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Custom range</p>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <DateInput label="From" value={from} max={to || today} onChange={setFrom} />
              <DateInput label="To" value={to} min={from || undefined} max={today} onChange={setTo} />
              <button
                type="submit"
                disabled={!rangeReady || rangeBackwards}
                className="h-10 rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply
              </button>
            </div>
            {rangeBackwards && (
              <p role="alert" className="mt-1.5 text-xs font-medium text-[#B91C1C]">
                The From date must be on or before the To date.
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mx-2.5 mb-1 mt-2.5 border-t border-border pt-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{children}</p>
  );
}

function PeriodRow({ label, hint, count, on, onClick }: { label: string; hint?: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex min-h-10 w-full items-center gap-2 rounded-lg border-0 px-2.5 text-left text-sm text-ink transition-colors duration-150 hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        on ? "bg-brand-tint font-semibold" : "bg-transparent font-medium"
      }`}
    >
      <span className="inline-flex w-[18px] shrink-0 text-brand">{on && <Icon name="check_circle" width={16} height={16} />}</span>
      <span className="whitespace-nowrap">{label}</span>
      <span className="ml-auto whitespace-nowrap pl-3 text-xs font-normal text-muted tabular-nums">{hint}</span>
      <span className={`min-w-[2.25rem] text-right text-xs font-semibold tabular-nums ${count === 0 ? "text-[#9CA3AF]" : "text-[#4B5563]"}`}>{count}</span>
    </button>
  );
}

function DateInput({ label, value, min, max, onChange }: { label: string; value: string; min?: string; max?: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-[#374151]">
      {label}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 min-w-0 rounded-lg border border-border-strong bg-surface px-2 text-[13px] font-normal text-ink tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
      />
    </label>
  );
}
