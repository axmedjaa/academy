"use client";

import { useTransition } from "react";
import { exportPlatformAuditLogs } from "@/lib/audit-query-actions";
import type { AuditLogFilters } from "@/lib/audit-query";
import { downloadExportContent } from "@/lib/export/download-file";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast } from "@/lib/ui/toast";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";

/** Export CSV for the Platform audit log: every row matching the filters
 * currently in the URL, so the file always matches what is on screen. */
export function PlatformAuditExportButton({ filters }: { filters: AuditLogFilters }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className={`${ROW_BTN} h-11 px-4`}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await exportPlatformAuditLogs(filters);
            if (!result.ok) {
              showErrorToast(result.error.message);
              return;
            }
            downloadExportContent(result.csv, result.filename, "csv");
          } catch {
            showErrorToast(NETWORK_ERROR_MESSAGE);
          }
        })
      }
    >
      {pending ? "Exporting…" : "Export CSV"}
    </button>
  );
}
