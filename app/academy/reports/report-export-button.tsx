"use client";

import { useState, useTransition } from "react";
import {
  exportAcademicReportAction,
  exportStudentReportAction,
} from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";

/**
 * PLAN.md Phase 5, Item 60 — Export button for `/academy/reports`'
 * Student and Academic tabs (the Finance tab gets its own export button for
 * free: it renders `FinanceReportsView`, which now has one built in — see
 * that component's own module comment).
 *
 * A small client island next to each server-rendered tab body, same
 * "GET-query-param page, one client button" shape this hub's own module
 * comment describes for its filter forms — this button sends the SAME
 * filters currently reflected in the URL (passed down as a plain prop from
 * the server-rendered tab) to the matching `exportData` action, so the
 * export always matches what's on screen.
 */
export function ReportExportButton({
  kind,
  filters,
}: {
  kind: "student" | "academic";
  filters: Record<string, string | undefined>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    startTransition(async () => {
      const action = kind === "student" ? exportStudentReportAction : exportAcademicReportAction;
      const result = await action(filters, "csv");
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      downloadExportContent(result.content, result.filename, result.format);
    });
  }

  return (
    <div style={{ margin: "0.75rem 0" }}>
      {error && (
        <p role="alert" style={{ color: "#b00020", fontSize: "0.85rem" }}>
          {error}
        </p>
      )}
      <button type="button" onClick={handleExport} disabled={isPending}>
        {isPending ? "Exporting..." : "Export CSV"}
      </button>
    </div>
  );
}
