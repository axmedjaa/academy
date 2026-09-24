"use client";

import { useState, useTransition } from "react";
import { exportAuditLogAction } from "@/lib/export/export-data-actions";
import { downloadExportContent } from "@/lib/export/download-file";
import { Button, ErrorMessage } from "@/app/academy/_shell/ui";

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
    <div className="flex flex-col gap-2">
      {error && <ErrorMessage message={error} />}
      <Button type="button" variant="secondary" className="self-start" onClick={handleExport} disabled={isPending}>
        {isPending ? "Exporting..." : "Export CSV"}
      </Button>
    </div>
  );
}
