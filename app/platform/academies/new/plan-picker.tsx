"use client";

import { useState } from "react";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";

/** Rows shown first (design `planPickRows`). */
const INITIAL_ROWS = 4;
/** Rows each "Show more plans" adds, so the list grows in small steps. */
const MORE_ROWS = 6;

const PLAN_LIST_BUTTON =
  "flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border bg-surface px-3 text-[13px] font-semibold text-brand transition-colors duration-150 hover:bg-brand-tint";

const PERIOD_SHORT: Record<string, string> = { monthly: "/mo", quarterly: "/qtr", annual: "/yr" };
const PERIOD_NOUN: Record<string, string> = { monthly: "month", quarterly: "quarter", annual: "year" };

export function formatPlanBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${Number((bytes / 1_073_741_824).toFixed(1))} GB`;
  if (bytes >= 1_048_576) return `${Number((bytes / 1_048_576).toFixed(1))} MB`;
  return `${bytes} bytes`;
}

export function formatPlanPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    // Not an ISO 4217 code: show the stored code as-is.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "$49.00 per month" — the price for the plan's own billing period. */
export function formatPlanPricePerPeriod(plan: SubscriptionPlanRecord): string {
  return `${formatPlanPrice(plan.priceAmountCents, plan.currency)} per ${PERIOD_NOUN[plan.billingPeriod] ?? plan.billingPeriod}`;
}

/**
 * Register academy, step 4 (design P04 `wzIsPlan`, Platform Console.dc.html):
 * a searchable radio list of the active plans: four rows at first, six
 * more per "Show more plans" (no paging), and the chosen plan kept visible
 * when it is further down; beside a "Selected plan" panel
 * with the chosen plan's price and allowances. The two sit side by side
 * when there is room for both (280px each) and stack, panel last, on
 * narrow screens. Rows are native radios so arrow keys move the choice.
 */
export function PlanPicker({
  plans,
  value,
  onChange,
}: {
  plans: SubscriptionPlanRecord[];
  value: string;
  onChange: (planId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);

  const needle = query.trim().toLowerCase();
  const matching = needle ? plans.filter((plan) => plan.name.toLowerCase().includes(needle)) : plans;
  const selected = plans.find((plan) => plan.id === value) ?? null;
  // A chosen plan further down stays visible under the revealed rows.
  const selectedIndex = matching.findIndex((plan) => plan.id === value);
  const revealed = matching.slice(0, visibleCount);
  const rows = selectedIndex >= visibleCount ? [...revealed, matching[selectedIndex]] : revealed;
  const remaining = Math.max(0, matching.length - visibleCount);
  const nextBatch = Math.min(MORE_ROWS, remaining);
  const allowances: [string, string][] = selected
    ? [
        ["Branches", selected.maxBranches.toLocaleString("en-US")],
        ["Students", selected.maxStudents.toLocaleString("en-US")],
        ["Staff", selected.maxStaff.toLocaleString("en-US")],
        ["Courses", selected.maxCourses.toLocaleString("en-US")],
        ["Storage", formatPlanBytes(selected.maxStorageBytes)],
      ]
    : [];

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-6">
      <fieldset className="min-w-0">
        <legend className="mb-2 flex w-full items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-ink">
            Plan
            <span aria-hidden="true" className="text-[#B91C1C]">
              {" "}
              *
            </span>
          </span>
          <span className="text-xs text-muted">
            {plans.length.toLocaleString("en-US")} active {plans.length === 1 ? "plan" : "plans"}
          </span>
        </legend>

        {plans.length > INITIAL_ROWS && (
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(INITIAL_ROWS);
            }}
            placeholder="Search plans"
            aria-label="Search plans"
            className="mb-2 h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
          />
        )}

        {rows.map((plan) => {
          const on = plan.id === value;
          return (
            <label
              key={plan.id}
              className={`mb-2 flex min-h-14 cursor-pointer items-center gap-3 rounded-card border-[1.5px] px-3.5 py-2.5 transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${
                on ? "border-brand bg-brand-tint" : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <input type="radio" name="planChoice" value={plan.id} checked={on} onChange={() => onChange(plan.id)} className="sr-only" />
              <span
                aria-hidden="true"
                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${on ? "border-brand" : "border-[#9CA3AF]"}`}
              >
                <span className={`h-2 w-2 rounded-full ${on ? "bg-brand" : "bg-transparent"}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{plan.name}</span>
                <span className="block text-xs text-[#374151]">
                  {plan.maxStudents.toLocaleString("en-US")} students, {plan.maxBranches.toLocaleString("en-US")} branches,{" "}
                  {formatPlanBytes(plan.maxStorageBytes)}
                </span>
              </span>
              <span className="whitespace-nowrap font-semibold tabular-nums text-ink">
                {formatPlanPrice(plan.priceAmountCents, plan.currency)}
                <span className="text-xs font-normal text-muted"> {PERIOD_SHORT[plan.billingPeriod] ?? `/${plan.billingPeriod}`}</span>
              </span>
            </label>
          );
        })}

        {matching.length === 0 && (
          <div className="rounded-card border border-dashed border-border-strong p-4 text-center text-[#374151]">
            No plans match that search.
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-1 block w-full text-[13px] font-semibold text-brand hover:underline"
            >
              Clear search
            </button>
          </div>
        )}

        {matching.length > INITIAL_ROWS && (
          <>
            <div className="flex gap-2">
              {nextBatch > 0 && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + MORE_ROWS)}
                  className={PLAN_LIST_BUTTON}
                >
                  Show {nextBatch} more {nextBatch === 1 ? "plan" : "plans"}
                </button>
              )}
              {visibleCount > INITIAL_ROWS && (
                <button type="button" onClick={() => setVisibleCount(INITIAL_ROWS)} className={PLAN_LIST_BUTTON}>
                  Show fewer plans
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted" aria-live="polite">
              Showing {Math.min(visibleCount, matching.length).toLocaleString("en-US")} of {matching.length.toLocaleString("en-US")}
              {needle ? " matching" : ""} plans
            </p>
          </>
        )}
      </fieldset>

      <section aria-label="Selected plan" aria-live="polite" className="min-w-0 rounded-card border border-border bg-[#FAFBFC] p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Selected plan</div>
        {selected ? (
          <>
            <div className="mb-2 mt-1 text-lg font-bold leading-snug text-ink [overflow-wrap:anywhere]">
              {selected.name}, {formatPlanPricePerPeriod(selected)}
            </div>
            <div className="mb-1 text-[13px] font-medium text-ink">Allowances</div>
            <dl>
              {allowances.map(([label, amount]) => (
                <div key={label} className="flex justify-between gap-4 border-t border-border py-2">
                  <dt className="text-[#374151]">{label}</dt>
                  <dd className="font-semibold tabular-nums text-ink">{amount}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted">No plan selected yet. Choose a plan to see its price and allowances.</p>
        )}
      </section>
    </div>
  );
}
