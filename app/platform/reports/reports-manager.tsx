"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { exportRevenueReportCsvAction, getPlatformReportsAction } from "@/lib/subscriptions/reports-actions";
import type {
  AcademiesByPlanRow,
  ExpiringSubscriptionRow,
  PlatformReportsResult,
  RevenueBreakdownResult,
  RevenueBreakdownRow,
  RevenueGroupBy,
} from "@/lib/subscriptions/reports";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast } from "@/lib/ui/toast";
import { Badge } from "@/app/academy/_shell/ui";
import { expiryBadge } from "../_shared/expiring-list";
import { planLabel } from "../_shared/status";
import {
  BarRow,
  BRAND_RULE,
  CARD,
  CARD_SUB,
  CARD_TITLE,
  CardFacts,
  Donut,
  Fact,
  HATCH,
  money,
  money2,
  nextSort,
  Pager,
  pct,
  PCT_PILL,
  PillGroup,
  Restricted,
  RowCard,
  SECONDARY_BTN,
  SectionHeading,
  sortRows,
  SortTable,
  TrendChart,
  useIsMobile,
  type Column,
  type SortState,
} from "./report-blocks";
import { RANGE_OPTIONS, rangeToMonths, type ReportRange } from "./range";

/*
 * /platform/reports, laid out to the REPORTS screen of the Claude Design file
 * "Platform Console.dc.html": header card with the date range, an overview
 * grid (active-subscriptions hero + four KPI cards), then Revenue, Academies,
 * Subscriptions, Plans and Detailed data sections.
 *
 * Every figure comes from getPlatformReports (real database data). The date
 * range and revenue grouping are refetched from the server, never filtered on
 * the client. Owner-only parts arrive as null and render as the design's
 * "restricted" card or "—", never as zero.
 */

type BreakdownGroupBy = Exclude<RevenueGroupBy, "month">;

const BREAKDOWN_OPTIONS: readonly { value: BreakdownGroupBy; label: string }[] = [
  { value: "plan", label: "Plan" },
  { value: "billing_period", label: "Billing period" },
  { value: "method", label: "Method" },
  { value: "academy", label: "Academy" },
];

const GROUP_TITLE: Record<BreakdownGroupBy, string> = {
  plan: "Plan",
  billing_period: "Billing period",
  method: "Method",
  academy: "Academy",
};

const BILLING_PERIOD_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" };

/** Status rows, labels and pill colours exactly as the design lists them. */
const STATUS_ROWS: readonly [SubscriptionStatus | "none", string, string, string][] = [
  ["active", "Active", "#ECFDF5", "#047857"],
  ["trial", "Trial", "#EFF6FF", "#1D4ED8"],
  ["past_due", "Past due, grace period", "#FFFBEB", "#92400E"],
  ["suspended", "Suspended", "#FEF2F2", "#B91C1C"],
  ["expired", "Expired", "#FEF2F2", "#B91C1C"],
  ["cancelled", "Cancelled", "#FEF2F2", "#B91C1C"],
  ["draft", "Draft", "#F3F4F6", "#374151"],
  ["none", "No subscription", "#F3F4F6", "#374151"],
];

const LIFECYCLE_ROWS: readonly [string, string, string, string][] = [
  ["approved", "Approved", "#ECFDF5", "#047857"],
  ["pending_approval", "Pending approval", "#FFFBEB", "#92400E"],
  ["closed", "Closed", "#F3F4F6", "#374151"],
];

const PLAN_COLORS = ["#850019", "#B5566A", "#E3B5BF", "#6B7280"];

const BREAKDOWN_ROWS = 8;
const EXPIRING_PAGE_ROWS = 6;
const DETAIL_PAGE_ROWS = 10;

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const MONTH_YY = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

function keyToDate(key: string): Date {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function dateToKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every "YYYY-MM" from `first` to `last`, inclusive. */
function monthSpan(first: string, last: string): string[] {
  const keys: string[] = [];
  const cursor = keyToDate(first);
  const end = keyToDate(last);
  while (cursor <= end && keys.length < 600) {
    keys.push(dateToKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

/** "Dec 25" — the design's axis and tooltip month label. */
function monthLabel(key: string): string {
  return MONTH_YY.format(keyToDate(key));
}

/** "Nov 2025 to Oct 2026", or "All time". */
function rangeText(data: PlatformReportsResult): string {
  if (!data.revenueSince) return "All time";
  return `${MONTH_YEAR.format(data.revenueSince)} to ${MONTH_YEAR.format(new Date())}`;
}

function humanize(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function groupLabel(groupBy: RevenueGroupBy, row: RevenueBreakdownRow): string {
  switch (groupBy) {
    case "month":
      return MONTH_YEAR.format(keyToDate(row.label));
    case "billing_period":
      return BILLING_PERIOD_LABEL[row.label] ?? humanize(row.label);
    case "method":
      return row.groupKey === "__not_yet_paid__" ? row.label : humanize(row.label);
    default:
      return row.label;
  }
}

function downloadCsv(csv: string, filename: string) {
  // UTF-8 byte-order mark: Excel then reads names with accents or Arabic
  // script correctly instead of showing garbled characters.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function ReportsManager({
  initialData,
  initialRange,
  initialGroupBy,
  expiringCap,
}: {
  initialData: PlatformReportsResult;
  initialRange: ReportRange;
  initialGroupBy: BreakdownGroupBy;
  expiringCap: number;
}) {
  const [data, setData] = useState(initialData);
  const [range, setRange] = useState<ReportRange>(initialRange);
  const [groupBy, setGroupBy] = useState<BreakdownGroupBy>(initialGroupBy);
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mobile = useIsMobile();

  // The range and grouping the figures on screen were actually loaded with;
  // a failed refetch puts the controls back so they never describe other data.
  const [loaded, setLoaded] = useState({ range: initialRange, groupBy: initialGroupBy });

  function load(nextRange: ReportRange, nextGroupBy: BreakdownGroupBy) {
    setError(null);
    const fail = (message: string) => {
      setError(message);
      setRange(loaded.range);
      setGroupBy(loaded.groupBy);
    };
    startTransition(async () => {
      try {
        const result = await getPlatformReportsAction({ groupBy: nextGroupBy, rangeMonths: rangeToMonths(nextRange) });
        if (!result.ok) {
          fail(result.error.message);
          return;
        }
        setData(result.data);
        setLoaded({ range: nextRange, groupBy: nextGroupBy });
      } catch {
        fail(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  function handleRange(next: ReportRange) {
    setRange(next);
    load(next, groupBy);
  }

  function handleGroupBy(next: BreakdownGroupBy) {
    setGroupBy(next);
    load(range, next);
  }

  function handleExport() {
    setIsExporting(true);
    startTransition(async () => {
      try {
        const result = await exportRevenueReportCsvAction(groupBy, rangeToMonths(range));
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        downloadCsv(result.csv, `platform-revenue-${groupBy}-${range === "all" ? "all-time" : `${range}m`}.csv`);
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      } finally {
        setIsExporting(false);
      }
    });
  }

  const loading = isPending && !isExporting;
  const span = rangeText(data);
  const cap = `Range: ${span}`;
  const isOwner = data.revenue !== null;
  const isEmpty =
    data.subscriptionStatus.openAcademies === 0 &&
    (data.academyLifecycle?.total ?? 0) === 0 &&
    (data.revenueTrend?.totals.collectedCents ?? 0) === 0 &&
    (data.revenueTrend?.totals.expectedCents ?? 0) === 0;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:px-6 sm:pt-6 min-[1025px]:px-8 min-[1025px]:pb-14 min-[1025px]:pt-8">
      <header className="mb-8 overflow-hidden rounded-xl border border-[#E2E5EA] bg-white shadow-[0_1px_3px_rgba(17,24,39,.07),0_1px_2px_rgba(17,24,39,.04)]">
        <div className="h-[3px]" style={{ background: BRAND_RULE }} />
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 p-6">
          <div className="min-w-0 flex-[1_1_340px]">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#850019]">Platform</div>
            <h1 className="m-0 text-[32px] font-bold leading-[1.15] tracking-[-0.02em] text-[#111827]">Platform reports</h1>
            <p className="mt-2 max-w-[620px] text-[15px] leading-[1.55] text-[#4B5563]">
              Subscriptions, revenue, academy growth and plan adoption across every academy on Dardar.
            </p>
          </div>
          <div className="flex min-w-[min(100%,280px)] flex-[0_1_480px] flex-col items-stretch gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#4B5563]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#850019" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
              Date range
            </span>
            <div className="flex flex-wrap items-stretch gap-3">
              <PillGroup label="Date range" value={range} options={RANGE_OPTIONS} onChange={handleRange} disabled={loading} />
              <button type="button" onClick={() => load(range, groupBy)} disabled={loading} className={`${SECONDARY_BTN} h-11`}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className={loading ? "motion-safe:animate-spin" : ""}
                >
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                Refresh
              </button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#E2E5EA] bg-[#F7F8FA] px-6 py-3 text-[13px] text-[#4B5563]">
          <span className="font-semibold text-[#111827]">{cap}</span>
          <span aria-hidden="true" className="text-[#CBD5E1]">
            |
          </span>
          <span className="min-w-0 flex-[1_1_260px]">Collected means verified. Expected is a provisional definition.</span>
          <span role="status" aria-live="polite" className="text-[#6B7280]">
            {loading ? "Updating…" : ""}
          </span>
        </div>
      </header>

      {error && (
        <div role="alert" className={`${CARD} mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 !border-[#FECACA] !bg-[#FEF2F2]`}>
          <span aria-hidden="true" className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#B91C1C] font-bold text-white">
            !
          </span>
          <div className="flex-[1_1_260px]">
            <div className="font-semibold text-[#7F1D1D]">Reports could not be loaded</div>
            <div className="text-[13px] text-[#7F1D1D]">{error} Nothing on this page has changed. Try again.</div>
          </div>
          <button type="button" className={SECONDARY_BTN} onClick={() => load(range, groupBy)} disabled={loading}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <LoadingBody />
      ) : isEmpty ? (
        <div className={`${CARD} !px-6 !py-12 text-center`}>
          <div aria-hidden="true" className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#F9E8EC] text-[22px] font-bold text-[#850019]">
            0
          </div>
          <div className="text-base font-semibold text-[#111827]">No report data in this range</div>
          <div className="mx-auto mb-4 mt-1 max-w-[420px] text-[13px] text-[#6B7280]">
            Reports fill in once academies are registered and subscription payments are verified. Try a longer range.
          </div>
          {range !== "all" && (
            <button type="button" className={SECONDARY_BTN} onClick={() => handleRange("all")}>
              Show all time
            </button>
          )}
        </div>
      ) : (
        <>
          <Overview data={data} span={span} />
          <RevenueSection
            data={data}
            cap={cap}
            groupBy={groupBy}
            mobile={mobile}
            exporting={isExporting}
            onGroupBy={handleGroupBy}
            onExport={handleExport}
          />
          <AcademiesSection data={data} mobile={mobile} />
          <SubscriptionsSection data={data} mobile={mobile} expiringCap={expiringCap} />
          <PlansSection data={data} mobile={mobile} />
          {/* Keyed so a new range or grouping starts the table at page one. */}
          <DetailSection key={`${loaded.range}-${loaded.groupBy}`} revenue={data.revenue} groupBy={loaded.groupBy} cap={span} mobile={mobile} isOwner={isOwner} />
        </>
      )}
    </div>
  );
}

/** The design's loading state: five KPI bones and a twelve-bar chart bone. */
export function LoadingBody() {
  const heights = ["40%", "55%", "48%", "70%", "62%", "80%", "58%", "66%", "74%", "60%", "84%", "92%"];
  return (
    <div aria-busy="true" role="status" aria-label="Loading reports" className="grid gap-6">
      <div className="grid grid-cols-2 gap-4 min-[1025px]:grid-cols-[minmax(0,1.3fr)_repeat(2,minmax(0,1fr))]">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${CARD} grid h-[104px] content-center gap-2.5`}>
            <div className="h-3 w-1/2 rounded-md bg-[#EEF0F3]" />
            <div className="h-7 w-[35%] rounded-md bg-[#E2E5EA]" />
            <div className="h-2.5 w-[65%] rounded-md bg-[#EEF0F3]" />
          </div>
        ))}
      </div>
      <div className={`${CARD} grid h-[280px] grid-cols-12 content-end gap-3`}>
        {heights.map((h, i) => (
          <div key={i} className="rounded-t bg-[#EEF0F3]" style={{ height: h }} />
        ))}
      </div>
    </div>
  );
}

const SECTION = "mb-14";

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function Overview({ data, span }: { data: PlatformReportsResult; span: string }) {
  const status = data.subscriptionStatus.byStatus;
  const open = data.subscriptionStatus.openAcademies;
  const serving = status.active + status.trial + status.past_due;
  const lifecycle = data.academyLifecycle;
  const collected = data.revenueTrend?.totals.collectedCents ?? null;

  const kpis = [
    {
      label: "Open academies",
      value: open.toLocaleString("en-US"),
      sub: lifecycle
        ? `${lifecycle.total.toLocaleString("en-US")} registered, ${(lifecycle.byStatus.closed ?? 0).toLocaleString("en-US")} closed`
        : "Not closed, any status",
      fg: "#111827",
    },
    { label: "Active students", value: data.population.activeStudents.toLocaleString("en-US"), sub: "Across open academies", fg: "#111827" },
    { label: "Active staff", value: data.population.activeStaff.toLocaleString("en-US"), sub: "Across open academies", fg: "#111827" },
    collected === null
      ? { label: "Collected", value: "Owner only", sub: "Revenue is restricted", fg: "#6B7280" }
      : { label: "Collected", value: money(collected), sub: `Verified payments, ${span}`, fg: "#850019" },
  ];

  return (
    <section aria-label="Overview" className="mb-10 grid grid-cols-2 gap-4 min-[1025px]:grid-cols-[minmax(0,1.3fr)_repeat(2,minmax(0,1fr))]">
      <div className="relative col-span-full flex min-h-[200px] flex-col overflow-hidden rounded-xl border border-[#E2E5EA] bg-[linear-gradient(135deg,#F9E8EC_0%,#E9C3CC_100%)] p-6 shadow-[0_1px_2px_rgba(17,24,39,.05)] min-[1025px]:col-span-1 min-[1025px]:row-span-2">
        <div className="absolute left-0 top-7 h-10 w-1 rounded-r bg-[#F5B638]" />
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[#374151]">Active subscriptions</div>
        <div className="mt-0.5 text-[13px] text-[#374151]">Today, one per open academy</div>
        <div className="mt-auto flex items-baseline gap-2.5 pt-3">
          <span className="text-[68px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[#850019]">{serving.toLocaleString("en-US")}</span>
          <span className="text-sm text-[#374151]">of {open.toLocaleString("en-US")} open academies</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-[rgba(133,0,25,.4)] pt-3.5">
          {[
            [status.trial, "Trial"],
            [status.past_due, "Past due"],
            [status.suspended, "Suspended"],
          ].map(([v, l]) => (
            <div key={l}>
              <div className="text-xl font-bold tabular-nums text-[#111827]">{v.toLocaleString("en-US")}</div>
              <div className="text-xs text-[#374151]">{l}</div>
            </div>
          ))}
        </div>
      </div>
      {kpis.map((k) => (
        <div
          key={k.label}
          className="flex min-w-0 flex-col gap-2 rounded-xl border border-t-[3px] border-[#E2E5EA] border-t-[#850019] bg-white px-[22px] py-5 shadow-[0_1px_3px_rgba(17,24,39,.07),0_1px_2px_rgba(17,24,39,.04)]"
        >
          <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[#4B5563]">{k.label}</div>
          <div className="text-[34px] font-bold leading-[1.1] tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere]" style={{ color: k.fg }}>
            {k.value}
          </div>
          <div className="text-[13px] text-[#4B5563]">{k.sub}</div>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Revenue                                                             */
/* ------------------------------------------------------------------ */

function revenueMonths(trend: RevenueBreakdownResult) {
  const currentKey = dateToKey(new Date());
  const keys = trend.rows.map((row) => row.groupKey).sort();
  const first = trend.since ? dateToKey(trend.since) : (keys[0] ?? currentKey);
  const last = [currentKey, keys.at(-1) ?? currentKey].sort().at(-1)!;
  const span = monthSpan(first < last ? first : last, last);
  const byKey = new Map(trend.rows.map((row) => [row.groupKey, row]));
  return {
    keys: span,
    collected: span.map((key) => byKey.get(key)?.collectedCents ?? 0),
    expected: span.map((key) => byKey.get(key)?.expectedCents ?? 0),
  };
}

function RevenueSection({
  data,
  cap,
  groupBy,
  mobile,
  exporting,
  onGroupBy,
  onExport,
}: {
  data: PlatformReportsResult;
  cap: string;
  groupBy: BreakdownGroupBy;
  mobile: boolean;
  exporting: boolean;
  onGroupBy: (value: BreakdownGroupBy) => void;
  onExport: () => void;
}) {
  const trend = data.revenueTrend;
  const breakdown = data.revenue;
  return (
    <section aria-labelledby="rp-rev" className={SECTION}>
      <SectionHeading id="rp-rev" title="Revenue">
        Collected is verified subscription payments, by the date received. Expected is the current plan price of each open subscription that is
        not cancelled. Amounts are summed as recorded; currencies are not converted.
      </SectionHeading>
      {!trend || !breakdown ? (
        <Restricted title="Revenue is restricted">Revenue is available to Platform Owner accounts only.</Restricted>
      ) : (
        <div className="grid grid-cols-1 items-stretch gap-6 min-[1025px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <RevenueChartCard trend={trend} cap={cap} mobile={mobile} />
          <BreakdownCard breakdown={breakdown} groupBy={groupBy} exporting={exporting} onGroupBy={onGroupBy} onExport={onExport} />
        </div>
      )}
    </section>
  );
}

function RevenueChartCard({ trend, cap, mobile }: { trend: RevenueBreakdownResult; cap: string; mobile: boolean }) {
  const months = revenueMonths(trend);
  const labels = months.keys.map(monthLabel);
  return (
    <div className={`${CARD} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className={CARD_TITLE}>Revenue by month</div>
        <div className={CARD_SUB}>{cap}</div>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-[170px] rounded-xl border border-[#E9C3CC] bg-[#F9E8EC] px-[18px] py-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-[#4B5563]">
              <span className="h-[3px] w-4 rounded-sm bg-[#850019]" />
              Collected
            </div>
            <div className="mt-1 text-[38px] font-bold leading-[1.15] tracking-[-0.02em] tabular-nums text-[#850019]">{money(trend.totals.collectedCents)}</div>
          </div>
          <div className="min-w-[170px] rounded-xl border border-dashed border-[#B5566A] bg-white px-[18px] py-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-[#4B5563]">
              <span className="h-0 w-4 border-t-2 border-dashed border-[#850019] opacity-60" />
              Expected
            </div>
            <div className="mt-1 text-[38px] font-bold leading-[1.15] tracking-[-0.02em] tabular-nums text-[#374151]">{money(trend.totals.expectedCents)}</div>
          </div>
        </div>
      </div>
      <TrendChart
        labels={labels}
        titles={labels}
        series={[months.collected, months.expected]}
        kind="line"
        isMoney
        small={false}
        mobile={mobile}
        ariaLabel={`Collected and expected revenue by month, ${cap}`}
        tip={(i) => [
          { l: "Collected", v: money(months.collected[i]) },
          { l: "Expected", v: money(months.expected[i]) },
        ]}
      />
    </div>
  );
}

function BreakdownCard({
  breakdown,
  groupBy,
  exporting,
  onGroupBy,
  onExport,
}: {
  breakdown: RevenueBreakdownResult;
  groupBy: BreakdownGroupBy;
  exporting: boolean;
  onGroupBy: (value: BreakdownGroupBy) => void;
  onExport: () => void;
}) {
  const sorted = [...breakdown.rows].sort((a, b) => b.collectedCents - a.collectedCents);
  const shown = sorted.slice(0, BREAKDOWN_ROWS);
  const max = Math.max(1, ...sorted.map((r) => r.collectedCents + r.expectedCents));
  const noun = GROUP_TITLE[breakdown.groupBy === "month" ? groupBy : (breakdown.groupBy as BreakdownGroupBy)].toLowerCase();
  return (
    <div className={`${CARD} flex flex-col gap-3.5`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className={CARD_TITLE}>Revenue breakdown</div>
        <div className={CARD_SUB}>By {noun}, largest first</div>
        <button type="button" className={`${SECONDARY_BTN} h-9`} onClick={onExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <PillGroup asTabs label="Group by" value={groupBy} options={BREAKDOWN_OPTIONS} onChange={onGroupBy} />
      <div className="flex flex-1 flex-col gap-3.5">
        {shown.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-[#6B7280]">No revenue recorded in this range.</div>
        ) : (
          shown.map((r) => (
            <div key={r.groupKey}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{groupLabel(breakdown.groupBy, r)}</span>
                <span className="whitespace-nowrap text-[13px] tabular-nums">
                  <strong className="text-[#850019]">{money2(r.collectedCents)}</strong>{" "}
                  <span className="text-[#6B7280]">/ {money2(r.expectedCents)} exp.</span>
                </span>
              </div>
              <div className="flex h-3 overflow-hidden rounded-md bg-[#F7F8FA]">
                <div className="bg-[#850019]" style={{ width: `${(r.collectedCents / max) * 100}%` }} />
                <div
                  className="rounded-r-md shadow-[inset_0_0_0_1px_#850019]"
                  style={{ width: `${(r.expectedCents / max) * 100}%`, background: r.expectedCents > 0 ? HATCH : undefined }}
                />
              </div>
            </div>
          ))
        )}
        {sorted.length > shown.length && (
          <div className="text-xs text-[#6B7280]">
            Showing the {shown.length} largest of {sorted.length}. Detailed data below lists every row.
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-[#6B7280]">
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-[3px] bg-[#850019]" />
          Collected
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-[3px] shadow-[inset_0_0_0_1px_#850019]" style={{ background: HATCH }} />
          Expected
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Academies                                                           */
/* ------------------------------------------------------------------ */

function AcademiesSection({ data, mobile }: { data: PlatformReportsResult; mobile: boolean }) {
  const trend = data.activeAcademyTrend;
  const acKeys = trend.map((p) => p.month);
  const acLabels = acKeys.map(monthLabel);
  const cumulative = trend.map((p) => p.cumulativeActive);
  const now = cumulative.at(-1) ?? 0;
  const delta = cumulative.length ? now - cumulative[0] : 0;

  const registrations = data.academyRegistrations;
  const lifecycle = data.academyLifecycle;

  return (
    <section aria-labelledby="rp-acad" className={SECTION}>
      <SectionHeading id="rp-acad" title="Academies">
        Growth over the selected range and where academies stand today.
      </SectionHeading>
      <div className="grid grid-cols-1 gap-6 min-[820px]:grid-cols-2">
        <div className={CARD}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className={CARD_TITLE}>Active academies</div>
              <div className={CARD_SUB}>Cumulative, counted from the month each was activated</div>
            </div>
            <div className="text-right">
              <div className="text-[28px] font-bold leading-[1.1] tabular-nums">{now.toLocaleString("en-US")}</div>
              <div className="text-xs text-[#6B7280]">
                {delta >= 0 ? "+" : ""}
                {delta} in range
              </div>
            </div>
          </div>
          <TrendChart
            labels={acLabels}
            titles={acLabels}
            series={[cumulative]}
            kind="line"
            isMoney={false}
            small
            mobile={mobile}
            ariaLabel={`Active academies by month, now ${now}`}
            tip={(i) => [{ l: "Active academies", v: String(cumulative[i]) }]}
          />
        </div>
        {registrations ? (
          <NewAcademiesCard registrations={registrations} mobile={mobile} />
        ) : (
          <Restricted title="New academies are restricted">Registrations per month are available to Platform Owner accounts only.</Restricted>
        )}
      </div>
      {lifecycle && (
        <div className={`${CARD} mt-6 flex flex-wrap items-center gap-x-10 gap-y-5`}>
          <div className="flex-none">
            <div className="text-xs text-[#6B7280]">Academy lifecycle</div>
            <div className="text-[44px] font-bold leading-[1.1] tabular-nums">{lifecycle.total.toLocaleString("en-US")}</div>
            <div className="text-xs text-[#6B7280]">registered academies</div>
          </div>
          <div className="grid min-w-0 flex-[1_1_320px] gap-3">
            {LIFECYCLE_ROWS.map(([key, label, bg, fg]) => (
              <BarRow key={key} label={label} bg={bg} fg={fg} n={lifecycle.byStatus[key] ?? 0} total={lifecycle.total} mobile={mobile} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function NewAcademiesCard({ registrations, mobile }: { registrations: { month: string; registered: number }[]; mobile: boolean }) {
  const labels = registrations.map((p) => monthLabel(p.month));
  const values = registrations.map((p) => p.registered);
  const sum = values.reduce((a, b) => a + b, 0);
  return (
    <div className={CARD}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className={CARD_TITLE}>New academies</div>
          <div className={CARD_SUB}>Registered per month, whatever their status today</div>
        </div>
        <div className="text-right">
          <div className="text-[28px] font-bold leading-[1.1] tabular-nums">{sum.toLocaleString("en-US")}</div>
          <div className="text-xs text-[#6B7280]">in range</div>
        </div>
      </div>
      <TrendChart
        labels={labels}
        titles={labels}
        series={[values]}
        kind="bar"
        isMoney={false}
        small
        mobile={mobile}
        ariaLabel={`New academies per month, ${sum} in range`}
        tip={(i) => [{ l: "New academies", v: String(values[i]) }]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

function SubscriptionsSection({ data, mobile, expiringCap }: { data: PlatformReportsResult; mobile: boolean; expiringCap: number }) {
  const status = data.subscriptionStatus.byStatus;
  const open = data.subscriptionStatus.openAcademies;
  const serving = status.active + status.trial + status.past_due;
  const notServing = Math.max(0, open - serving);
  const expiring = data.expiringSubscriptions;

  return (
    <section aria-labelledby="rp-sub" className={SECTION}>
      <SectionHeading id="rp-sub" title="Subscriptions">
        Today&apos;s effective status of each open academy&apos;s current subscription. Past-due and lapsed terms are worked out the same way the
        access check does, not read from the stored status.
      </SectionHeading>
      <div className="grid grid-cols-1 items-start gap-6 min-[1025px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className={CARD}>
          <div className={CARD_TITLE}>Status distribution</div>
          <div className={CARD_SUB}>{open.toLocaleString("en-US")} open academies, one current subscription each</div>
          <div className="my-4 grid grid-cols-2 gap-3">
            <div className="rounded-[10px] bg-[#F9E8EC] px-3.5 py-3">
              <div className="text-xs text-[#374151]">Serving (active, trial, past due)</div>
              <div className="text-2xl font-bold tabular-nums text-[#850019]">
                {serving.toLocaleString("en-US")} <span className="text-xs font-semibold text-[#374151]">{pct(serving, open)}</span>
              </div>
            </div>
            <div className="rounded-[10px] border border-[#E2E5EA] bg-[#F7F8FA] px-3.5 py-3">
              <div className="text-xs text-[#374151]">Not serving</div>
              <div className="text-2xl font-bold tabular-nums">
                {notServing.toLocaleString("en-US")} <span className="text-xs font-semibold text-[#374151]">{pct(notServing, open)}</span>
              </div>
            </div>
          </div>
          <div className="grid gap-2.5">
            {STATUS_ROWS.map(([key, label, bg, fg]) => (
              <BarRow key={key} label={label} bg={bg} fg={fg} n={status[key] ?? 0} total={open} mobile={mobile} />
            ))}
          </div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>Expiring within 30 days</div>
          <div className={CARD_SUB}>Active, trial and past-due subscriptions, soonest first</div>
          <ExpiringRows rows={expiring.rows} totalCount={expiring.totalCount} cap={expiringCap} />
        </div>
      </div>
    </section>
  );
}

function ExpiringRows({ rows, totalCount, cap }: { rows: ExpiringSubscriptionRow[]; totalCount: number; cap: number }) {
  const [page, setPage] = useState(0);
  if (rows.length === 0) {
    return <div className="px-2 py-8 text-center text-sm text-[#6B7280]">No subscriptions end in the next 30 days.</div>;
  }
  const pages = Math.max(1, Math.ceil(rows.length / EXPIRING_PAGE_ROWS));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * EXPIRING_PAGE_ROWS, current * EXPIRING_PAGE_ROWS + EXPIRING_PAGE_ROWS);
  return (
    <>
      <ul role="list" className="mt-2">
        {shown.map((row) => {
          const badge = expiryBadge(row.daysUntilExpiry);
          return (
            <li key={row.subscriptionId}>
              <Link
                href={`/platform/academies/${row.academyId}`}
                className="flex items-center gap-3 border-t border-[#E2E5EA] py-2.5 !text-[#111827] no-underline transition-colors duration-150 hover:bg-[#FCF5F6] hover:no-underline"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{row.academyName}</span>
                  <span className="block text-xs text-[#6B7280]">{planLabel(row.planName)}</span>
                </span>
                <span className="shrink-0">
                  <Badge label={badge.label} tone={badge.tone} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} />}
      {totalCount > rows.length && (
        <p className="mt-2 text-xs text-[#6B7280]">
          {totalCount.toLocaleString("en-US")} in total. The list shows the {cap} soonest.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

interface PlanRow {
  planId: string;
  planName: string;
  academies: number;
  collectedCents: number;
  expectedCents: number;
}

function planRows(adoption: AcademiesByPlanRow[], revenue: RevenueBreakdownResult | null): PlanRow[] {
  const byId = new Map<string, PlanRow>();
  for (const row of adoption) {
    byId.set(row.planId, { planId: row.planId, planName: row.planName, academies: row.academyCount, collectedCents: 0, expectedCents: 0 });
  }
  for (const row of revenue?.rows ?? []) {
    const entry = byId.get(row.groupKey) ?? { planId: row.groupKey, planName: row.label, academies: 0, collectedCents: 0, expectedCents: 0 };
    entry.collectedCents = row.collectedCents;
    entry.expectedCents = row.expectedCents;
    byId.set(row.groupKey, entry);
  }
  return [...byId.values()];
}

function PlansSection({ data, mobile }: { data: PlatformReportsResult; mobile: boolean }) {
  const revenue = data.revenueByPlan;
  const lock = revenue === null;
  const adoption = [...data.academiesByPlan].sort((a, b) => b.academyCount - a.academyCount || a.planName.localeCompare(b.planName));
  const totalAcademies = adoption.reduce((sum, row) => sum + row.academyCount, 0);
  const totalCollected = revenue?.totals.collectedCents ?? 0;
  const segments = adoption
    .map((row, i) => ({ key: row.planId, label: row.planName, n: row.academyCount, color: PLAN_COLORS[i % PLAN_COLORS.length] }))
    .filter((s) => s.n > 0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "expected", dir: "asc" });

  const dash = "—";
  const columns: Column<PlanRow>[] = [
    { key: "key", label: "Plan", align: "left", sortValue: (r) => r.planName.toLowerCase(), render: (r) => r.planName },
    { key: "academies", label: "Academies", align: "right", sortValue: (r) => r.academies, render: (r) => r.academies.toLocaleString("en-US") },
    { key: "adoption", label: "Adoption", align: "right", sortValue: (r) => r.academies, render: (r) => pct(r.academies, totalAcademies) },
    { key: "collected", label: "Collected", align: "right", sortValue: (r) => r.collectedCents, render: (r) => (lock ? dash : money2(r.collectedCents)), strong: true, brand: true },
    { key: "ofc", label: "Of collected", align: "right", sortValue: (r) => r.collectedCents, render: (r) => (lock ? dash : pct(r.collectedCents, totalCollected)) },
    { key: "expected", label: "Expected", align: "right", sortValue: (r) => r.expectedCents, render: (r) => (lock ? dash : money2(r.expectedCents)) },
  ];
  const rows = sortRows(planRows(adoption, revenue), columns, sort);

  return (
    <section aria-labelledby="rp-plans" className={SECTION}>
      <SectionHeading id="rp-plans" title="Plans">
        Adoption counts each open academy once, by its current plan, today. Revenue columns cover the selected range and include academies that
        have since changed plan.
      </SectionHeading>
      <div className="grid grid-cols-1 items-start gap-6 min-[1025px]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className={CARD}>
          <div className={CARD_TITLE}>Plan adoption</div>
          <div className={CARD_SUB}>Open academies by current plan</div>
          {segments.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-[#6B7280]">No open academies are on a plan yet.</div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-5">
              <Donut segments={segments} total={totalAcademies} hovered={hovered} onHover={setHovered} />
              <div className="flex min-w-0 flex-[1_1_160px] flex-col gap-2">
                {segments.map((s, i) => (
                  <div key={s.key} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} className="flex min-h-9 items-center gap-3">
                    <span className="h-3 w-3 flex-none rounded-[3px]" style={{ background: s.color }} />
                    <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{s.label}</span>
                    <span className="font-semibold tabular-nums">{s.n.toLocaleString("en-US")}</span>
                    <span className={PCT_PILL}>{pct(s.n, totalAcademies)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className={CARD}>
          <div className="mb-4">
            <div className={CARD_TITLE}>Plan performance</div>
            <div className={CARD_SUB}>
              Academies and revenue per plan.{!mobile && " Select a column to sort."}
              {lock && " Revenue columns are available to Platform Owner accounts only."}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-[#6B7280]">No plans to show.</div>
          ) : mobile ? (
            <div className="grid gap-3">
              {rows.map((r) => (
                <RowCard key={r.planId} title={r.planName} amount={lock ? dash : money2(r.collectedCents)}>
                  <div className="mt-2.5 flex items-center gap-2.5">
                    <span className="h-2 flex-1 rounded bg-[#F1F3F6]">
                      <span className="block h-2 rounded bg-[#850019]" style={{ width: pct(r.academies, totalAcademies) }} />
                    </span>
                    <span className="text-[13px] font-semibold tabular-nums">{pct(r.academies, totalAcademies)}</span>
                  </div>
                  <CardFacts>
                    <Fact label="Academies" value={r.academies.toLocaleString("en-US")} />
                    <Fact label="Of collected" value={lock ? dash : pct(r.collectedCents, totalCollected)} />
                    <Fact label="Expected" value={lock ? dash : money2(r.expectedCents)} />
                  </CardFacts>
                </RowCard>
              ))}
            </div>
          ) : (
            <SortTable
              label="Plan performance"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.planId}
              sort={sort}
              onSort={(key) => setSort(nextSort(sort, key, "key"))}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Detailed data                                                       */
/* ------------------------------------------------------------------ */

interface DetailRow {
  key: string;
  label: string;
  collectedCents: number;
  expectedCents: number;
}

function DetailSection({
  revenue,
  groupBy,
  cap,
  mobile,
  isOwner,
}: {
  revenue: RevenueBreakdownResult | null;
  groupBy: BreakdownGroupBy;
  cap: string;
  mobile: boolean;
  isOwner: boolean;
}) {
  const title = GROUP_TITLE[groupBy];
  const [sort, setSort] = useState<SortState>({ key: "c", dir: "desc" });
  const [page, setPage] = useState(0);

  const heading = (
    <SectionHeading id="rp-det" title="Detailed data">
      Every revenue row behind the breakdown above, by {title.toLowerCase()}, {cap === "All time" ? "all time" : cap}. Export CSV downloads the same
      rows.
    </SectionHeading>
  );

  if (!isOwner || !revenue) {
    return (
      <section aria-labelledby="rp-det" className="mb-6">
        {heading}
        <Restricted title="Detailed revenue is restricted">Revenue is available to Platform Owner accounts only.</Restricted>
      </section>
    );
  }

  const total = revenue.totals;
  const columns: Column<DetailRow>[] = [
    { key: "key", label: title, align: "left", sortValue: (r) => r.label.toLowerCase(), render: (r) => r.label },
    { key: "c", label: "Collected", align: "right", sortValue: (r) => r.collectedCents, render: (r) => money2(r.collectedCents), strong: true, brand: true },
    { key: "ofc", label: "Of collected", align: "right", sortValue: (r) => r.collectedCents, render: (r) => pct(r.collectedCents, total.collectedCents) },
    { key: "e", label: "Expected", align: "right", sortValue: (r) => r.expectedCents, render: (r) => money2(r.expectedCents) },
  ];
  const all = sortRows(
    revenue.rows.map((r) => ({ key: r.groupKey, label: groupLabel(revenue.groupBy, r), collectedCents: r.collectedCents, expectedCents: r.expectedCents })),
    columns,
    sort,
  );
  const pages = Math.max(1, Math.ceil(all.length / DETAIL_PAGE_ROWS));
  const current = Math.min(page, pages - 1);
  const rows = all.slice(current * DETAIL_PAGE_ROWS, current * DETAIL_PAGE_ROWS + DETAIL_PAGE_ROWS);
  const footer = ["Total", money2(total.collectedCents), all.length ? "100%" : "0%", money2(total.expectedCents)];

  return (
    <section aria-labelledby="rp-det" className="mb-6">
      {heading}
      <div className={CARD}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className={CARD_TITLE}>Revenue by {title.toLowerCase()}</div>
          <span className="whitespace-nowrap rounded-full border border-[#E2E5EA] bg-[#F7F8FA] px-3 py-[3px] text-xs font-semibold text-[#374151]">
            {all.length.toLocaleString("en-US")} {all.length === 1 ? "row" : "rows"}
          </span>
        </div>
        {all.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-[#6B7280]">No revenue recorded in this range.</div>
        ) : mobile ? (
          <div className="grid gap-3">
            {rows.map((r) => (
              <RowCard key={r.key} title={r.label} amount={money2(r.collectedCents)}>
                <CardFacts>
                  <Fact label="Of collected" value={pct(r.collectedCents, total.collectedCents)} />
                  <Fact label="Expected" value={money2(r.expectedCents)} />
                </CardFacts>
              </RowCard>
            ))}
            <RowCard total title="Total" amount={money2(total.collectedCents)}>
              <CardFacts total>
                <Fact label="Of collected" value="100%" />
                <Fact label="Expected" value={money2(total.expectedCents)} />
              </CardFacts>
            </RowCard>
          </div>
        ) : (
          <SortTable
            label={`Revenue by ${title.toLowerCase()}`}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.key}
            sort={sort}
            onSort={(key) => {
              setSort(nextSort(sort, key, "key"));
              setPage(0);
            }}
            footer={footer}
          />
        )}
        {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} />}
      </div>
    </section>
  );
}
