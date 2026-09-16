"use client";

import { useState, useTransition, type CSSProperties } from "react";
import {
  exportRevenueReportCsvAction,
  getPlatformReportsAction,
} from "@/lib/subscriptions/reports-actions";
import type { PlatformReportsResult, RevenueGroupBy } from "@/lib/subscriptions/reports";

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {error && <p style={{ color: "#c0392b" }}>{error}</p>}

      <section>
        <h2>Active-academy trend</h2>
        <p style={{ color: "#888", fontSize: "0.8rem" }}>
          Monthly count of academies whose subscription was activated that
          month, and the cumulative total of today&apos;s active academies
          activated by that point — see lib/subscriptions/reports.ts for why
          this (rather than a true historical snapshot) is the derivation.
        </p>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>Month</th>
              <th style={thStyle}>Newly activated</th>
              <th style={thStyle}>Cumulative active</th>
            </tr>
          </thead>
          <tbody>
            {data.activeAcademyTrend.map((point) => (
              <tr key={point.month}>
                <td style={tdStyle}>{point.month}</td>
                <td style={tdStyle}>{point.newlyActivated}</td>
                <td style={tdStyle}>{point.cumulativeActive}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Expiring subscriptions</h2>
        {data.expiringSubscriptions.length === 0 ? (
          <p>No subscriptions expiring soon.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={thStyle}>Academy</th>
                <th style={thStyle}>Plan</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Ends at</th>
                <th style={thStyle}>Days until expiry</th>
              </tr>
            </thead>
            <tbody>
              {data.expiringSubscriptions.map((row) => (
                <tr key={row.subscriptionId}>
                  <td style={tdStyle}>{row.academyName}</td>
                  <td style={tdStyle}>{row.planName}</td>
                  <td style={tdStyle}>{row.status}</td>
                  {/* endsAt crosses the server->client boundary as a
                      serialized string despite its Date type (same as
                      usage-manager.tsx's calculatedAt) — re-wrap before
                      formatting. */}
                  <td style={tdStyle}>{new Date(row.endsAt).toLocaleDateString()}</td>
                  <td style={{ ...tdStyle, color: row.daysUntilExpiry < 0 ? "#c0392b" : "#333" }}>
                    {row.daysUntilExpiry < 0
                      ? `${Math.abs(row.daysUntilExpiry)} days overdue`
                      : `${row.daysUntilExpiry} days`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Entirely absent (not greyed out, not a teaser) when the actor
          lacks platform.revenue.view — data.revenue is null in that case,
          so there is nothing here to conditionally disable. */}
      {data.revenue && (
        <section>
          <h2>Revenue</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem" }}>
            <label>
              Group by{" "}
              <select
                value={groupBy}
                disabled={isPending}
                onChange={(e) => handleGroupByChange(e.target.value as RevenueGroupBy)}
              >
                {REVENUE_GROUP_BY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {GROUP_BY_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={handleExport} disabled={isExporting}>
              {isExporting ? "Exporting..." : "Export CSV"}
            </button>
          </div>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={thStyle}>{GROUP_BY_LABELS[data.revenue.groupBy]}</th>
                <th style={thStyle}>Collected</th>
                <th style={thStyle}>Expected / Pending</th>
              </tr>
            </thead>
            <tbody>
              {data.revenue.rows.map((row) => (
                <tr key={row.groupKey}>
                  <td style={tdStyle}>{row.label}</td>
                  <td style={tdStyle}>{formatCents(row.collectedCents)}</td>
                  <td style={tdStyle}>{formatCents(row.expectedCents)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...tdStyle, fontWeight: "bold" }}>Total</td>
                <td style={{ ...tdStyle, fontWeight: "bold" }}>
                  {formatCents(data.revenue.totals.collectedCents)}
                </td>
                <td style={{ ...tdStyle, fontWeight: "bold" }}>
                  {formatCents(data.revenue.totals.expectedCents)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid #ddd",
  padding: "0.4rem 0.6rem",
  fontSize: "0.85rem",
};

const tdStyle: CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "0.4rem 0.6rem",
  fontSize: "0.9rem",
};
