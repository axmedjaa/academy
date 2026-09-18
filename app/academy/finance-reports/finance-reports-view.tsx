"use client";

import { useState, useTransition } from "react";
import { getFinanceReportsAction } from "@/lib/academies/finance-reports-actions";
import type {
  AmountByCurrency,
  FinanceReportsData,
} from "@/lib/academies/finance-reports";
import { exportFinanceReportAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";

interface Props {
  initialReport: FinanceReportsData;
}

/**
 * PLAN.md Phase 4, Item 55 — client filter shell for `/academy/finance-reports`
 * (also reused verbatim by `/academy/reports`'s Finance tab).
 *
 * `branchId` is a plain text field, not a `<select>` sourced from
 * lib/academies/branches.ts's `listBranches` — see finance-reports.ts's own
 * module comment on why that would wrongly gate this filter behind a
 * different permission row (`academy.branches`) that Finance Officer, the
 * role this report matters most for, has no access to at all.
 *
 * PLAN.md Phase 5, Item 60 — the Export button below sends this view's
 * *current* filter state (not just the initial one) to
 * `exportFinanceReportAction`, so exporting after adjusting filters exports
 * exactly what's on screen, never the unfiltered report.
 */
export function FinanceReportsView({ initialReport }: Props) {
  const [report, setReport] = useState(initialReport);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isPending, startTransition] = useTransition();

  function applyFilters() {
    setError(null);
    startTransition(async () => {
      const result = await getFinanceReportsAction({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        branchId: branchId.trim() || undefined,
        status: status.trim() || undefined,
        method: (method || undefined) as "cash" | "mobile_money" | "bank_transfer" | undefined,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setReport(result.report);
    });
  }

  function resetFilters() {
    setDateFrom("");
    setDateTo("");
    setBranchId("");
    setStatus("");
    setMethod("");
    setError(null);
    startTransition(async () => {
      const result = await getFinanceReportsAction({});
      if (result.ok) setReport(result.report);
    });
  }

  function handleExport() {
    setError(null);
    setIsExporting(true);
    startTransition(async () => {
      const result = await exportFinanceReportAction(
        {
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          branchId: branchId.trim() || undefined,
          status: status.trim() || undefined,
          method: (method || undefined) as "cash" | "mobile_money" | "bank_transfer" | undefined,
        },
        "csv",
      );
      setIsExporting(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      downloadExportContent(result.content, result.filename, result.format);
    });
  }

  const nothingVisible =
    !report.studentPayments.visible && !report.income.visible && !report.expenses.visible;

  return (
    <div>
      <fieldset
        disabled={isPending}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "flex-end",
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Branch ID
          <input
            type="text"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            placeholder="(optional)"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Status
          <input
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="e.g. approved, posted"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">(any)</option>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile money</option>
            <option value="bank_transfer">Bank transfer</option>
          </select>
        </label>
        <button type="button" onClick={applyFilters}>
          Apply filters
        </button>
        <button type="button" onClick={resetFilters}>
          Reset
        </button>
        <button type="button" onClick={handleExport} disabled={isExporting}>
          {isExporting ? "Exporting..." : "Export CSV"}
        </button>
      </fieldset>

      {error && <p style={{ color: "#b00020" }}>{error}</p>}

      {nothingVisible && (
        <p style={{ color: "#666" }}>
          Your role has no view rights on any finance section, so there is nothing to show here.
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
        {report.studentPayments.visible && (
          <>
            <SummaryCard title="Outstanding charges" data={report.studentPayments.outstandingCharges} />
            <SummaryCard title="Payments received" data={report.studentPayments.paymentsReceived} />
            <CountCard
              title="Pending payment approvals"
              count={report.studentPayments.pendingApprovalsCount}
            />
          </>
        )}
        {report.income.visible && <SummaryCard title="Income" data={report.income} />}
        {report.expenses.visible && (
          <>
            <SummaryCard title="Expenses" data={report.expenses} />
            <CountCard title="Pending expense approvals" count={report.expenses.pendingApprovalsCount} />
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  data,
}: {
  title: string;
  data: { count: number; totalsByCurrency: AmountByCurrency[] };
}) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem" }}>
      <h3 style={{ margin: "0 0 0.5rem" }}>{title}</h3>
      <p style={{ margin: 0, color: "#666" }}>{data.count} record(s)</p>
      {data.totalsByCurrency.length === 0 ? (
        <p style={{ margin: "0.5rem 0 0" }}>No amounts in the selected period.</p>
      ) : (
        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
          {data.totalsByCurrency.map((row) => (
            <li key={row.currency}>
              {(row.amountCents / 100).toFixed(2)} {row.currency} ({row.count})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CountCard({ title, count }: { title: string; count: number }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem" }}>
      <h3 style={{ margin: "0 0 0.5rem" }}>{title}</h3>
      <p style={{ margin: 0, fontSize: "1.5rem" }}>{count}</p>
    </div>
  );
}
