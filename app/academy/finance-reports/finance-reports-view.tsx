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
import { BarChart, type ChartPoint, type ChartSeries } from "@/app/academy/_shell/charts";
import { color } from "@/lib/ui/theme";

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
        {/* Mobile-first: fields stack full-width on a narrow phone (a
         * 150-180px min-width field left a wide blank gap to its right at
         * that size), reverting to the original fixed widths in a row once
         * there's room at `sm:`. Actions do the same — one full-width
         * button per row on mobile, inline on `sm:` and up. */}
        <fieldset disabled={isPending} className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Field label="From" className="w-full sm:w-auto sm:min-w-[150px]">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
          </Field>
          <Field label="To" className="w-full sm:w-auto sm:min-w-[150px]">
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Branch id" className="w-full sm:w-auto sm:min-w-[180px]">
            <input
              type="text"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              placeholder="(optional)"
              className={inputClass}
            />
          </Field>
          <Field label="Status" className="w-full sm:w-auto sm:min-w-[160px]">
            <input
              type="text"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="e.g. approved, posted"
              className={inputClass}
            />
          </Field>
          <Field label="Method" className="w-full sm:w-auto sm:min-w-[160px]">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
              <option value="">(any)</option>
              <option value="cash">Cash</option>
              <option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </Field>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={applyFilters}>
              Apply filters
            </Button>
            <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={resetFilters}>
              Reset
            </Button>
            <Button type="button" className="w-full sm:w-auto" onClick={handleExport} disabled={isExporting}>
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

      {(report.income.visible || report.expenses.visible) && (
        <IncomeExpenseChart
          income={report.income.visible ? report.income : null}
          expenses={report.expenses.visible ? report.expenses : null}
        />
      )}
    </div>
  );
}

/**
 * DESIGN.md §9.6's "income vs. expenses... simple chart" — genuinely
 * aggregate data already computed by `getFinanceReports` (per-currency
 * totals), never a second query. Renders a single series when the caller's
 * role can only see one side (e.g. Finance Officer has no Income access at
 * all — §5) rather than silently treating the missing side as zero income
 * or zero expenses, which would misrepresent a role-visibility gap as a
 * real financial fact.
 */
function IncomeExpenseChart({
  income,
  expenses,
}: {
  income: { count: number; totalsByCurrency: AmountByCurrency[] } | null;
  expenses: { count: number; totalsByCurrency: AmountByCurrency[] } | null;
}) {
  const currencies = [
    ...new Set([
      ...(income?.totalsByCurrency.map((row) => row.currency) ?? []),
      ...(expenses?.totalsByCurrency.map((row) => row.currency) ?? []),
    ]),
  ];

  const series: ChartSeries[] = [
    ...(income ? [{ name: "Income", color: color.primaryBlue }] : []),
    ...(expenses ? [{ name: "Expenses", color: color.primaryNavy }] : []),
  ];

  const groups = currencies.map((currency) => {
    const incomeAmount = income?.totalsByCurrency.find((row) => row.currency === currency)?.amountCents ?? 0;
    const expenseAmount = expenses?.totalsByCurrency.find((row) => row.currency === currency)?.amountCents ?? 0;
    const values: ChartPoint[] = [
      ...(income ? [{ label: "Income", value: incomeAmount, display: formatMoney(incomeAmount, currency) }] : []),
      ...(expenses
        ? [{ label: "Expenses", value: expenseAmount, display: formatMoney(expenseAmount, currency) }]
        : []),
    ];
    return { label: currency, values };
  });

  return (
    <Section>
      <h3 className="mb-3 text-sm font-semibold text-ink">{income && expenses ? "Income vs. expenses" : income ? "Income" : "Expenses"}</h3>
      <BarChart
        id="income-vs-expenses"
        series={series}
        groups={groups}
        ariaLabel="Income versus expenses by currency"
        emptyMessage="No amounts in the selected period."
        // `value` above is in CENTS (so bars for different amounts scale
        // correctly against each other) — the axis-scale label must convert
        // back to real money, or it shows a confusing bare four-digit cents
        // figure (e.g. "2000" for $20.00). Formatted against the first
        // currency present, since the axis is shared across every group.
        formatAxisValue={(value) => formatMoney(value, currencies[0] ?? "USD")}
      />
    </Section>
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
