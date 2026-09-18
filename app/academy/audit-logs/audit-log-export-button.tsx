"use client";

import { useState, useTransition } from "react";
import { exportAuditLogAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";

/**
 * PLAN.md Phase 5, Item 60 — Export button for `/academy/audit-logs`.
 *
 * A small client island next to the server-rendered, GET-query-param-driven
 * table (this page's own module comment) — the filters currently reflected
 * in the URL are passed down as a plain prop so the export always matches
 * what's on screen, never an unfiltered dump of the whole academy's log.
 */
export function AuditLogExportButton({
  filters,
}: {
  filters: {
    actorRole?: string;
    action?: string;
    branchId?: string;
    result?: string;
    createdFrom?: string;
    createdTo?: string;
  };
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    startTransition(async () => {
      const result = await exportAuditLogAction(filters, "csv");
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
