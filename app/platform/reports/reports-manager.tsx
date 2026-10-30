"use client";

import { useState, useTransition } from "react";
import {
  exportRevenueReportCsvAction,
  getPlatformReportsAction,
} from "@/lib/subscriptions/reports-actions";
import type {
  AcademiesByPlanRow,
  PlatformReportsResult,
  RevenueBreakdownResult,
  RevenueGroupBy,
} from "@/lib/subscriptions/reports";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast } from "@/lib/ui/toast";
import { ErrorMessage } from "@/app/academy/_shell/ui";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { controlClass } from "@/app/academy/_shell/design-form";
import { ExpiringList } from "../_shared/expiring-list";

const REVENUE_GROUP_BY_OPTIONS: readonly RevenueGroupBy[] = ["month", "plan", "academy", "method"];

const GROUP_BY_LABELS: Record<RevenueGroupBy, string> = {
  month: "Month",
  plan: "Plan",
  academy: "Academy",
  method: "Method",
};

/** No currency symbol: payments carry free-text currencies that are never
 * reconciled, so a summed figure is a plain amount. */
function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const CARD = "min-w-0 rounded-card border border-border bg-surface p-5 shadow-card";
/** Design P09 "expected": pale burgundy-tint hatching with a burgundy outline. */
const EXPECTED_FILL =
  "h-full bg-[repeating-linear-gradient(135deg,var(--color-brand-tint)_0_4px,#fff_4px_8px)] shadow-[inset_0_0_0_1px_var(--color-brand)]";

/**
 * Reports (design P09): revenue (owner only), active academies by month,
 * academies by plan and the expiring list. The revenue card is absent, not
 * hidden, when `data.revenue` is null (the server returns null to anyone
 * without the owner-only revenue capability).
 */
export function ReportsManager({ initialData, expiringCap }: { initialData: PlatformReportsResult; expiringCap: number }) {
  const [data, setData] = useState(initialData);
  const [groupBy, setGroupBy] = useState<RevenueGroupBy>(initialData.revenue?.groupBy ?? "month");
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleGroupByChange(nextGroupBy: RevenueGroupBy) {
    setGroupBy(nextGroupBy);
    setError(null);
    startTransition(async () => {
      try {
        const result = await getPlatformReportsAction({ groupBy: nextGroupBy });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setData(result.data);
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  function handleExport() {
    setError(null);
    setIsExporting(true);
    startTransition(async () => {
      try {
        const result = await exportRevenueReportCsvAction(groupBy);
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        downloadCsv(result.csv, `platform-revenue-${groupBy}.csv`);
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      } finally {
        setIsExporting(false);
      }
    });
  }

  const trendRows = data.activeAcademyTrend.map((point) => ({
    label: monthLabel(point.month),
    value: point.cumulativeActive,
    text: String(point.cumulativeActive),
  }));

  return (
    <div className="mb-8 flex flex-col gap-6">
      {data.revenue ? (
        <RevenueCard
          revenue={data.revenue}
          groupBy={groupBy}
          loading={isPending && !isExporting}
          exporting={isExporting}
          error={error}
          onGroupBy={handleGroupByChange}
          onExport={handleExport}
        />
      ) : (
        // Design P09: accounts without the revenue capability get this notice, not a gap.
        <div role="status" className="rounded-card border border-[#CBD5E1] bg-[#EEF0F3] p-4 text-[#334155]">
          Revenue is available to Platform Owner accounts only. Growth and expiry sections are shown below.
        </div>
      )}

      {/* Design P09: one auto-fit grid for the three report cards. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-6">
        <TrendCard rows={trendRows} />
        <PlanDonut rows={data.academiesByPlan} />
        <section className={CARD}>
          <h3 className="text-[15px] font-semibold text-ink">Expiring within 30 days</h3>
          <p className="mt-0.5 text-[13px] text-muted">Active, trial and past-due subscriptions, soonest first.</p>
          <ExpiringList
            variant="paged"
            rows={data.expiringSubscriptions.rows}
            totalCount={data.expiringSubscriptions.totalCount}
            cap={expiringCap}
            linkAcademies
            emptyMessage="No subscriptions end in the next 30 days."
          />
        </section>
      </div>
    </div>
  );
}

/** Design P09 "Active academies by month": month | full-width bar | value
 * rows split by hairlines, with the explanation under the list. */
function TrendCard({ rows }: { rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const empty = rows.every((row) => row.value === 0);
  return (
    <section className={CARD}>
      <h3 className="mb-3 text-[15px] font-semibold text-ink">Active academies by month</h3>
      {empty ? (
        <p className="py-6 text-center text-sm text-muted">No active academies yet.</p>
      ) : (
        <ul role="list">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[4.75rem_minmax(0,1fr)_2rem] items-center gap-3 border-t border-border py-2">
              <span className="text-[13px] text-muted">{row.label}</span>
              <span className="block h-2 rounded bg-app" aria-hidden="true">
                <span className="block h-2 rounded bg-brand" style={{ width: `${(row.value / max) * 100}%` }} />
              </span>
              <span className="text-right font-semibold tabular-nums text-ink">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">Academies active today, counted from the month their subscription was activated.</p>
    </section>
  );
}

function RevenueCard({
  revenue,
  groupBy,
  loading,
  exporting,
  error,
  onGroupBy,
  onExport,
}: {
  revenue: RevenueBreakdownResult;
  groupBy: RevenueGroupBy;
  loading: boolean;
  exporting: boolean;
  error: string | null;
  onGroupBy: (value: RevenueGroupBy) => void;
  onExport: () => void;
}) {
  const max = Math.max(1, ...revenue.rows.map((row) => row.collectedCents + row.expectedCents));
  return (
    <section className={`${CARD} @container/rev`} aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">Revenue</h3>
          <p className="mt-0.5 text-xs text-muted">Collected is verified payments. Expected is the plan price of upcoming renewals not yet paid.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#374151]">
            Group by
            <select
              value={groupBy}
              disabled={loading}
              onChange={(event) => onGroupBy(event.target.value as RevenueGroupBy)}
              className={`${controlClass(false)} h-10 w-36 text-sm`}
            >
              {REVENUE_GROUP_BY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {GROUP_BY_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={ROW_BTN} onClick={onExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorMessage message={error} />
        </div>
      )}

      {revenue.rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No payments recorded yet.</p>
      ) : (
        <ul role="list" aria-label={`Revenue by ${GROUP_BY_LABELS[revenue.groupBy].toLowerCase()}`} className={`mt-5 flex flex-col gap-4 transition-opacity duration-150 ${loading ? "opacity-60" : ""}`}>
          {revenue.rows.map((row) => {
            const collected = (row.collectedCents / max) * 100;
            const expected = (row.expectedCents / max) * 100;
            return (
              <li
                key={row.groupKey}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 @[640px]/rev:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)_minmax(7rem,auto)]"
              >
                <span className="min-w-0 max-w-64 justify-self-start rounded-md border border-border bg-app px-2 py-0.5 text-[13px] font-medium text-ink [overflow-wrap:anywhere]">
                  {revenue.groupBy === "month" ? monthLabel(row.label) : row.label}
                </span>
                <span className="order-3 col-span-2 flex h-[22px] overflow-hidden rounded-[11px] bg-app @[640px]/rev:order-none @[640px]/rev:col-span-1" aria-hidden="true">
                  <span className="h-full bg-brand" style={{ width: `${collected}%` }} />
                  <span
                    className={EXPECTED_FILL}
                    style={{ width: `${expected}%`, display: row.expectedCents > 0 ? undefined : "none" }}
                  />
                </span>
                <span className="text-right">
                  <span className="block text-[15px] font-bold tabular-nums text-brand">{formatCents(row.collectedCents)}</span>
                  <span className="block text-xs tabular-nums text-muted">{formatCents(row.expectedCents)} expected</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span className="flex flex-wrap gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-brand" aria-hidden="true" />
            Collected
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-[3px] ${EXPECTED_FILL}`} aria-hidden="true" />
            Expected
          </span>
        </span>
        <span className="tabular-nums">
          Total collected <strong className="text-ink">{formatCents(revenue.totals.collectedCents)}</strong> · expected{" "}
          <strong className="text-ink">{formatCents(revenue.totals.expectedCents)}</strong>
        </span>
      </div>
    </section>
  );
}

function sharePercent(value: number, total: number): string {
  const percent = (value / total) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

const DONUT_COLORS = ["#850019", "#B4475B", "#D98C9A", "#F0C7CF", "#9CA3AF"];
const DONUT_TOP = 4;

/** Design donut: open academies by current plan. The largest four plans
 * get their own slice; any others are grouped as "Other plans". */
function PlanDonut({ rows }: { rows: AcademiesByPlanRow[] }) {
  const slices =
    rows.length > DONUT_TOP + 1
      ? [
          ...rows.slice(0, DONUT_TOP).map((row) => ({ label: row.planName, value: row.academyCount })),
          { label: `Other plans (${rows.length - DONUT_TOP})`, value: rows.slice(DONUT_TOP).reduce((sum, row) => sum + row.academyCount, 0) },
        ]
      : rows.map((row) => ({ label: row.planName, value: row.academyCount }));
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 15.9155; // circumference 100, so dash lengths are percentages
  const shares = slices.map((slice) => (total > 0 ? (slice.value / total) * 100 : 0));
  const offsets = shares.map((_, index) => shares.slice(0, index).reduce((sum, share) => sum + share, 0));

  return (
    <section className={`${CARD} @container/donut`}>
      <h3 className="text-[15px] font-semibold text-ink">Academies by plan</h3>
      <p className="mt-0.5 text-xs text-muted">Each open academy counted once, by its current plan. Closed academies excluded.</p>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No academies with a plan yet.</p>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-5 @[420px]/donut:flex-row @[420px]/donut:items-center">
          <svg viewBox="0 0 42 42" className="h-36 w-36 shrink-0 -rotate-90" role="img" aria-label={`${total} academies across ${rows.length} plans`}>
            <circle cx="21" cy="21" r={radius} fill="none" stroke="#EEF0F3" strokeWidth="6" />
            {slices.map((slice, index) => {
              const share = shares[index];
              return (
                <circle
                  key={slice.label}
                  cx="21"
                  cy="21"
                  r={radius}
                  fill="none"
                  stroke={DONUT_COLORS[index % DONUT_COLORS.length]}
                  strokeWidth="6"
                  strokeDasharray={`${share} ${100 - share}`}
                  strokeDashoffset={-offsets[index]}
                />
              );
            })}
          </svg>
          <ul role="list" className="flex w-full min-w-0 flex-col gap-2.5">
            {slices.map((slice, index) => (
              <li key={slice.label} className="flex items-center gap-2.5 text-[13px]">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }} aria-hidden="true" />
                <span className="min-w-0 flex-1 font-semibold text-ink [overflow-wrap:anywhere]">{slice.label}</span>
                <span className="font-semibold tabular-nums text-ink">{slice.value}</span>
                <span className="w-12 rounded-md border border-border px-1.5 py-0.5 text-center text-xs tabular-nums text-[#374151]">
                  {sharePercent(slice.value, total)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
