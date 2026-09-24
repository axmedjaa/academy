"use client";

import { useState, useTransition } from "react";
import {
  exportRevenueReportCsvAction,
  getPlatformReportsAction,
} from "@/lib/subscriptions/reports-actions";
import type { PlatformReportsResult, RevenueGroupBy } from "@/lib/subscriptions/reports";
import { Button, ErrorMessage, Field, Section, StatCard, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

interface Props {
  initialData: PlatformReportsResult;
}

// Kept as a local, type-only-backed constant rather than importing the
// value REVENUE_GROUP_BY_OPTIONS from lib/subscriptions/reports.ts: that
// module also imports the server-only `db` client, so a value import here
// (a "use client" component) would pull that into the browser bundle — same
// convention as app/platform/usage/usage-manager.tsx's local RESOURCE_LABELS
// (type-only imports from lib/subscriptions/usage.ts, no value imports).
const REVENUE_GROUP_BY_OPTIONS: readonly RevenueGroupBy[] = ["month", "plan", "academy", "method"];

const GROUP_BY_LABELS: Record<RevenueGroupBy, string> = {
  month: "Month",
  plan: "Plan",
  academy: "Academy",
  method: "Method",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Downloads a string as a file client-side — no server storage, no new
// route, matching the "no new infrastructure" export mechanism documented
// in lib/subscriptions/reports.ts.
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

export function ReportsManager({ initialData }: Props) {
  const [data, setData] = useState(initialData);
  const [groupBy, setGroupBy] = useState<RevenueGroupBy>(initialData.revenue?.groupBy ?? "month");
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleGroupByChange(nextGroupBy: RevenueGroupBy) {
    setGroupBy(nextGroupBy);
    setError(null);
    startTransition(async () => {
      const result = await getPlatformReportsAction({ groupBy: nextGroupBy });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setData(result.data);
    });
  }

  function handleExport() {
    setError(null);
    setIsExporting(true);
    startTransition(async () => {
      const result = await exportRevenueReportCsvAction(groupBy);
      setIsExporting(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      downloadCsv(result.csv, `platform-revenue-${groupBy}.csv`);
    });
  }

  const latestTrendPoint = data.activeAcademyTrend[data.activeAcademyTrend.length - 1];

  return (
    <div className="flex flex-col gap-8">
      {error && <ErrorMessage message={error} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Active academies"
          value={latestTrendPoint ? latestTrendPoint.cumulativeActive : 0}
          hint={latestTrendPoint ? `as of ${latestTrendPoint.month}` : undefined}
        />
        <StatCard label="Subscriptions expiring soon" value={data.expiringSubscriptions.length} />
        {data.revenue && (
          <StatCard label="Total collected" value={formatCents(data.revenue.totals.collectedCents)} hint={data.revenue.groupBy === "month" ? undefined : `grouped by ${GROUP_BY_LABELS[data.revenue.groupBy].toLowerCase()}`} />
        )}
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold text-ink">Active-academy trend</h2>
        <p className="mb-3 text-sm text-muted">
          Monthly count of academies whose subscription was activated that
          month, and the cumulative total of today&apos;s active academies
          activated by that point — see lib/subscriptions/reports.ts for why
          this (rather than a true historical snapshot) is the derivation.
        </p>
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Month</th>
              <th className={th}>Newly activated</th>
              <th className={th}>Cumulative active</th>
            </tr>
          </thead>
          <tbody>
            {data.activeAcademyTrend.map((point) => (
              <tr key={point.month} className={trHover}>
                <td className={td}>{point.month}</td>
                <td className={td}>{point.newlyActivated}</td>
                <td className={td}>{point.cumulativeActive}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink">Expiring subscriptions</h2>
        {data.expiringSubscriptions.length === 0 ? (
          <Section>
            <p className="text-sm text-muted">No subscriptions expiring soon.</p>
          </Section>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Academy</th>
                <th className={th}>Plan</th>
                <th className={th}>Status</th>
                <th className={th}>Ends at</th>
                <th className={th}>Days until expiry</th>
              </tr>
            </thead>
            <tbody>
              {data.expiringSubscriptions.map((row) => (
                <tr key={row.subscriptionId} className={trHover}>
                  <td className={`${td} font-medium`}>{row.academyName}</td>
                  <td className={td}>{row.planName}</td>
                  <td className={td}>{row.status}</td>
                  {/* endsAt crosses the server->client boundary as a
                      serialized string despite its Date type (same as
                      usage-manager.tsx's calculatedAt) — re-wrap before
                      formatting. */}
                  <td className={td}>{new Date(row.endsAt).toLocaleDateString()}</td>
                  <td className={`${td} ${row.daysUntilExpiry < 0 ? "font-medium text-danger" : ""}`}>
                    {row.daysUntilExpiry < 0
                      ? `${Math.abs(row.daysUntilExpiry)} days overdue`
                      : `${row.daysUntilExpiry} days`}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      {/* Entirely absent (not greyed out, not a teaser) when the actor
          lacks platform.revenue.view — data.revenue is null in that case,
          so there is nothing here to conditionally disable. */}
      {data.revenue && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-ink">Revenue</h2>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Group by" className="min-w-[160px]">
              <select
                value={groupBy}
                disabled={isPending}
                onChange={(e) => handleGroupByChange(e.target.value as RevenueGroupBy)}
                className={inputClass}
              >
                {REVENUE_GROUP_BY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {GROUP_BY_LABELS[option]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="button" variant="secondary" onClick={handleExport} disabled={isExporting}>
              {isExporting ? "Exporting..." : "Export CSV"}
            </Button>
          </div>

          <TableWrap>
            <thead>
              <tr>
                <th className={th}>{GROUP_BY_LABELS[data.revenue.groupBy]}</th>
                <th className={th}>Collected</th>
                <th className={th}>Expected / Pending</th>
              </tr>
            </thead>
            <tbody>
              {data.revenue.rows.map((row) => (
                <tr key={row.groupKey} className={trHover}>
                  <td className={td}>{row.label}</td>
                  <td className={td}>{formatCents(row.collectedCents)}</td>
                  <td className={td}>{formatCents(row.expectedCents)}</td>
                </tr>
              ))}
              <tr>
                <td className={`${td} font-bold`}>Total</td>
                <td className={`${td} font-bold`}>{formatCents(data.revenue.totals.collectedCents)}</td>
                <td className={`${td} font-bold`}>{formatCents(data.revenue.totals.expectedCents)}</td>
              </tr>
            </tbody>
          </TableWrap>
        </div>
      )}
    </div>
  );
}
