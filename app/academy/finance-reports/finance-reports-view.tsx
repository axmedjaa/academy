"use client";

import { useState, useTransition } from "react";
import { getFinanceReportsAction } from "@/lib/academies/finance-reports-actions";
import type {
  AmountByCurrency,
  FinanceReportsData,
} from "@/lib/academies/finance-reports";
import { exportFinanceReportAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";
import { Button, ErrorMessage, Field, Section, inputClass } from "@/app/academy/_shell/ui";

interface Props {
  initialReport: FinanceReportsData;
}

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
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
 *
 * UI-quality pass (this wave): restyled onto the shared Tailwind shell
 * (Section/Field/Button) — no business logic changed, same filter state,
 * same export call. Deliberately owns its own top-level `Section`/spacing
 * rather than assuming a parent wrapper, since this component is embedded
 * two different ways (its own page, and a tab inside /academy/reports).
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
    <div className="flex flex-col gap-6">
      <Section>
        <fieldset disabled={isPending} className="flex flex-wrap items-end gap-3">
          <Field label="From" className="min-w-[150px]">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
          </Field>
          <Field label="To" className="min-w-[150px]">
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Branch id" className="min-w-[180px]">
            <input
              type="text"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              placeholder="(optional)"
              className={inputClass}
            />
          </Field>
          <Field label="Status" className="min-w-[160px]">
            <input
              type="text"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="e.g. approved, posted"
              className={inputClass}
            />
          </Field>
          <Field label="Method" className="min-w-[160px]">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
              <option value="">(any)</option>
              <option value="cash">Cash</option>
              <option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={applyFilters}>
              Apply filters
            </Button>
            <Button type="button" variant="secondary" onClick={resetFilters}>
              Reset
            </Button>
            <Button type="button" onClick={handleExport} disabled={isExporting}>
              {isExporting ? "Exporting..." : "Export CSV"}
            </Button>
          </div>
        </fieldset>
      </Section>

      {error && <ErrorMessage message={error} />}

      {nothingVisible && (
        <Section>
          <p className="text-sm text-muted">
            Your role has no view rights on any finance section, so there is nothing to show here.
          </p>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
    <Section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="text-xs text-muted">
        {data.count} record{data.count === 1 ? "" : "s"}
      </p>
      {data.totalsByCurrency.length === 0 ? (
        <p className="text-sm text-muted">No amounts in the selected period.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.totalsByCurrency.map((row) => (
            <li key={row.currency} className="flex items-baseline justify-between text-sm text-ink">
              <span className="font-semibold">{formatMoney(row.amountCents, row.currency)}</span>
              <span className="text-xs text-muted">{row.count} record{row.count === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CountCard({ title, count }: { title: string; count: number }) {
  return (
    <Section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="text-2xl font-bold text-ink">{count}</p>
    </Section>
  );
}
